// --- routes ---
// The HTTP dispatch table and its request/response helpers. Exports a single
// `requestHandler(req, res)` that server.js hands to http.createServer. Every
// piece of room state is reached through the carved modules; this file owns no
// mutable state of its own beyond the per-request closures.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { JOIN_URL, PUBLIC_DIR, SHOW_MODES } = require('./config');
const {
  room,
  identities,
  queue,
  playHistory,
  reports,
  gestureTimes,
  createIdentity,
  clamp,
  cleanText,
  normalizeGithubHandle,
  identityDisplayName,
  normalizeVisuals,
  participantProfile,
  publicTrack,
  publicQueue,
  hostSpotlight,
  sortQueue,
  startTimer,
  clearTimer,
  showAnnouncement,
  clearAnnouncement,
  savePersistentState,
  sseClients,
} = require('./state');
const { broadcast, statePayload } = require('./sse-hub');
const sprint = require('./sprint');
const { mpvSend, playNext } = require('./mpv');
const { ytSearch } = require('./ytSearch');
const { developSpotlightInsights, archiveSpotlight } = require('./research');
const {
  currentEventId,
  isEventOpen,
  markAttendance,
  publicEvent,
  openEvent,
  closeEvent,
  getEvent,
  getEventsArchive,
} = require('./event-session');

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

// Guard for guest-mutating routes: 403 with a client-detectable flag when the
// room is closed. Returns true to proceed, false after having already replied.
function requireOpenEvent(res) {
  if (isEventOpen()) return true;
  send(res, 403, { error: 'No event is running right now.', eventClosed: true });
  return false;
}

async function requestHandler(req, res) {
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
    return send(res, 200, { event: publicEvent(), archive: getEventsArchive() });
  }

  if (method === 'POST' && p === '/api/event/open') {
    if (isEventOpen()) {
      return send(res, 409, { error: 'an event is already open; close it first' });
    }
    const body = await readBody(req);
    return send(res, 200, { event: openEvent(body.title) });
  }

  if (method === 'POST' && p === '/api/event/close') {
    if (!isEventOpen()) {
      return send(res, 409, { error: 'no open event to close' });
    }
    return send(res, 200, { event: closeEvent() });
  }

  // host: reopen a past event's archived output (reports/history/attendees by tag)
  if (method === 'GET' && p === '/api/event/archive') {
    const id = url.searchParams.get('id');
    if (!id) return send(res, 200, { archive: getEventsArchive() });
    const liveEvent = getEvent();
    const archived = getEventsArchive().find(e => e.id === id) ||
      (liveEvent && liveEvent.id === id ? publicEvent() : null);
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

  // sprint mode (autonomous Dreamfinder host) — HOST-ONLY, kept OFF the public
  // Caddy proxy exactly like /api/timer/*. Each control wraps the sprint.js fn;
  // a thrown precondition error becomes a 409 (a malformed-input throw a 400).
  if (method === 'GET' && p === '/api/sprint') {
    // Full plan is host-only here; the public wire projection is current+next.
    return send(res, 200, { sprint: sprint.sprintProjection(), plan: room.sprint?.plan || null });
  }

  if (method === 'POST' && p === '/api/sprint/start') {
    const body = await readBody(req);
    try {
      const projection = sprint.startSprint({ plan: body.plan, durations: body.durations, windDownMs: body.windDownMs });
      return send(res, 200, { sprint: projection });
    } catch (err) {
      // A double-start ("already running") is a 409 conflict; a bad plan/duration
      // is a 400 bad request. Distinguish on the message the sequencer throws.
      const conflict = /already running/.test(err.message);
      return send(res, conflict ? 409 : 400, { error: err.message });
    }
  }

  if (method === 'POST' && p === '/api/sprint/pause') {
    try { return send(res, 200, { sprint: sprint.pauseSprint() }); }
    catch (err) { return send(res, 409, { error: err.message }); }
  }

  if (method === 'POST' && p === '/api/sprint/resume') {
    try { return send(res, 200, { sprint: sprint.resumeSprint() }); }
    catch (err) { return send(res, 409, { error: err.message }); }
  }

  if (method === 'POST' && p === '/api/sprint/skip') {
    try { return send(res, 200, { sprint: sprint.skipPhase() }); }
    catch (err) { return send(res, 409, { error: err.message }); }
  }

  if (method === 'POST' && p === '/api/sprint/extend') {
    const body = await readBody(req);
    try {
      return send(res, 200, { sprint: sprint.extendSprint({ minutes: body.minutes, seconds: body.seconds }) });
    } catch (err) {
      // "no running sprint" is a 409 conflict; an out-of-range duration is a 400.
      const badInput = /between 1 second/.test(err.message);
      return send(res, badInput ? 400 : 409, { error: err.message });
    }
  }

  if (method === 'POST' && p === '/api/sprint/stop') {
    try { return send(res, 200, { sprint: sprint.stopSprint() }); }
    catch (err) { return send(res, 409, { error: err.message }); }
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
  // Access-Control-Allow-Origin:* lets an off-origin frontend (a native webOS TV
  // app, a separate dashboard) open this stream — the engine contract's whole
  // point (ENGINE.md). Safe: this is public, read-only data already proxied to
  // the open internet. Same-origin frontends (the served PWA) are unaffected.
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify(statePayload())}\n\n`);
    const client = { res, includeSpotlight: false };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  // Local room/admin stream. This must not be exposed through the public proxy.
  // CORS-open too so a local off-origin frontend (e.g. a webOS app pointed at the
  // Pi on the venue LAN) can read it; network exposure is still constrained by
  // the proxy/firewall keeping this path off the public route, not by CORS.
  if (method === 'GET' && p === '/api/show-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify(statePayload({ includeSpotlight: true }))}\n\n`);
    const client = { res, includeSpotlight: true };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  res.writeHead(404); res.end('not found');
}

module.exports = { requestHandler };
