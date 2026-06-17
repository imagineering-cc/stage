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
  shareQueueEntry,
  pruneShareEntry,
  sortQueue,
  startTimer,
  clearTimer,
  showAnnouncement,
  clearAnnouncement,
  commit,
  sseClients,
} = require('./state');
const { broadcast, statePayload } = require('./sse-hub');
const sprint = require('./sprint');
const { mpvSend, playNext } = require('./mpv');
const { ytSearch } = require('./ytSearch');
const {
  developSpotlightInsights,
  developFacilitation,
  shapeFacilitation,
  archiveSpotlight,
} = require('./research');
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

// THE TRUST BOUNDARY (M2). The single source of truth for "who may speak" is
// room.spotlight.participantToken (set by admit, cleared by every terminal
// transition). This rule is re-derived from room.spotlight on EVERY transcript/
// correct request — it never trusts prior client state, never caches. Returns the
// token on success, or null AFTER having already sent the rejection (the caller
// bails on null and only mutates room.spotlight past it). The bypass cases are
// enumerated in ENGINE.md / the design; this one rule rejects all of them:
//   (E) missing/garbage or never-minted token -> 401
//   (F) no live spotlight (none admitted, or already finished/stopped) -> 409
//   (D) spotlight belongs to a different/closed event -> 409
//   (A/B/C) a live spotlight but not THIS token's turn -> 403
function gateAdmittedPresenter(res, body) {
  const token = body.token;
  if (typeof token !== 'string' || token.length === 0) {
    send(res, 401, { error: 'missing or invalid token' }); return null;
  }
  if (!identities.has(token)) {
    send(res, 401, { error: 'unknown token' }); return null;
  }
  if (!room.spotlight || room.spotlight.active !== true) {
    send(res, 409, { error: 'no active spotlight' }); return null;
  }
  // currentEventId() is null when the event is closed; spotlight.eventId is a
  // non-null string, so this also covers the close-mid-presentation case.
  if (room.spotlight.eventId !== currentEventId()) {
    send(res, 409, { error: 'event has changed; presentation ended' }); return null;
  }
  if (room.spotlight.participantToken !== token) {
    send(res, 403, { error: 'you are not the admitted presenter' }); return null;
  }
  return token;
}

// Guarded-mutation helper (#11). Runs a room-mutating closure through state.commit()
// — which validates the proposed persisted snapshot BEFORE it can persist and
// rolls `room` back if the result is invalid. On rejection it sends a 422 (the
// proposed change would have produced a state the persistence gate refuses) and
// returns false so the caller bails BEFORE broadcasting; a rejected mutation
// therefore never reaches a client or disk. Returns true on success. The 422 is a
// structural backstop: every wrapped route also rejects bad input with a precise
// 4xx upstream of the mutation, so in normal operation commit() always succeeds —
// the value is that a FUTURE mutation path (e.g. M3) is born guarded.
function guardedMutate(res, mutator) {
  try { commit(mutator); return true; }
  catch (err) {
    // Distinguish the two failure modes commit() can throw (both leave room rolled
    // back): a validateStateShape rejection is a BAD REQUEST (422 — the proposed
    // change would produce invalid state), whereas a writeSnapshot I/O failure is a
    // SERVER error (500 — the change was valid but couldn't be persisted). Blanketing
    // both as 422 would mislabel a disk failure as the client's fault.
    const isValidation = /\[STATE VALIDATION\]/.test(err.message);
    if (isValidation) {
      send(res, 422, { error: 'change rejected: would produce invalid room state', detail: err.message });
    } else {
      send(res, 500, { error: 'state could not be persisted', detail: err.message });
    }
    return false;
  }
}

