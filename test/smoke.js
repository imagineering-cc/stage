// Zero-dependency smoke harness for the Stage server (server.js).
//
// This is the safety net that goes in BEFORE the single-file server gets
// refactored into modules: it boots the real server as a child process and
// pins down the load-bearing behaviours so a refactor that quietly breaks one
// of them turns CI red instead of breaking a live meetup.
//
// Constraints (deliberate):
//   - Node built-ins ONLY (node:test, node:assert, node:http via global fetch,
//     node:child_process). No npm deps, no package.json that implies one.
//   - Never touches real state: STAGE_STATE_FILE points at a fresh temp file
//     and STAGE_NO_AUDIO=1 skips mpv so no audio device is needed.
//   - Always kills the child and removes the temp state file (teardown).
//
// The server is the source of truth. Routes and behaviours asserted here were
// read out of server.js + CLAUDE.md, not assumed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server.js');

// A fresh temp state file per run. A fresh file means the server boots with NO
// event and no identities/queue, so its migration does NOT synthesize an open
// event (migration only fires when identities.size > 0 || queue.length > 0).
// => the room starts CLOSED. Every assertion below drives the event state
//    explicitly via the host routes so each precondition is unambiguous.
const stateFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'stage-smoke-')),
  'state.json',
);

let child;

// --- tiny HTTP helpers over global fetch (node:http under the hood) ---
async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const post = (p, body) => req('POST', p, body);
const get = (p) => req('GET', p);

// Read the persisted state file directly — the strongest observable when an
// HTTP response is ambiguous (per prior scar tissue).
function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

// Snapshot the public SSE stream's FIRST frame. /api/events writes
// `data: {json}\n\n` immediately on connect; we strip the `data: ` prefix and
// parse, then close. This is the public playback/visual state (nowPlaying,
// queue, event, ...).
function sseSnapshot(streamPath = '/api/events') {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const r = http.get(BASE + streamPath, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        const i = buf.indexOf('\n\n');
        if (i >= 0) {
          const frame = buf.slice(0, i);
          res.destroy();
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          resolve(JSON.parse(line.slice('data: '.length)));
        }
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    r.setTimeout(5000, () => { r.destroy(); reject(new Error('SSE timeout')); });
  });
}

// --- lifecycle: boot once before all tests, tear down after ---
test.before(async () => {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, STAGE_NO_AUDIO: '1', PORT: String(PORT), STAGE_STATE_FILE: stateFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  // Wait until the server answers on /.
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(BASE + '/api/config');
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not boot within 15s');
    await new Promise((r) => setTimeout(r, 150));
  }
});

test.after(() => {
  if (child && !child.killed) child.kill('SIGKILL');
  try { fs.rmSync(path.dirname(stateFile), { recursive: true, force: true }); } catch { /* best effort */ }
});

// Helpers that drive the host-controlled event lifecycle.
// openEvent guarantees a FRESH open event: /api/event/open returns 409 if one
// is already open, so close any existing event first. This makes each test's
// precondition independent of suite ordering.
async function openEvent(title = 'Smoke Test Meetup') {
  const cur = (await get('/api/event')).body.event;
  if (cur && cur.status === 'open') await closeEvent();
  return post('/api/event/open', { title });
}
async function closeEvent() {
  return post('/api/event/close');
}
async function join() {
  const r = await post('/api/join');
  return r;
}

// ---------------------------------------------------------------------------
// 1. join-gating: closed room rejects guest routes with {eventClosed:true};
//    an open event lets a guest join with {token,name,color}.
// ---------------------------------------------------------------------------
test('join-gating: closed -> 403 eventClosed, open -> join succeeds', async () => {
  // Fresh boot: no event => closed. /api/join must be gated.
  const closed = await join();
  assert.equal(closed.status, 403, 'join must be 403 while no event is open');
  assert.equal(closed.body.eventClosed, true, 'gate must flag eventClosed:true');

  // A non-join guest route is gated the same way.
  const queueClosed = await post('/api/queue', { token: 'whatever', videoId: 'abc', title: 'x' });
  assert.equal(queueClosed.status, 403, 'guest queue must be gated while closed');
  assert.equal(queueClosed.body.eventClosed, true);

  // Host opens an event.
  const opened = await openEvent();
  assert.equal(opened.status, 200);
  assert.equal(opened.body.event.status, 'open');

  // Now a guest can join.
  const ok = await join();
  assert.equal(ok.status, 200, 'join must succeed once an event is open');
  assert.ok(ok.body.token, 'join returns a token');
  assert.ok(ok.body.name, 'join returns a name');
  assert.ok(ok.body.color, 'join returns a color');
});

