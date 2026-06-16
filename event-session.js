// --- event session lifecycle ---
// One host-controlled event gates all guest participation. With no open event,
// guests see a friendly closed room and cannot mutate any state. The event
// carries only identity/title/status/dates — the live phase stays in `mode`
// (its single source of truth) and is surfaced as `phase` in the payload.
//
// This module OWNS the `event` / `eventsArchive` state. routes.js (the top
// consumer) requires it directly, but the LOWER modules — state/sse-hub/mpv/
// research — reach it only through state.js's late-bound `hooks` (currentEventId
// / getEvent / getEventsArchive / publicEvent), wired by server.js's composition
// root. That asymmetry is what keeps the require graph acyclic: this file may
// require those lower modules because none of them statically requires it back.
const crypto = require('crypto');
const { AUDIO_ENABLED } = require('./config');
const {
  room,
  identities,
  queue,
  playHistory,
  reports,
  lastPlayedRequesterByVotes,
  cleanText,
  clearTimer,
  clearAnnouncement,
  savePersistentState,
} = require('./state');
const { broadcast } = require('./sse-hub');
const { mpvSend } = require('./mpv');
const { archiveSpotlight } = require('./research');

// Closed set of event states — a frozen constant so the room's state machine
// can't be driven by a stray string literal typo.
const EVENT_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

let event = null;
const eventsArchive = [];

function normalizeEvent(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    title: cleanText(value.title, 100) || 'Imagineering Meetup',
    status: value.status === EVENT_STATUS.OPEN ? EVENT_STATUS.OPEN : EVENT_STATUS.CLOSED,
    openedAt: Number(value.openedAt) || null,
    closedAt: Number(value.closedAt) || null,
  };
}

// Hydrate event state from the persisted blob (loaded once by state.js) and run
// the predates-the-event-model migration. Called by server.js at boot AFTER
// loadPersistentState() has populated the shared state containers.
function init(savedState) {
  event = normalizeEvent(savedState.event);
  if (Array.isArray(savedState.eventsArchive)) {
    for (const e of savedState.eventsArchive.map(normalizeEvent).filter(Boolean)) eventsArchive.push(e);
  }
  // Migration: a deployment that predates the event model but has live
  // participants keeps running uninterrupted — wrap its state in an open event
  // rather than locking the room the instant this code ships. Fresh installs
  // (no identities, no queue) start closed: the host opens the first event.
  if (!event && (identities.size > 0 || queue.length > 0)) {
    const migratedId = crypto.randomBytes(6).toString('hex');
    event = { id: migratedId, title: 'Imagineering Meetup', status: EVENT_STATUS.OPEN, openedAt: Date.now(), closedAt: null };
    // Identities carry an eventIds *array*: a participant may attend many events,
    // so attendance is many-to-many, not a single bolted-on id.
    for (const identity of identities.values()) if (!Array.isArray(identity.eventIds)) identity.eventIds = [migratedId];
    for (const track of queue) if (!track.eventId) track.eventId = migratedId;
    for (const entry of playHistory) if (!entry.eventId) entry.eventId = migratedId;
    for (const report of reports) if (!report.eventId) report.eventId = migratedId;
  }
}

function isEventOpen() {
  return !!(event && event.status === EVENT_STATUS.OPEN);
}

// The id of the event new participation should be tagged with, or null when no
// event is open (which is also the signal that guest routes must be rejected).
function currentEventId() {
  return isEventOpen() ? event.id : null;
}

function getEvent() {
  return event;
}

function getEventsArchive() {
  return eventsArchive;
}

// Record that an identity participated in the currently open event. Attendance
// is many-to-many (a returning guest, whose token skips /api/join, attends
// several events), so we append to an eventIds array rather than overwriting a
// single id — otherwise returning guests stay bolted to their first event and
// vanish from later events' recaps ("ghost attendees").
function markAttendance(id) {
  const eventId = currentEventId();
  if (!eventId || !id) return;
  if (!Array.isArray(id.eventIds)) id.eventIds = [];
  if (!id.eventIds.includes(eventId)) id.eventIds.push(eventId);
}

// What every surface sees about the event. Phase is read from `mode` (its
// single source of truth), never stored twice.
function publicEvent() {
  if (!event) return null;
  return {
    id: event.id,
    title: event.title,
    status: event.status,
    phase: room.mode,
    openedAt: event.openedAt,
    closedAt: event.closedAt,
  };
}

function stopPlayback() {
  room.nowPlaying = null;
  if (AUDIO_ENABLED) mpvSend(['stop']).catch(() => {});
}

function archiveCurrentEvent() {
  if (!event) return;
  const closed = { ...event, status: EVENT_STATUS.CLOSED, closedAt: event.closedAt || Date.now() };
  const existing = eventsArchive.findIndex(e => e.id === closed.id);
  if (existing >= 0) eventsArchive[existing] = closed;
  else eventsArchive.unshift(closed);
  eventsArchive.length = Math.min(eventsArchive.length, 100);
}

// Open a fresh meetup. Clears the pending show (queue/playback/timer/announce/
// spotlight) for a clean slate but keeps eventId-tagged history and reports so
// past events stay reviewable. Callers ensure no event is currently open.
function openEvent(title) {
  stopPlayback();
  queue.splice(0, queue.length);
  // Reset the fair-rotation cursor too, so a fresh meetup doesn't inherit the
  // previous event's requester-ordering pointer (which references dead tokens).
  for (const key of Object.keys(lastPlayedRequesterByVotes)) delete lastPlayedRequesterByVotes[key];
  if (room.spotlight) { archiveSpotlight(); room.spotlight = null; }
  clearTimer();
  clearAnnouncement();
  room.mode = 'welcome';
  event = {
    id: crypto.randomBytes(6).toString('hex'),
    title: cleanText(title, 100) || 'Imagineering Meetup',
    status: EVENT_STATUS.OPEN,
    openedAt: Date.now(),
    closedAt: null,
  };
  savePersistentState();
  broadcast();
  return publicEvent();
}

// Close the open event: stop the show and archive the event so its output stays
// reviewable. Guests immediately see the friendly closed state.
function closeEvent() {
  if (!event) return null;
  stopPlayback();
  // Clear the queue so a closed room actually goes quiet: stopPlayback's mpv
  // `stop` triggers the idle observer → playNext, which would otherwise play
  // the next queued track in a room that's supposed to be resting.
  queue.splice(0, queue.length);
  if (room.spotlight) { archiveSpotlight(); room.spotlight = null; }
  clearTimer();
  clearAnnouncement();
  event = { ...event, status: EVENT_STATUS.CLOSED, closedAt: Date.now() };
  archiveCurrentEvent();
  savePersistentState();
  broadcast();
  return publicEvent();
}

module.exports = {
  EVENT_STATUS,
  init,
  isEventOpen,
  currentEventId,
  getEvent,
  getEventsArchive,
  markAttendance,
  publicEvent,
  openEvent,
  closeEvent,
};