// Per-spotlight rate limiter for facilitation re-search (the EXPENSIVE branch of
// /api/spotlight/facilitation/another — cursor advance over the already-retrieved
// question set is FREE; only re-running the bounded network search is throttled).
// Keyed by spotlight id; the entry is naturally abandoned when the spotlight clears
// (a new spotlight has a new id), and the map is swept lazily on each check so it
// can't grow unbounded across a long meetup. Mirrors the gestureTimes pattern.
const FACILITATION_RESEARCH_COOLDOWN_MS = 20000;
const facilitationResearchTimes = new Map(); // spotlightId -> last re-search epoch ms
// Lazy sweep: a spotlight id is unique per turn and never reused, so once it is no
// longer the LIVE spotlight its cooldown entry can never gate a future decision —
// drop it. Called on every check so the map size stays O(at most one live spotlight)
// over a long meetup, not O(spotlights this night). (cage-match: the PR comment
// claimed a sweep that did not exist — this is the sweep, now real.)
function sweepFacilitationResearchTimes() {
  const liveId = room.spotlight?.id;
  for (const id of facilitationResearchTimes.keys()) {
    if (id !== liveId) facilitationResearchTimes.delete(id);
  }
}
function facilitationResearchAllowed(spotlightId) {
  sweepFacilitationResearchTimes();
  const last = facilitationResearchTimes.get(spotlightId) || 0;
  return Date.now() - last >= FACILITATION_RESEARCH_COOLDOWN_MS;
}

// Kick off the autonomous facilitation generation in the BACKGROUND (fire-and-
// forget): developFacilitation self-broadcasts, is orphan-safe (spotlightId
// re-check before every write), and never throws to us. We only start it when no
// facilitation exists yet for this spotlight, so it runs exactly once per turn.
function maybeStartFacilitation() {
  if (room.spotlight?.active && !room.spotlight.facilitation) {
    developFacilitation().catch(err => console.error('facilitation generation error:', err.message));
  }
}

