// --- state ---
// The mutable-state nexus for the whole server. This module OWNS every shared
// mutable global and is required by everyone (mpv, sse-hub, research, routes).
//
// Two export mechanisms, matched to mutation style:
//
//   (A) REFERENCE-STABLE CONTAINERS — `identities`, `queue`, `playHistory`,
//       `reports`, `lastPlayedRequesterByVotes`, `sseClients`, `gestureTimes`.
//       Every mutation in the codebase is IN-PLACE (`.set`/`.push`/`.splice`/
//       `.unshift`; sortQueue uses `queue.splice(0, queue.length, ...ranked)`,
//       never `queue = ...`). The binding never changes, so they're exported as
//       bare `const` references and importers mutate the live object directly.
//
//   (B) REASSIGNED SCALARS — `nowPlaying`, `timer`, `mode`, `announcement`,
//       `visuals`, `visualEvent`, `spotlight`. These ARE reassigned, so a bare
//       `let` export would go stale in importers the instant it's reassigned.
//       They live as FIELDS on the single exported `room` holder and are only
//       ever reassigned as `room.x = ...`. Importers always read `room.x` fresh.
//
//   (C) BROADCAST / PLAYNEXT / EVENT CALLBACK CYCLE — state functions need to
//       call `broadcast()` (sse-hub), `playNext()` (mpv), and the event-session
//       accessors (`currentEventId`/`event`/`eventsArchive`, still in server.js
//       pending a later carve). A static require either direction is a cycle.
//       Instead state exports a mutable `hooks` object that the composition root
//       (server.js) wires with the real implementations after all requires.
//
// `timerTimeout`/`announcementTimeout` stay module-PRIVATE — never read across
// modules, only created/cleared internally.

const crypto = require('crypto');
const fs = require('fs');

const {
  STATE_FILE,
  HISTORY_LIMIT,
  REPORT_LIMIT,
  SHOW_MODES,
  VISUAL_THEMES,
} = require('./config');

const { generateName, colorForName } = require('./names');

// Late-bound cross-module callbacks (see header note C). The composition root
// calls wireHooks() once every module is loaded; until then they are inert.
const hooks = {
  broadcast: () => {},
  playNext: () => {},
  currentEventId: () => null,
  getEvent: () => null,
  getEventsArchive: () => [],
  publicEvent: () => null,
};

// Guard against the silent-data-loss footgun: savePersistentState() serializes
// event/eventsArchive THROUGH hooks.getEvent()/getEventsArchive(). If a save
// fires before the composition root wires them, the inert defaults return
// null/[] and we'd persist `event:null` over a real open event. wireHooks()
// flips this flag; savePersistentState() refuses to run until it does. There is
// no legitimate save before wiring (loads/migration don't save; every save is
// request-time), so this only ever catches a genuine wiring bug.
let hooksWired = false;
function wireHooks(impl) {
  Object.assign(hooks, impl);
  hooksWired = true;
}

function loadPersistentState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('state load failed', err.message);
    return {};
  }
}

const savedState = loadPersistentState();
const savedIdentities = Array.isArray(savedState.identities)
  ? savedState.identities.filter(item => Array.isArray(item) && item.length === 2)
  : [];
const identities = new Map(savedIdentities); // token -> { name, color, mintedAt }
const playHistory = Array.isArray(savedState.playHistory)
  ? savedState.playHistory.slice(0, HISTORY_LIMIT)
  : [];
const reports = Array.isArray(savedState.reports)
  ? savedState.reports.slice(0, REPORT_LIMIT)
  : [];
const queue = Array.isArray(savedState.queue)
  ? savedState.queue.filter(track => track && typeof track.id === 'string')
  : [];                       // [{ id, requesterToken, requesterName, color, videoId, title, thumbnail, addedAt, voterTokens }]
const lastPlayedRequesterByVotes = savedState.lastPlayedRequesterByVotes &&
  typeof savedState.lastPlayedRequesterByVotes === 'object'
  ? { ...savedState.lastPlayedRequesterByVotes }
  : { 0: savedState.lastPlayedRequesterToken || null };
const sseClients = new Set(); // { res, includeSpotlight } stream clients
const gestureTimes = new Map();

// Reassigned scalars live on this single holder (see header note B).
const room = {
  nowPlaying: null,           // { ...trackEntry } | null
  timer: savedState.timer && typeof savedState.timer === 'object' ? savedState.timer : null,
  mode: SHOW_MODES.has(savedState.mode) ? savedState.mode : 'free-jukebox',
  announcement: null,         // { id, title, message, detail, createdAt, expiresAt, color } | null
  visuals: normalizeVisuals(savedState.visuals),
  visualEvent: null,          // short-lived phone gesture effect; never persisted
  spotlight: null,            // consented live speech transcript; archived only when explicitly ended
};

