// Dreamfinder — meetup room stage
// Pi plays music; room/admin shows a stable join QR;
// attendees join, get a PWA-ish page, search YouTube, queue tracks;
// admin can run a visible timer and the room page alarms when it ends.
// Single-file Node server, zero npm deps. SSE for live updates.

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const crypto = require('crypto');

const {
  PORT,
  MPV_SOCK,
  PUBLIC_DIR,
  REPORT_LIMIT,
  AUDIO_ENABLED,
  JOIN_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  GITHUB_TOKEN,
  SHOW_MODES,
} = require('./config');
// Closed set of event states — a frozen constant so the room's state machine
// can't be driven by a stray string literal typo.
const EVENT_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

// --- state ---
// The mutable-state nexus lives in state.js, which OWNS every shared mutable
// global. Reassigned scalars (nowPlaying/timer/mode/announcement/visuals/
// visualEvent/spotlight) are held as fields on the exported `room` holder and
// read fresh as `room.x`; reference-stable containers (identities/queue/...) are
// shared by live reference. state.js reaches back into sse-hub/mpv/event-session
// via its mutable `hooks` registry, wired by this composition root below.
const state = require('./state');
const {
  room,
  identities,
  queue,
  playHistory,
  reports,
  lastPlayedRequesterByVotes,
  sseClients,
  gestureTimes,
  loadPersistentState,
  savePersistentState,
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
  currentTimer,
  markTimerEnded,
  startTimer,
  armTimerTimeout,
  clearTimer,
  currentAnnouncement,
  showAnnouncement,
  clearAnnouncement,
} = state;

const savedState = loadPersistentState();

// --- event session lifecycle ---
// One host-controlled event gates all guest participation. With no open event,
// guests see a friendly closed room and cannot mutate any state. The event
// carries only identity/title/status/dates — the live phase stays in `mode`
// (its single source of truth) and is surfaced as `phase` in the payload.
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
let event = normalizeEvent(savedState.event);
const eventsArchive = Array.isArray(savedState.eventsArchive)
  ? savedState.eventsArchive.map(normalizeEvent).filter(Boolean)
  : [];
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

// --- SSE payload + broadcast ---
// Carved into sse-hub.js. statePayload reads state through the `room` holder and
// state accessors; broadcast fans out to sseClients. state.js calls broadcast
// back through its late-bound `hooks.broadcast` (wired in the composition root).
const { broadcast, statePayload } = require('./sse-hub');

// --- event lifecycle helpers ---
// The id of the event new participation should be tagged with, or null when no
// event is open (which is also the signal that guest routes must be rejected).
function currentEventId() {
  return event && event.status === EVENT_STATUS.OPEN ? event.id : null;
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

// Guard for guest-mutating routes: 403 with a client-detectable flag when the
// room is closed. Returns true to proceed, false after having already replied.
function requireOpenEvent(res) {
  if (event && event.status === EVENT_STATUS.OPEN) return true;
  send(res, 403, { error: 'No event is running right now.', eventClosed: true });
  return false;
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

// --- mpv control ---
// Carved into mpv.js. The four functions move together (playNext is the only
// callback of listenMpvEvents and recurses on error). mpv reaches shared room
// state and state/sse-hub helpers by live reference; state.js calls back into
// mpv through its late-bound `hooks.playNext`, and playNext reaches the
// event-session `currentEventId` (still here) through `state.hooks`.
const { startMpv, mpvSend, listenMpvEvents, playNext } = require('./mpv');

// --- yt-dlp search ---
const { ytSearch } = require('./ytSearch');

// --- consented spotlight research and facilitation ---
// Carved into research.js. Owns term extraction, public-source research
// (GitHub/arXiv/OpenAlex), the evidence-based facilitation template, the optional
// OpenAI-authored riff, and the two spotlight lifecycle functions. The spotlight
// concurrent-cancellation guard survives the carve because every access goes
// through the live `room.spotlight` holder; archiveSpotlight reaches the
// event-session `currentEventId` (still here) through `state.hooks`.
const {
  developSpotlightInsights,
  archiveSpotlight,
} = require('./research');

// --- HTTP helpers ---
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
  });
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(p);
    const ct = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}