// Clear the live spotlight IFF it belongs to `token` (defensive: a terminal
// transition for a stale token must never clear a NEWER presenter's spotlight).
function clearSpotlightFor(token) {
  if (room.spotlight && room.spotlight.participantToken === token) {
    room.spotlight = null;
  }
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
    if (!guardedMutate(res, () => {
      markAttendance(id);
      id.projectTitle = cleanText(body.projectTitle, 100);
      id.projectDescription = cleanText(body.projectDescription, 420);
      id.githubHandle = normalizeGithubHandle(body.githubHandle);
      id.consentRecording = body.consentRecording === true;
      id.consentResearch = body.consentResearch === true;
    })) return;
    broadcast();
    return send(res, 200, { ok: true, profile: participantProfile(id) });
  }

  // guest: evolve the room's generative animation controls
  if (method === 'POST' && p === '/api/visuals') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    if (!guardedMutate(res, () => {
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
    })) return;
    broadcast();
    return send(res, 200, { visuals: room.visuals });
  }

  // guest: phone motion triggers a short visual response, rate-limited per person
  if (method === 'POST' && p === '/api/gesture') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    if (body.type !== 'shake') return send(res, 400, { error: 'unknown gesture' });
    const lastAt = gestureTimes.get(body.token) || 0;
    if (Date.now() - lastAt < 900) return send(res, 429, { error: 'shake too frequent' });
    markAttendance(id); // only after the gesture is accepted — a rejected shake leaves no attendance tick
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

  // admin: set the room's current show phase. Exemplary guarded-mutation usage:
  // a PRECISE pre-check on the closed SHOW_MODES set rejects a bad mode with a
  // clean 400 BEFORE any mutation, and commit() is the structural backstop —
  // even if the pre-check is ever bypassed, validateStateShape inside commit()
  // would reject the mode and roll room.mode back rather than broadcast/persist
  // it. Belt and suspenders: routes validate for good errors, commit() guarantees
  // no invalid state can persist or broadcast.
  if (method === 'POST' && p === '/api/mode') {
    const body = await readBody(req);
    const requested = String(body.mode || '');
    if (!SHOW_MODES.has(requested)) return send(res, 400, { error: 'unknown mode' });
    if (!guardedMutate(res, () => { room.mode = requested; })) return;
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
    // startTimer self-persists; an I/O write failure must surface as a controlled
    // 500, not an uncaught throw out of the async handler (which would leave the
    // request hanging / risk crashing the process).
    try {
      return send(res, 200, { timer: startTimer({ durationMs, label: String(body.label || 'Sprint').slice(0, 40) }) });
    } catch (err) {
      console.error('timer start failed:', err.message); // surface real bugs to logs, not only the HTTP detail
      return send(res, 500, { error: 'could not start timer', detail: err.message });
    }
  }

  if (method === 'POST' && p === '/api/timer/clear') {
    try {
      clearTimer();
    } catch (err) {
      console.error('timer clear failed:', err.message);
      return send(res, 500, { error: 'could not clear timer', detail: err.message });
    }
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
    // Single-active-presenter invariant — reconciles the legacy host-driven path
    // with the M2 share queue. Without this, legacy start silently OVERWRITES a
    // share-admitted presenter's spotlight and strands their queue entry. Mirror
    // /api/share/admit's guard so the two control surfaces can't collide.
    if (room.spotlight?.active && room.spotlight.participantToken !== body.token) {
      return send(res, 409, { error: 'another participant is already presenting' });
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

  // Stream interim speech text. PUBLIC guest route (the admitted presenter's own
  // phone POSTs here), but per-token gated: ONLY the admitted presenter's token
  // is accepted — every other token is rejected by gateAdmittedPresenter before
  // any mutation. The {token} in the body is no longer trusted as authorization.
  if (method === 'POST' && p === '/api/spotlight/transcript') {
    const body = await readBody(req);
    const token = gateAdmittedPresenter(res, body);
    if (!token) return;
    room.spotlight = {
      ...room.spotlight,
      transcript: cleanText(body.transcript ?? body.text, 6000),
      isFinal: body.isFinal === true,
      status: body.isFinal === true ? 'captured' : 'listening',
    };
    broadcast();
    return send(res, 200, { spotlight: hostSpotlight() });
  }

  // The CORRECTION step (M2). The admitted presenter submits their final,
  // optionally-edited transcript. Same per-token gate as transcript; on success
  // it writes the corrected final text and flips the entry to 'correcting' —
  // which is the HARD precondition for /api/share/finish (the host cannot archive
  // before the guest has confirmed). PUBLIC guest route.
  if (method === 'POST' && p === '/api/spotlight/correct') {
    const body = await readBody(req);
    const token = gateAdmittedPresenter(res, body);
    if (!token) return;
    const entry = shareQueueEntry(token);
    // Defensive: the gate already guarantees this is the presenter, but only an
    // 'admitted' entry may advance to 'correcting' (a re-correct after finish is
    // moot — the gate would already have 409'd on a cleared spotlight). The
    // status flip is the PERSISTED change (shareQueue) — guard it. room.spotlight
    // is ephemeral (never persisted), so it's assigned after a successful commit.
    if (!guardedMutate(res, () => {
      if (entry && entry.status === 'admitted') entry.status = 'correcting';
    })) return;
    room.spotlight = {
      ...room.spotlight,
      transcript: cleanText(body.transcript ?? body.text, 6000),
      isFinal: true,
      status: 'corrected',
    };
    broadcast();
    // AUTONOMOUS facilitation (M3): the presenter has finalized their report, so
    // Dreamfinder asks his ONE grounded question on his own — no host pre-approval,
    // no pause. Fires in the background (self-broadcasts when ready); the response
    // to the presenter returns immediately so their phone isn't blocked on research.
    maybeStartFacilitation();
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
    // Reconcile with the share queue: if this spotlight belongs to a share-admitted
    // presenter, prune their queue entry too, or the legacy End button strands it
    // in 'admitted'/'correcting' with no live spotlight (host can't clear it).
    const endedToken = room.spotlight?.participantToken;
    // Report push (archiveSpotlight) AND queue prune in ONE guarded commit, so they
    // persist atomically and roll back together on failure. archiveSpotlight reads
    // room.spotlight, so it must run BEFORE the ephemeral clear below.
    if (!guardedMutate(res, () => {
      archiveSpotlight();
      if (endedToken) pruneShareEntry(endedToken);
    })) return;
    room.spotlight = null;     // ephemeral (never persisted) — cleared AFTER commit succeeds
    broadcast();
    return send(res, 200, { spotlight: null });
  }

  // ===== Facilitation veto controls (M3) — HOST-ONLY =====
  // DELIBERATELY off the public Caddy allow-list (the /api/skip + /api/spotlight/start
  // convention — omission IS the host-only boundary). facilitation is EPHEMERAL
  // (nested on room.spotlight, never persisted): these reassign room.spotlight in
  // memory + broadcast, NEVER commit (nothing to persist, so no guarded mutation).

  // Host VETO: dismiss the question (any facilitation status -> dismissed). Also the
  // 'continue without Dreamfinder' action. 409 if no live spotlight or no facilitation.
  if (method === 'POST' && p === '/api/spotlight/facilitation/dismiss') {
    if (!room.spotlight?.active) return send(res, 409, { error: 'no active spotlight' });
    if (!room.spotlight.facilitation) return send(res, 409, { error: 'no facilitation to dismiss' });
    room.spotlight = {
      ...room.spotlight,
      facilitation: { ...room.spotlight.facilitation, status: 'dismissed' },
    };
    broadcast();
    return send(res, 200, { facilitation: room.spotlight.facilitation });
  }

  // Host VETO: request another question. Advancing the cursor over the ALREADY-
  // RETRIEVED question set is FREE (no network). Only when the set is exhausted
  // (cursor wraps past the last question) do we re-run the bounded search — and
  // that branch is RATE-LIMITED per spotlight (gestureTimes-style). Either way the
  // result is a fresh 'asked' candidate.
  if (method === 'POST' && p === '/api/spotlight/facilitation/another') {
    if (!room.spotlight?.active) return send(res, 409, { error: 'no active spotlight' });
    const fac = room.spotlight.facilitation;
    if (!fac) return send(res, 409, { error: 'no facilitation to advance' });
    const spotlightId = room.spotlight.id;
    const insights = room.spotlight.insights;
    const questions = Array.isArray(insights?.questions) ? insights.questions.filter(Boolean) : [];
    const nextCursor = (fac.cursor || 0) + 1;
    // Still within the retrieved set (and we have grounded questions) -> FREE cursor
    // advance, re-shaped from the SAME insights (stable sids -> stable citations).
    if (questions.length > 0 && nextCursor < questions.length) {
      const candidate = shapeFacilitation(insights, nextCursor);
      if (candidate) {
        room.spotlight = {
          ...room.spotlight,
          facilitation: {
            status: 'asked', authoredBy: candidate.authoredBy, candidate, asked: candidate,
            cursor: nextCursor, proposedAt: fac.proposedAt, askedAt: Date.now(),
          },
        };
        broadcast();
        return send(res, 200, { facilitation: room.spotlight.facilitation });
      }
    }
    // Exhausted (or never had grounded questions): re-run the bounded search,
    // RATE-LIMITED per spotlight.
    if (!facilitationResearchAllowed(spotlightId)) {
      return send(res, 429, { error: 'another question is still being prepared; try again shortly' });
    }
    facilitationResearchTimes.set(spotlightId, Date.now());
    // Reset facilitation so developFacilitation regenerates from scratch (it gates on
    // facilitation==null via maybeStartFacilitation, but here we call it directly).
    room.spotlight = { ...room.spotlight, facilitation: null };
    developFacilitation().catch(err => console.error('facilitation re-search error:', err.message));
    // 202: regeneration started; the fresh 'asked' candidate arrives over SSE.
    return send(res, 202, { status: 'researching' });
  }

  // ===== Phone-led share queue (M2) =====
  // PUBLIC guest actions: request / withdraw. HOST-only controls (admit / skip /
  // stop / finish) are DELIBERATELY off the Caddy allow-list — that omission IS
  // the host-only boundary, exactly like /api/skip, /api/mode, /api/timer/*.

  // guest: request to present from their own phone (gated by an open event).
  // Recording consent is a server gate (409), not just a hidden UI button.
  if (method === 'POST' && p === '/api/share/request') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    if (id.consentRecording !== true) {
      return send(res, 409, { error: 'recording consent is required to present' });
    }
    const kind = body.kind === 'progress' ? 'progress' : 'share';
    const existing = shareQueueEntry(body.token);
    if (existing) {
      // Idempotent re-request: update the kind on a still-queued 'requested'
      // entry; reject a duplicate while they're already live (admitted/correcting).
      // markAttendance lives INSIDE the guard (and only on the success branch) so
      // the 'already presenting' 409 below leaves no attendance tick behind.
      if (existing.status === 'requested') {
        if (!guardedMutate(res, () => { markAttendance(id); existing.kind = kind; })) return;
        broadcast();
        return send(res, 200, { id: existing.id, status: existing.status });
      }
      return send(res, 409, { error: 'you are already presenting' });
    }
    const entry = {
      id: crypto.randomBytes(4).toString('hex'),
      eventId: currentEventId(),
      token: body.token,
      name: identityDisplayName(id),    // snapshotted (display-only; not live-synced)
      color: id.color,
      kind,
      projectTitle: cleanText(id.projectTitle, 100),
      requestedAt: Date.now(),
      admittedAt: null,
      status: 'requested',
    };
    if (!guardedMutate(res, () => { markAttendance(id); room.shareQueue.push(entry); })) return;
    broadcast();
    return send(res, 200, { id: entry.id, status: entry.status });
  }

  // guest: withdraw from the queue (any non-terminal state). If they were the
  // live presenter, their spotlight is cleared (NOT archived).
  if (method === 'POST' && p === '/api/share/withdraw') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    if (!identities.has(body.token)) return send(res, 401, { error: 'unknown token' });
    const entry = shareQueueEntry(body.token);
    if (!entry) return send(res, 404, { error: 'no share request to withdraw' });
    if (!guardedMutate(res, () => pruneShareEntry(body.token))) return; // terminal -> pruned (report lives in reports[])
    clearSpotlightFor(body.token);          // ephemeral: clear AFTER the commit succeeds
    broadcast();
    return send(res, 200, { ok: true });
  }

  // host: admit a requested presenter — STARTS their spotlight (reuses the exact
  // shape /api/spotlight/start builds) and marks them the SOLE active presenter.
  // HOST-ONLY (off the public proxy).
  if (method === 'POST' && p === '/api/share/admit') {
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 404, { error: 'unknown participant' });
    if (id.consentRecording !== true) {
      return send(res, 409, { error: 'participant has not consented to live transcription/display' });
    }
    // Single-active-presenter invariant: refuse a second spotlight.
    if (room.spotlight?.active && room.spotlight.participantToken !== body.token) {
      return send(res, 409, { error: 'another participant is already presenting' });
    }
    const entry = shareQueueEntry(body.token);
    if (!entry) return send(res, 404, { error: 'no share request for this participant' });
    if (entry.status !== 'requested') {
      return send(res, 409, { error: 'participant is not waiting to present' });
    }
    const kind = entry.kind === 'progress' ? 'progress' : 'introduction';
    // Persist the queue-entry transition FIRST (guarded); only on success set the
    // ephemeral spotlight. If the commit were rejected, no ghost spotlight is left
    // active for the next SSE consumer to pick up.
    if (!guardedMutate(res, () => {
      entry.status = 'admitted';
      entry.admittedAt = Date.now();
    })) return;
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

  // host: skip a queued or live presenter (NOT archived). HOST-ONLY.
  if (method === 'POST' && p === '/api/share/skip') {
    const body = await readBody(req);
    const entry = shareQueueEntry(body.token);
    if (!entry) return send(res, 404, { error: 'no share request for this participant' });
    if (!guardedMutate(res, () => pruneShareEntry(body.token))) return; // persisted
    clearSpotlightFor(body.token);                                      // ephemeral: after commit
    broadcast();
    return send(res, 200, { ok: true });
  }

  // host: stop the CURRENT live presenter (NOT archived). Global — no body token.
  // HOST-ONLY.
  if (method === 'POST' && p === '/api/share/stop') {
    // Stop the live presenter. Tolerate a MISSING spotlight: if a queue entry was
    // stranded 'admitted'/'correcting' (e.g. a legacy End cleared the spotlight
    // out-of-band before this fix, or any future skew), the host must still be able
    // to clear it. Fall back to the live queue entry when there's no spotlight.
    const liveEntry = room.shareQueue?.find(e => e.status === 'admitted' || e.status === 'correcting');
    const token = room.spotlight?.participantToken || liveEntry?.token;
    if (!token) return send(res, 409, { error: 'no active presenter' });
    if (!guardedMutate(res, () => pruneShareEntry(token))) return; // persisted
    if (room.spotlight) room.spotlight = null;                    // ephemeral: after commit
    broadcast();
    return send(res, 200, { ok: true });
  }

  // host: FINISH the current presenter — runs research (if consented) and archives
  // the report. HARD-gated on the correction step: the entry MUST be 'correcting'
  // (the guest confirmed their transcript) or this 409s. HOST-ONLY.
  if (method === 'POST' && p === '/api/share/finish') {
    const body = await readBody(req);
    const entry = shareQueueEntry(body.token);
    if (!entry) return send(res, 404, { error: 'no share request for this participant' });
    if (entry.status !== 'correcting') {
      return send(res, 409, { error: 'presenter has not confirmed their transcript yet' });
    }
    if (!room.spotlight?.active || room.spotlight.participantToken !== body.token) {
      return send(res, 409, { error: 'this participant is not the active presenter' });
    }
    // M3 DECOUPLE: finish does NOT run research/facilitation. Generation is its own
    // autonomous step (developFacilitation, triggered when the presenter finalizes
    // their report via /api/spotlight/correct). Doing it here was a latent bug — the
    // facilitation would be born and destroyed in the same action before it could be
    // asked, AND the bounded search would run twice (propose + finish). finish now
    // simply ARCHIVES whatever insights/facilitation state already exists and clears.
    // Report push + queue prune in ONE guarded commit (atomic, rolled back together
    // on failure). archiveSpotlight reads room.spotlight, so it runs before the
    // ephemeral clear below.
    if (!guardedMutate(res, () => {
      archiveSpotlight();
      pruneShareEntry(body.token);
    })) return;
    room.spotlight = null;     // ephemeral: cleared after the commit succeeds
    broadcast();
    return send(res, 200, { ok: true });
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
    // markAttendance inside the guard + AFTER validation: a rejected request never
    // leaves an attendance tick behind (the property: bad request → room unchanged).
    if (!guardedMutate(res, () => { markAttendance(id); queue.push(entry); sortQueue(); })) return;
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
    const track = queue.find(item => item.id === body.trackId);
    if (!track) return send(res, 404, { error: 'track is no longer queued' });
    if (track.requesterToken === body.token) {
      return send(res, 409, { error: 'cannot vote for your own track' });
    }
    // Toggle direction from a READ-ONLY pre-check; all mutation (normalization +
    // attendance + the toggle + re-sort) happens INSIDE the guard and AFTER the
    // 401/404/409 gates, so a rejected vote leaves room state untouched.
    const voted = !(Array.isArray(track.voterTokens) && track.voterTokens.includes(body.token));
    if (!guardedMutate(res, () => {
      if (!Array.isArray(track.voterTokens)) track.voterTokens = [];
      markAttendance(id);
      const existing = track.voterTokens.indexOf(body.token);
      if (existing === -1) track.voterTokens.push(body.token);
      else track.voterTokens.splice(existing, 1);
      sortQueue();
    })) return;
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