// Module-private timeout handles (see header note about privacy).
let timerTimeout = null;
let announcementTimeout = null;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeGithubHandle(value) {
  const handle = cleanText(value, 39).replace(/^@/, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(handle) ? handle : '';
}

function identityDisplayName(id) {
  const handle = normalizeGithubHandle(id?.githubHandle);
  return handle ? `@${handle}` : cleanText(id?.name, 60);
}

function normalizeVisuals(value) {
  const data = value && typeof value === 'object' ? value : {};
  return {
    theme: VISUAL_THEMES.has(data.theme) ? data.theme : 'aurora',
    energy: clamp(data.energy, 0, 1, 0.56),
    complexity: clamp(data.complexity, 0, 1, 0.62),
    hue: Math.round(clamp(data.hue, 0, 360, 212)),
    editedBy: cleanText(data.editedBy, 60),
    editedAt: Number(data.editedAt) || null,
  };
}

function savePersistentState() {
  // Fail loud, not silent: persisting before hooks are wired would write
  // event:null over a real event (see wireHooks above).
  if (!hooksWired) {
    throw new Error('savePersistentState() before state.wireHooks(): event/eventsArchive would persist as null. Wire hooks in the composition root before any save.');
  }
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  const data = JSON.stringify({
    identities: Array.from(identities.entries()),
    playHistory,
    queue,
    lastPlayedRequesterByVotes,
    timer: room.timer,
    mode: room.mode,
    visuals: room.visuals,
    reports,
    event: hooks.getEvent(),
    eventsArchive: hooks.getEventsArchive(),
  }, null, 2);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('state save failed', err.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function createIdentity() {
  const token = crypto.randomBytes(16).toString('hex');
  const name = generateName();
  const color = colorForName(name);
  const eventId = hooks.currentEventId();
  identities.set(token, { name, color, mintedAt: Date.now(), eventIds: eventId ? [eventId] : [] });
  savePersistentState();
  return { token, name, color };
}

function markTimerEnded() {
  if (!room.timer || room.timer.status !== 'running') return;
  room.timer = { ...room.timer, status: 'ended', endedAt: Date.now() };
  savePersistentState();
}

function currentTimer() {
  if (room.timer?.status === 'running' && Date.now() >= room.timer.endsAt) {
    markTimerEnded();
  }
  return room.timer;
}

function voteCount(track) {
  return Array.isArray(track?.voterTokens) ? track.voterTokens.length : 0;
}

function publicTrack(track) {
  if (!track) return null;
  const { requesterToken, voterTokens, ...out } = track;
  const requester = identities.get(requesterToken);
  return {
    ...out,
    requesterName: requester ? identityDisplayName(requester) : out.requesterName,
    votes: voteCount(track),
  };
}

function publicQueue() {
  return queue.map(publicTrack);
}

function participantProfile(id) {
  return {
    name: identityDisplayName(id),
    dreamfinderName: id.name,
    color: id.color,
    projectTitle: cleanText(id.projectTitle, 100),
    projectDescription: cleanText(id.projectDescription, 420),
    githubHandle: normalizeGithubHandle(id.githubHandle),
    consentRecording: id.consentRecording === true,
    consentResearch: id.consentResearch === true,
  };
}

function currentVisualEvent() {
  if (room.visualEvent && Date.now() - room.visualEvent.at > 5000) room.visualEvent = null;
  return room.visualEvent;
}

function publicSpotlight() {
  if (!room.spotlight) return null;
  const { participantToken, ...visible } = room.spotlight;
  return visible;
}

function hostSpotlight() {
  if (!room.spotlight) return null;
  return { ...publicSpotlight(), participantToken: room.spotlight.participantToken };
}

function rotateRequesterOrder(tokens, votes) {
  const current = tokens.indexOf(lastPlayedRequesterByVotes[String(votes)]);
  if (current < 0) return tokens;
  return tokens.slice(current + 1).concat(tokens.slice(0, current + 1));
}

function scheduleVoteBand(tracks, votes) {
  const byRequester = new Map();
  for (const track of tracks.sort((a, b) => a.addedAt - b.addedAt)) {
    const token = track.requesterToken || track.requesterName;
    if (!byRequester.has(token)) byRequester.set(token, []);
    byRequester.get(token).push(track);
  }
  const order = rotateRequesterOrder(Array.from(byRequester.keys()), votes);
  const scheduled = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const token of order) {
      const next = byRequester.get(token).shift();
      if (next) {
        scheduled.push(next);
        remaining = true;
      }
    }
  }
  return scheduled;
}

function sortQueue() {
  const voteBands = new Map();
  for (const track of queue) {
    const votes = voteCount(track);
    if (!voteBands.has(votes)) voteBands.set(votes, []);
    voteBands.get(votes).push(track);
  }
  const ranked = Array.from(voteBands.keys())
    .sort((a, b) => b - a)
    .flatMap(votes => scheduleVoteBand(voteBands.get(votes), votes));
  queue.splice(0, queue.length, ...ranked);
}

function recordPlay(track) {
  playHistory.unshift({ ...publicTrack(track), eventId: track.eventId || hooks.currentEventId(), playedAt: Date.now() });
  playHistory.length = Math.min(playHistory.length, HISTORY_LIMIT);
  savePersistentState();
}

function startTimer({ durationMs, label }) {
  if (timerTimeout) clearTimeout(timerTimeout);
  const now = Date.now();
  room.timer = {
    id: crypto.randomBytes(4).toString('hex'),
    label: label || 'Sprint',
    durationMs,
    startedAt: now,
    endsAt: now + durationMs,
    status: 'running',
  };
  armTimerTimeout();
  savePersistentState();
  hooks.broadcast();
  return room.timer;
}

function armTimerTimeout() {
  if (timerTimeout) clearTimeout(timerTimeout);
  if (!room.timer || room.timer.status !== 'running') return;
  const remaining = room.timer.endsAt - Date.now();
  if (remaining <= 0) {
    markTimerEnded();
    hooks.broadcast();
    return;
  }
  timerTimeout = setTimeout(() => {
    markTimerEnded();
    hooks.broadcast();
  }, Math.min(remaining, 2147483647));
}

function clearTimer() {
  if (timerTimeout) clearTimeout(timerTimeout);
  timerTimeout = null;
  room.timer = null;
  savePersistentState();
  hooks.broadcast();
}

function currentAnnouncement() {
  if (room.announcement && Date.now() >= room.announcement.expiresAt) {
    room.announcement = null;
  }
  return room.announcement;
}

function showAnnouncement({ title, message, detail, durationMs, color }) {
  if (announcementTimeout) clearTimeout(announcementTimeout);
  const now = Date.now();
  room.announcement = {
    id: crypto.randomBytes(4).toString('hex'),
    title: String(title || 'Dreamfinder').slice(0, 80),
    message: String(message || '').slice(0, 180),
    detail: String(detail || '').slice(0, 180),
    color: String(color || '#fbbf24').slice(0, 40),
    createdAt: now,
    expiresAt: now + durationMs,
  };
  announcementTimeout = setTimeout(() => {
    room.announcement = null;
    hooks.broadcast();
  }, Math.min(durationMs, 2147483647));
  hooks.broadcast();
  return room.announcement;
}

function clearAnnouncement() {
  if (announcementTimeout) clearTimeout(announcementTimeout);
  announcementTimeout = null;
  room.announcement = null;
  hooks.broadcast();
}

module.exports = {
  // the raw parsed state blob, read ONCE here at module load. Exported so
  // event-session.js can hydrate event/eventsArchive from the SAME snapshot
  // rather than re-reading the file (a second parse could diverge if the file
  // changed between reads). See server.js's boot.
  savedState,
  // reassigned-scalar holder (B)
  room,
  // reference-stable containers (A)
  identities,
  queue,
  playHistory,
  reports,
  lastPlayedRequesterByVotes,
  sseClients,
  gestureTimes,
  // late-bound cross-module callbacks (C)
  hooks,
  wireHooks,
  // persistence
  loadPersistentState,
  savePersistentState,
  // identity + helpers
  createIdentity,
  clamp,
  cleanText,
  normalizeGithubHandle,
  identityDisplayName,
  normalizeVisuals,
  currentVisualEvent,
  participantProfile,
  voteCount,
  publicTrack,
  publicQueue,
  publicSpotlight,
  hostSpotlight,
  sortQueue,
  recordPlay,
  // timer
  currentTimer,
  markTimerEnded,
  startTimer,
  armTimerTimeout,
  clearTimer,
  // announcement
  currentAnnouncement,
  showAnnouncement,
  clearAnnouncement,
};