// --- routes ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method;

  // pages
  if (method === 'GET' && p === '/')      return serveStatic(res, 'index.html');
  if (method === 'GET' && p === '/stage') return serveStatic(res, 'index.html');
  if (method === 'GET' && p === '/admin') return serveStatic(res, 'admin.html');
  if (method === 'GET' && p === '/room')  return serveStatic(res, 'room.html');
  if (method === 'GET' && p.startsWith('/static/')) return serveStatic(res, p.slice('/static/'.length));

  // room/admin configuration kept local with those host surfaces
  if (method === 'GET' && p === '/api/config') {
    return send(res, 200, { joinUrl: JOIN_URL });
  }

  // who am i (token in query)
  if (method === 'GET' && p === '/api/whoami') {
    const t = url.searchParams.get('t');
    const id = identities.get(t);
    if (!id) return send(res, 404, { error: 'unknown token' });
    return send(res, 200, participantProfile(id));
  }

  // admin: list all minted attendees (for hydration after admin reload)
  if (method === 'GET' && p === '/api/attendees') {
    const out = [];
    for (const [token, id] of identities) {
      out.push({ token, ...participantProfile(id), mintedAt: id.mintedAt });
    }
    out.sort((a, b) => a.mintedAt - b.mintedAt);
    return send(res, 200, { attendees: out });
  }

  // admin: recently selected tracks, retained across restarts
  if (method === 'GET' && p === '/api/history') {
    return send(res, 200, { tracks: playHistory });
  }

  if (method === 'GET' && p === '/api/reports') {
    return send(res, 200, { reports });
  }

  // event lifecycle (host-only — kept off the public proxy like other controls)
  if (method === 'GET' && p === '/api/event') {
    return send(res, 200, { event: publicEvent(), archive: eventsArchive });
  }

  if (method === 'POST' && p === '/api/event/open') {
    if (event && event.status === EVENT_STATUS.OPEN) {
      return send(res, 409, { error: 'an event is already open; close it first' });
    }
    const body = await readBody(req);
    return send(res, 200, { event: openEvent(body.title) });
  }

  if (method === 'POST' && p === '/api/event/close') {
    if (!event || event.status !== EVENT_STATUS.OPEN) {
      return send(res, 409, { error: 'no open event to close' });
    }
    return send(res, 200, { event: closeEvent() });
  }

  // host: reopen a past event's archived output (reports/history/attendees by tag)
  if (method === 'GET' && p === '/api/event/archive') {
    const id = url.searchParams.get('id');
    if (!id) return send(res, 200, { archive: eventsArchive });
    const archived = eventsArchive.find(e => e.id === id) ||
      (event && event.id === id ? publicEvent() : null);
    if (!archived) return send(res, 404, { error: 'unknown event' });
    return send(res, 200, {
      event: archived,
      reports: reports.filter(report => report.eventId === id),
      history: playHistory.filter(entry => entry.eventId === id),
      attendees: Array.from(identities.values())
        .filter(identity => Array.isArray(identity.eventIds) && identity.eventIds.includes(id))
        .map(identity => participantProfile(identity)),
    });
  }

  // admin: mint a new attendee
  if (method === 'POST' && p === '/api/mint') {
    return send(res, 200, createIdentity());
  }

  // guest: self-join and receive an identity (only while an event is open)
  if (method === 'POST' && p === '/api/join') {
    if (!requireOpenEvent(res)) return;
    return send(res, 200, createIdentity());
  }

  // guest: opt-in project profile used by spotlight and evidence searches
  if (method === 'POST' && p === '/api/profile') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    id.projectTitle = cleanText(body.projectTitle, 100);
    id.projectDescription = cleanText(body.projectDescription, 420);
    id.githubHandle = normalizeGithubHandle(body.githubHandle);
    id.consentRecording = body.consentRecording === true;
    id.consentResearch = body.consentResearch === true;
    savePersistentState();
    broadcast();
    return send(res, 200, { ok: true, profile: participantProfile(id) });
  }

  // guest: evolve the room's generative animation controls
  if (method === 'POST' && p === '/api/visuals') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    room.visuals = normalizeVisuals({
      ...room.visuals,
      theme: body.theme ?? room.visuals.theme,
      energy: body.energy ?? room.visuals.energy,
      complexity: body.complexity ?? room.visuals.complexity,
      hue: body.hue ?? room.visuals.hue,
      editedBy: identityDisplayName(id),
      editedAt: Date.now(),
    });
    savePersistentState();
    broadcast();
    return send(res, 200, { visuals: room.visuals });
  }

  // guest: phone motion triggers a short visual response, rate-limited per person
  if (method === 'POST' && p === '/api/gesture') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    if (body.type !== 'shake') return send(res, 400, { error: 'unknown gesture' });
    const lastAt = gestureTimes.get(body.token) || 0;
    if (Date.now() - lastAt < 900) return send(res, 429, { error: 'shake too frequent' });
    gestureTimes.set(body.token, Date.now());
    room.visualEvent = {
      id: crypto.randomBytes(4).toString('hex'),
      type: 'shake',
      intensity: clamp(body.intensity, 0, 1, 0.5),
      color: id.color,
      requesterName: identityDisplayName(id),
      at: Date.now(),
    };
    broadcast();
    return send(res, 200, { ok: true, visualEvent: room.visualEvent });
  }

  // admin: set the room's current show phase
  if (method === 'POST' && p === '/api/mode') {
    const body = await readBody(req);
    const requested = String(body.mode || '');
    if (!SHOW_MODES.has(requested)) return send(res, 400, { error: 'unknown mode' });
    room.mode = requested;
    savePersistentState();
    broadcast();
    return send(res, 200, { mode: room.mode });
  }

  // timer controls
  if (method === 'POST' && p === '/api/timer/start') {
    const body = await readBody(req);
    const seconds = Number(body.seconds ?? body.durationSeconds ?? 0);
    const minutes = Number(body.minutes ?? 0);
    const durationMs = Math.round((seconds || minutes * 60) * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 24 * 60 * 60 * 1000) {
      return send(res, 400, { error: 'duration must be between 1 second and 24 hours' });
    }
    return send(res, 200, { timer: startTimer({ durationMs, label: String(body.label || 'Sprint').slice(0, 40) }) });
  }

  if (method === 'POST' && p === '/api/timer/clear') {
    clearTimer();
    return send(res, 200, { timer: null });
  }

  // room announcement controls
  if (method === 'POST' && p === '/api/announce') {
    const body = await readBody(req);
    const seconds = Number(body.seconds ?? 12);
    const durationMs = Math.round(seconds * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 5 * 60 * 1000) {
      return send(res, 400, { error: 'announcement duration must be between 1 second and 5 minutes' });
    }
    const nextAnnouncement = showAnnouncement({
      title: body.title,
      message: body.message,
      detail: body.detail,
      color: body.color,
      durationMs,
    });
    return send(res, 200, { announcement: nextAnnouncement });
  }

  if (method === 'POST' && p === '/api/announce/clear') {
    clearAnnouncement();
    return send(res, 200, { announcement: null });
  }

  // host: begin and capture a consented spoken project/progress report
  if (method === 'POST' && p === '/api/spotlight/start') {
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 404, { error: 'unknown participant' });
    if (id.consentRecording !== true) {
      return send(res, 409, { error: 'participant has not consented to live transcription/display' });
    }
    const kind = body.kind === 'progress' ? 'progress' : 'introduction';
    room.spotlight = {
      id: crypto.randomBytes(5).toString('hex'),
      eventId: currentEventId(),
      active: true,
      participantToken: body.token,
      participantName: identityDisplayName(id),
      projectTitle: cleanText(id.projectTitle, 100),
      kind,
      transcript: '',
      isFinal: false,
      status: 'listening',
      insights: null,
      startedAt: Date.now(),
    };
    broadcast();
    return send(res, 200, { spotlight: hostSpotlight() });
  }

  if (method === 'POST' && p === '/api/spotlight/transcript') {
    const body = await readBody(req);
    if (!room.spotlight?.active) return send(res, 409, { error: 'no active spotlight' });
    room.spotlight = {
      ...room.spotlight,
      transcript: cleanText(body.transcript ?? body.text, 6000),
      isFinal: body.isFinal === true,
      status: body.isFinal === true ? 'captured' : 'listening',
    };
    broadcast();
    return send(res, 200, { spotlight: hostSpotlight() });
  }

  if (method === 'POST' && p === '/api/spotlight/insights') {
    if (!room.spotlight?.active) return send(res, 409, { error: 'no active spotlight' });
    const id = identities.get(room.spotlight.participantToken);
    if (id?.consentResearch !== true) {
      return send(res, 409, { error: 'participant has not consented to external research and analysis' });
    }
    try {
      const insights = await developSpotlightInsights();
      return send(res, 200, { insights, spotlight: hostSpotlight() });
    } catch (err) {
      if (room.spotlight) {
        room.spotlight = { ...room.spotlight, status: 'research-failed' };
        broadcast();
      }
      return send(res, 502, { error: err.message });
    }
  }

  if (method === 'POST' && p === '/api/spotlight/end') {
    archiveSpotlight();
    room.spotlight = null;
    broadcast();
    return send(res, 200, { spotlight: null });
  }

  // search
  if (method === 'GET' && p === '/api/search') {
    const q = url.searchParams.get('q');
    if (!q) return send(res, 400, { error: 'missing q' });
    const results = await ytSearch(q);
    return send(res, 200, { results });
  }

  // queue a track
  if (method === 'POST' && p === '/api/queue') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    if (!body.videoId || !body.title) return send(res, 400, { error: 'missing videoId/title' });
    const entry = {
      id: crypto.randomBytes(4).toString('hex'),
      eventId: currentEventId(),
      requesterToken: body.token,
      requesterName: identityDisplayName(id),
      color: id.color,
      videoId: body.videoId,
      title: body.title,
      thumbnail: body.thumbnail || `https://i.ytimg.com/vi/${body.videoId}/mqdefault.jpg`,
      addedAt: Date.now(),
      voterTokens: [],
    };
    queue.push(entry);
    sortQueue();
    savePersistentState();
    broadcast();
    if (!room.nowPlaying) playNext();
    return send(res, 200, { ok: true, queued: publicTrack(entry) });
  }

  // guest: current user's votes for queued tracks
  if (method === 'GET' && p === '/api/votes') {
    const t = url.searchParams.get('t');
    const id = identities.get(t);
    if (!id) return send(res, 404, { error: 'unknown token' });
    const trackIds = queue
      .filter(track => Array.isArray(track.voterTokens) && track.voterTokens.includes(t))
      .map(track => track.id);
    const ownedTrackIds = queue
      .filter(track => track.requesterToken === t)
      .map(track => track.id);
    return send(res, 200, { trackIds, ownedTrackIds });
  }

  // guest: toggle one upvote on a queued track
  if (method === 'POST' && p === '/api/upvote') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    const track = queue.find(item => item.id === body.trackId);
    if (!track) return send(res, 404, { error: 'track is no longer queued' });
    if (track.requesterToken === body.token) {
      return send(res, 409, { error: 'cannot vote for your own track' });
    }
    if (!Array.isArray(track.voterTokens)) track.voterTokens = [];
    const existing = track.voterTokens.indexOf(body.token);
    const voted = existing === -1;
    if (voted) {
      track.voterTokens.push(body.token);
    } else {
      track.voterTokens.splice(existing, 1);
    }
    sortQueue();
    savePersistentState();
    broadcast();
    return send(res, 200, { ok: true, voted, track: publicTrack(track), queue: publicQueue() });
  }

  // admin: skip current
  if (method === 'POST' && p === '/api/skip') {
    try { await mpvSend(['stop']); } catch(e) {}
    return send(res, 200, { ok: true });
  }

  // Public SSE stream: deliberately excludes live transcripts and research.
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(statePayload())}\n\n`);
    const client = { res, includeSpotlight: false };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  // Local room/admin stream. This must not be exposed through the public proxy.
  if (method === 'GET' && p === '/api/show-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(statePayload({ includeSpotlight: true }))}\n\n`);
    const client = { res, includeSpotlight: true };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  res.writeHead(404); res.end('not found');
});

// --- composition root: wire state.js's late-bound cross-module hooks ---
// state.js calls these indirectly to avoid a static require cycle with sse-hub/
// mpv (broadcast/playNext) and the event-session globals (still in this file).
// Wire them now that every dependency is defined, BEFORE any boot call that may
// reach through a hook (armTimerTimeout/playNext both broadcast).
state.hooks.broadcast = broadcast;
state.hooks.playNext = playNext;
state.hooks.currentEventId = currentEventId;
state.hooks.getEvent = () => event;
state.hooks.getEventsArchive = () => eventsArchive;
state.hooks.publicEvent = publicEvent;

sortQueue();
armTimerTimeout();
if (AUDIO_ENABLED) {
  startMpv();
  setTimeout(() => {
    listenMpvEvents();
    if (queue.length) playNext();
  }, 1500); // give mpv a moment to create the socket
} else if (queue.length) {
  playNext();
}
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dreamfinder listening on http://0.0.0.0:${PORT}`);
});