// ---------------------------------------------------------------------------
// 2. event lifecycle: open -> join -> close -> join gated again; and a closed
//    room never starts playback (the cage-match guard in playNext).
// ---------------------------------------------------------------------------
test('event lifecycle: close re-gates joins and stops the show', async () => {
  // Precondition: event open from previous test would be racy across ordering,
  // so assert-and-ensure rather than assume. Reopen if needed.
  let evt = (await get('/api/event')).body.event;
  if (!evt || evt.status !== 'open') {
    await openEvent();
  }

  // A guest joins and queues a track. With STAGE_NO_AUDIO the server has no
  // mpv, so playNext sets nowPlaying and returns — the track is "playing".
  const guest = (await join()).body;
  const q = await post('/api/queue', { token: guest.token, videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up' });
  assert.equal(q.status, 200, 'queue must succeed while open');

  // Observe via the public SSE frame that a track is now playing.
  let snap = await sseSnapshot();
  assert.ok(snap.nowPlaying, 'a track should be playing in an open room');
  assert.equal(snap.event.status, 'open');

  // Host closes the event.
  const closed = await closeEvent();
  assert.equal(closed.status, 200);
  assert.equal(closed.body.event.status, 'closed');

  // The show is stopped: nothing playing, queue cleared. This is the observable
  // form of "playNext refuses to start a track when the room is closed" — the
  // close path stops playback and the guard prevents the idle-observer/queue
  // from restarting it.
  snap = await sseSnapshot();
  assert.equal(snap.nowPlaying, null, 'closing must stop playback (nowPlaying null)');
  assert.deepEqual(snap.queue, [], 'closing must clear the queue');
  assert.equal(snap.event.status, 'closed');

  // Persisted state agrees (strongest observable): event closed.
  const st = readState();
  assert.equal(st.event.status, 'closed', 'persisted event must be closed');

  // Joins are gated again.
  const gated = await join();
  assert.equal(gated.status, 403, 'join must be re-gated after close');
  assert.equal(gated.body.eventClosed, true);

  // Queueing while closed is rejected, so no track can sneak into playback.
  const sneak = await post('/api/queue', { token: guest.token, videoId: 'abc12345678', title: 'sneaky' });
  assert.equal(sneak.status, 403, 'no track can be queued (and thus played) while closed');
  assert.equal(sneak.body.eventClosed, true);

  // And after a beat, still nothing is playing.
  await new Promise((r) => setTimeout(r, 300));
  snap = await sseSnapshot();
  assert.equal(snap.nowPlaying, null, 'a closed room must not spontaneously start playing');
});

// ---------------------------------------------------------------------------
// 3. queue sort: vote-ranked ordering with fair rotation between distinct
//    requesters at equal votes.
// ---------------------------------------------------------------------------
test('queue sort: votes rank, equal votes rotate fairly between requesters', async () => {
  // Fresh event => empty queue, reset fair-rotation cursor.
  await openEvent('Sort Test');

  const a = (await join()).body; // requester A
  const b = (await join()).body; // requester B
  const c = (await join()).body; // a voter (own-track votes are rejected)

  // A queues two tracks, B queues two tracks. With STAGE_NO_AUDIO, the FIRST
  // track queued immediately becomes nowPlaying (playNext fires when nothing is
  // playing) and leaves the queue, so we queue and then inspect the remaining
  // queue ordering.
  const qA1 = (await post('/api/queue', { token: a.token, videoId: 'A1video0001', title: 'A1' })).body.queued;
  const qB1 = (await post('/api/queue', { token: b.token, videoId: 'B1video0001', title: 'B1' })).body.queued;
  const qA2 = (await post('/api/queue', { token: a.token, videoId: 'A2video0001', title: 'A2' })).body.queued;
  const qB2 = (await post('/api/queue', { token: b.token, videoId: 'B2video0001', title: 'B2' })).body.queued;

  // First-queued track (A1) is now playing; the queue holds B1, A2, B2.
  // Equal votes (all 0) => fair rotation alternates requesters: B, A, B.
  let snap = await sseSnapshot();
  let order = snap.queue.map((t) => t.title);
  assert.deepEqual(order, ['B1', 'A2', 'B2'], 'equal-vote queue rotates fairly between requesters');

  // Now give A2 a vote (from C, a non-owner). It should jump to the front of
  // the queue (highest votes first).
  const up = await post('/api/upvote', { token: c.token, trackId: qA2.id });
  assert.equal(up.status, 200);
  assert.equal(up.body.voted, true);

  snap = await sseSnapshot();
  order = snap.queue.map((t) => t.title);
  assert.equal(order[0], 'A2', 'a higher-voted track ranks ahead of equal-vote tracks');
  // The vote count is visible on the public track.
  const a2 = snap.queue.find((t) => t.title === 'A2');
  assert.equal(a2.votes, 1, 'vote count surfaces on the public track');
});

// ---------------------------------------------------------------------------
// 4. vote toggle: upvoting the same track twice by the same token is
//    idempotent (on, then off).
// ---------------------------------------------------------------------------
test('vote toggle: double upvote by same token is on-then-off', async () => {
  await openEvent('Vote Toggle Test');
  const owner = (await join()).body;
  const voter = (await join()).body;

  // Owner queues two tracks so one stays in the queue to vote on (the first
  // becomes nowPlaying). Vote on the queued one.
  await post('/api/queue', { token: owner.token, videoId: 'firstvideo01', title: 'First' });
  const target = (await post('/api/queue', { token: owner.token, videoId: 'secondvideo1', title: 'Second' })).body.queued;

  const first = await post('/api/upvote', { token: voter.token, trackId: target.id });
  assert.equal(first.status, 200);
  assert.equal(first.body.voted, true, 'first upvote turns the vote ON');
  assert.equal(first.body.track.votes, 1);

  const second = await post('/api/upvote', { token: voter.token, trackId: target.id });
  assert.equal(second.status, 200);
  assert.equal(second.body.voted, false, 'second upvote by same token turns it OFF');
  assert.equal(second.body.track.votes, 0, 'vote count returns to zero — idempotent toggle');
});

// ---------------------------------------------------------------------------
// 5. spotlight lifecycle: start -> transcript -> end archives a report whose
//    eventId is the OPEN event's id (NOT null).
// ---------------------------------------------------------------------------
test('spotlight lifecycle: archived report carries the open event id', async () => {
  const opened = await openEvent('Spotlight Test');
  const eventId = opened.body.event.id;
  assert.ok(eventId, 'open event has an id');

  const guest = (await join()).body;

  // Spotlight requires the participant to consent to recording. Set the profile
  // with consentRecording true first.
  const prof = await post('/api/profile', {
    token: guest.token,
    projectTitle: 'Smoke Project',
    projectDescription: 'A test project for the smoke harness.',
    consentRecording: true,
    consentResearch: false,
  });
  assert.equal(prof.status, 200);

  const started = await post('/api/spotlight/start', { token: guest.token, kind: 'introduction' });
  assert.equal(started.status, 200, 'spotlight starts for a consenting participant');

  // A report is only archived if it has a transcript — supply one.
  const transcript = await post('/api/spotlight/transcript', {
    token: guest.token,
    transcript: 'We are building a smoke test for the stage server.',
    isFinal: true,
  });
  assert.equal(transcript.status, 200);

  const ended = await post('/api/spotlight/end', { token: guest.token });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.spotlight, null, 'spotlight cleared on end');

  // The archived report must carry the open event's id, not null. Read it from
  // the host reports route and from persisted state (strongest observable).
  const reports = (await get('/api/reports')).body.reports;
  assert.ok(Array.isArray(reports) && reports.length > 0, 'a report was archived');
  const report = reports[0];
  assert.equal(report.eventId, eventId, 'archived report eventId is the open event id, not null');
  assert.notEqual(report.eventId, null);

  const st = readState();
  const persisted = (st.reports || []).find((r) => r.id === report.id);
  assert.ok(persisted, 'report is persisted to disk');
  assert.equal(persisted.eventId, eventId, 'persisted report eventId matches the open event');
});

// ---------------------------------------------------------------------------
// 6. engine wire-protocol contract (ENGINE.md): every payload carries the
//    protocol `version`; the public stream exposes the documented top-level
//    keys and OMITS the private `spotlight`; the show stream includes it.
//    This pins the engine's public API so a frontend (incl. a future webOS
//    app) has an enforced contract, not just prose.
// ---------------------------------------------------------------------------
test('engine contract: versioned payload, documented keys, public/show spotlight split', async () => {
  const { ENGINE_PROTOCOL_VERSION } = require('../config');
  await openEvent('Contract Test'); // populate event so the payload is fully shaped

  const pub = await sseSnapshot('/api/events');

  // The wire is versioned, and the wire version is the engine's constant.
  assert.equal(typeof pub.version, 'number', 'payload carries a numeric protocol version');
  assert.equal(pub.version, ENGINE_PROTOCOL_VERSION, 'wire version matches ENGINE_PROTOCOL_VERSION');

  // Documented top-level keys are all present on the public stream.
  const documented = ['version', 'event', 'nowPlaying', 'queue', 'timer', 'mode', 'announcement', 'visuals', 'visualEvent'];
  for (const key of documented) {
    assert.ok(key in pub, `public payload includes documented key "${key}"`);
  }

  // Privacy contract: the public stream MUST NOT carry the host-only spotlight.
  assert.ok(!('spotlight' in pub), 'public stream omits the private spotlight field');

  // The show stream carries the same shape PLUS spotlight (even when null).
  const show = await sseSnapshot('/api/show-events');
  assert.equal(show.version, ENGINE_PROTOCOL_VERSION, 'show stream is versioned too');
  assert.ok('spotlight' in show, 'show stream includes the spotlight field');

  // CORS: the read stream must be cross-origin readable so an off-origin
  // frontend (native webOS app, separate dashboard) can open it. Without this,
  // the "swappable frontends" contract only works for same-origin pages.
  const acao = await new Promise((resolve, reject) => {
    const http = require('node:http');
    const r = http.get(BASE + '/api/events', (res) => {
      const h = res.headers['access-control-allow-origin'];
      res.destroy();
      resolve(h);
    });
    r.on('error', reject);
    r.setTimeout(5000, () => { r.destroy(); reject(new Error('CORS header probe timeout')); });
  });
  assert.equal(acao, '*', '/api/events must send Access-Control-Allow-Origin:* for off-origin frontends');
});
