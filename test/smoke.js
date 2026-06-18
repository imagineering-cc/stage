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

// ---------------------------------------------------------------------------
// 7. visuals -> broadcast: a guest visual change mutates room state AND fans
//    out on the public SSE stream. This pins the carved state.js -> sse-hub.js
//    path (room holder write + broadcast) that no other test exercises and
//    that the refactor review flagged as the one most likely to silently
//    regress (the `room.visuals` reassigned-scalar must be read fresh by
//    statePayload, not a stale destructured binding).
// ---------------------------------------------------------------------------
test('visuals -> broadcast: a guest visual change fans out over SSE', async () => {
  await openEvent('Visuals Test');
  const g = (await join()).body;

  const res = await post('/api/visuals', { token: g.token, theme: 'nebula', energy: 0.9, complexity: 0.3, hue: 300 });
  assert.equal(res.status, 200, 'visuals update accepted while open');
  assert.equal(res.body.visuals.theme, 'nebula', 'route echoes the new theme');

  // The change must be visible on the PUBLIC SSE stream — i.e. broadcast()
  // re-projected room.visuals through statePayload (the carved seam).
  const snap = await sseSnapshot('/api/events');
  assert.equal(snap.visuals.theme, 'nebula', 'visuals theme change is broadcast over SSE');
  assert.equal(snap.visuals.energy, 0.9, 'visuals energy change is broadcast');
  assert.equal(snap.visuals.hue, 300, 'visuals hue change is broadcast');
  assert.equal(snap.visuals.editedBy, g.name, 'broadcast carries who edited the visuals');
});

// ---------------------------------------------------------------------------
// M5: identity-keyed, rate-limited personal visual pulse.
//   (a) IDENTITY: an accepted gesture carries THIS participant's assigned color
//       (and a bounded `magnitude`) into the broadcast `visualEvent` — the pulse
//       is visibly theirs, not a generic flash.
//   (b) BOUND: a too-soon second pulse from the SAME token is rejected (429) so a
//       guest can't continuously overwrite the shared room canvas. This is the M5
//       "distinct variations without continuous overwriting" invariant, enforced
//       SERVER-SIDE by the per-token GESTURE_COOLDOWN_MS cooldown in /api/gesture.
// Runs on the shared server (default 4s cooldown); two back-to-back HTTP calls are
// well inside the window, so the second is deterministically rejected.
// ---------------------------------------------------------------------------
test('m5 pulse: identity-keyed color reaches the wire; a too-soon second pulse is bounded', async () => {
  await openEvent('Pulse Test');
  const g = (await join()).body;

  // (a) An accepted pulse carries the requester's identity into visualEvent.
  const first = await post('/api/gesture', { token: g.token, type: 'shake', intensity: 0.8 });
  assert.equal(first.status, 200, 'first pulse accepted');
  assert.equal(first.body.visualEvent.color, g.color, 'pulse carries the requester assigned color');
  assert.equal(first.body.visualEvent.requesterName, g.name, 'pulse carries the requester name');
  assert.equal(first.body.visualEvent.magnitude, 0.8, 'pulse carries a bounded server-clamped magnitude');

  // The identity-keyed pulse must reach the PUBLIC SSE wire (visualEvent field).
  const snap = await sseSnapshot('/api/events');
  assert.equal(snap.visualEvent.color, g.color, 'broadcast visualEvent is keyed to the requester color');
  assert.equal(snap.visualEvent.magnitude, 0.8, 'broadcast visualEvent carries the bounded magnitude');

  // (b) BOUND: a second pulse from the same token, inside the cooldown, is rejected.
  const second = await post('/api/gesture', { token: g.token, type: 'shake', intensity: 0.5 });
  assert.equal(second.status, 429, 'a too-soon second pulse is rejected (bounded, not continuous)');
  assert.ok(second.body.retryAfterMs > 0, '429 surfaces a positive retryAfterMs so a frontend can wait');

  // A DIFFERENT participant is NOT throttled by someone else's pulse (per-token).
  const g2 = (await join()).body;
  const other = await post('/api/gesture', { token: g2.token, type: 'shake', intensity: 0.4 });
  assert.equal(other.status, 200, 'the cooldown is per-token: a different guest can still pulse');
  assert.equal(other.body.visualEvent.color, g2.color, 'the second guest pulse is keyed to ITS color');
});

// ---------------------------------------------------------------------------
// M5: the per-token bound RELEASES after the cooldown window. Boots a dedicated
// server with a tiny GESTURE_COOLDOWN_MS so we can prove the same token is
// accepted again once the window elapses — without a multi-second sleep on the
// shared server. Pins the bound as a real cooldown, not a permanent block.
// ---------------------------------------------------------------------------
test('m5 pulse: the per-token cooldown releases after its window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-pulse-'));
  const sf = path.join(dir, 'state.json');
  let boot;
  try {
    boot = await bootOnce(sf, { env: { STAGE_GESTURE_COOLDOWN_MS: '300' } });
    const base = `http://127.0.0.1:${boot.port}`;
    const j = async (p, body) => {
      const r = await fetch(base + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    await j('/api/event/open', { title: 'Pulse Window' });
    const g = (await j('/api/join')).body;

    const a = await j('/api/gesture', { token: g.token, type: 'shake', intensity: 0.6 });
    assert.equal(a.status, 200, 'first pulse accepted');
    const tooSoon = await j('/api/gesture', { token: g.token, type: 'shake', intensity: 0.6 });
    assert.equal(tooSoon.status, 429, 'within the 300ms window: bounded');

    await new Promise((r) => setTimeout(r, 400)); // > cooldown
    const afterWindow = await j('/api/gesture', { token: g.token, type: 'shake', intensity: 0.6 });
    assert.equal(afterWindow.status, 200, 'after the window the same token may pulse again (cooldown, not a permanent block)');
  } finally {
    if (boot) boot.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10 (placed here so the round-trip uses the SHARED server child): every save
// the suite triggered round-trips — what we persisted parses AND passes the
// validator's own gate. The fsync calls in savePersistentState are exercised by
// every save path above; a power-cut can't be simulated in CI, so this pins the
// invariant that normal saves still produce valid, self-consistent state.
// ---------------------------------------------------------------------------
test('fsync durability: persisted state round-trips through its own validator', async () => {
  const { validateStateShape } = require('../state');
  await openEvent('Round Trip Test');
  await join(); // drives createIdentity -> a save

  const parsed = readState();
  assert.ok(parsed && typeof parsed === 'object', 'state file exists and parses');
  assert.doesNotThrow(() => validateStateShape(parsed), 'persisted state passes the write-side gate (round-trip invariant)');
});

// ===========================================================================
// The next two tests need control over the state file AT BOOT, so they spawn
// their OWN short-lived child against a private temp state file (reusing the
// exact spawn recipe from test.before, just with a different STAGE_STATE_FILE).
// ===========================================================================

let bootPort = PORT + 1; // distinct port per short-lived child to avoid collisions

// Spawn server.js against a specific state file. With expectExit:false (default)
// it resolves once /api/config answers; otherwise it resolves on process exit.
function bootOnce(stateFilePath, { expectExit = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const myPort = bootPort++;
    const c = spawn(process.execPath, [SERVER], {
      env: { ...process.env, STAGE_NO_AUDIO: '1', PORT: String(myPort), STAGE_STATE_FILE: stateFilePath, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d.toString(); });
    c.stdout.on('data', () => {});

    if (expectExit) {
      c.on('exit', (code) => resolve({ child: c, stderr, code, port: myPort }));
      return;
    }
    const deadline = Date.now() + 15000;
    (async function waitUp() {
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${myPort}/api/config`);
          if (res.ok) return resolve({ child: c, stderr: () => stderr, port: myPort });
        } catch { /* not up */ }
        if (Date.now() > deadline) {
          c.kill('SIGKILL');
          return reject(new Error(`bootOnce(${stateFilePath}) did not boot within 15s. stderr: ${stderr}`));
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// 8. corrupt-file-on-load is PRESERVED, logged loudly, and NOT overwritten by
//    the first post-boot save. This is the regression lock for the
//    ghost-identity footgun: an unparseable state.json must be quarantined to a
//    sidecar BEFORE the room boots empty, so createIdentity's first save can't
//    atomically destroy the only recoverable copy.
// ---------------------------------------------------------------------------
test('corruption: an unparseable state file is quarantined, logged, and not destroyed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-corrupt-'));
  const sf = path.join(dir, 'state.json');
  const badBlob = '{ this is not json';
  fs.writeFileSync(sf, badBlob);

  let boot;
  try {
    boot = await bootOnce(sf);

    // A sidecar preserving the EXACT bad bytes now exists alongside sf.
    const sidecars = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
    assert.equal(sidecars.length, 1, 'exactly one .corrupt sidecar was created');
    const sidecarPath = path.join(dir, sidecars[0]);
    assert.equal(fs.readFileSync(sidecarPath, 'utf8'), badBlob, 'sidecar holds the original bad bytes byte-for-byte');

    // Loud log on stderr.
    assert.ok(boot.stderr().includes('[STATE CORRUPTION]'), 'corruption is logged loudly');

    // Recovery must NOT overwrite forensics: open an event + join (createIdentity
    // -> the first post-boot save) and confirm sf is now valid JSON while the
    // sidecar STILL holds the original bad bytes.
    const base = `http://127.0.0.1:${boot.port}`;
    const open = await fetch(base + '/api/event/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Recover' }),
    });
    assert.equal(open.status, 200, 'event opens on the recovered (empty) room');
    const joined = await fetch(base + '/api/join', { method: 'POST' });
    assert.equal(joined.status, 200, 'a guest can join the recovered room (drives first save)');

    const recovered = JSON.parse(fs.readFileSync(sf, 'utf8')); // throws if not valid JSON
    assert.ok(Array.isArray(recovered.identities) && recovered.identities.length === 1, 'first save wrote fresh valid state');
    assert.equal(fs.readFileSync(sidecarPath, 'utf8'), badBlob, 'the first save did NOT destroy the corrupt sidecar');
  } finally {
    if (boot && boot.child && !boot.child.killed) boot.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corruption: a missing state file (ENOENT) boots silently with no sidecar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-enoent-'));
  const sf = path.join(dir, 'does-not-exist.json'); // never created

  let boot;
  try {
    boot = await bootOnce(sf);
    // No corruption log for the expected first-boot path.
    assert.ok(!boot.stderr().includes('[STATE CORRUPTION]'), 'ENOENT must not log corruption');
    // No sidecar minted for a file that never existed.
    const sidecars = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.equal(sidecars.length, 0, 'ENOENT mints no .corrupt sidecar');
  } finally {
    if (boot && boot.child && !boot.child.killed) boot.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. malformed-write is rejected LOUDLY. Unit-level against the exported
//    validateStateShape: each bad object (a known-good base with exactly one
//    field corrupted) must throw with a message naming the offending field; the
//    fully-valid base must NOT throw.
// ---------------------------------------------------------------------------
test('validation: validateStateShape rejects each malformed field and accepts a real save shape', () => {
  // Requiring ../state self-loads (it reads STATE_FILE once); point it at a
  // throwaway temp path first so it can't touch the real stage-state.json.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-validate-'));
  process.env.STAGE_STATE_FILE = path.join(dir, 'unit-state.json');
  // Fresh require so config picks up the env (clear any cached copies).
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../state')];
  const { validateStateShape } = require('../state');
  const { normalizeVisuals } = require('../state');

  // A known-good base mirroring exactly what savePersistentState serializes.
  const goodBase = () => ({
    identities: [],
    playHistory: [],
    queue: [],
    reports: [],
    eventsArchive: [],
    lastPlayedRequesterByVotes: { '0': null },
    timer: null,
    sprint: null,
    shareQueue: [],
    event: null,
    mode: 'free-jukebox',
    visuals: normalizeVisuals({}),
  });

  // The valid shape must pass.
  assert.doesNotThrow(() => validateStateShape(goodBase()), 'a real save shape passes the gate');

  // Each corruption must throw, and the message must name the offending field.
  const cases = [
    ['queue', (d) => { d.queue = [{ title: 'no id' }]; }, 'queue'],
    ['identities', (d) => { d.identities = [['tok']]; }, 'identities'],
    ['mode', (d) => { d.mode = 'not-a-mode'; }, 'mode'],
    ['visuals.energy', (d) => { d.visuals = { ...d.visuals, energy: 2 }; }, 'energy'],
    ['visuals.theme', (d) => { d.visuals = { ...d.visuals, theme: 'bogus' }; }, 'theme'],
    ['timer', (d) => { d.timer = {}; }, 'timer'],
    ['lastPlayedRequesterByVotes', (d) => { d.lastPlayedRequesterByVotes = []; }, 'lastPlayedRequesterByVotes'],
    ['eventsArchive', (d) => { d.eventsArchive = [123]; }, 'eventsArchive'],
    // sprint write-side gate proves it rejects the SAME shapes the load side drops
    // (the #808 load/write symmetry for the new persisted field).
    ['sprint missing sessionId/plan', (d) => { d.sprint = { status: 'running', phaseIndex: 0 }; }, 'sprint'],
    ['sprint.plan bad mode', (d) => { d.sprint = { sessionId: 'x', status: 'running', phaseIndex: 0, plan: [{ mode: 'bogus', label: 'x', durationMs: 1000 }], pausedRemainingMs: null }; }, 'plan'],
    // NaN/Infinity are typeof 'number' — the gate must use Number.isFinite or
    // these slip through and re-corrupt on the next reload (adversarial finding).
    ['timer.endsAt NaN', (d) => { d.timer = { id: 't', status: 'running', endsAt: NaN }; }, 'endsAt'],
    ['visuals.energy NaN', (d) => { d.visuals = { ...d.visuals, energy: NaN }; }, 'energy'],
    ['visuals.hue Infinity', (d) => { d.visuals = { ...d.visuals, hue: Infinity }; }, 'hue'],
    // shareQueue (M2) write-side gate proves it rejects the SAME shapes the load
    // side drops (#808 load/write symmetry for the new persisted field).
    ['shareQueue not array', (d) => { d.shareQueue = 'nope'; }, 'shareQueue'],
    ['shareQueue entry missing token', (d) => { d.shareQueue = [{ id: 'a', name: 'n', color: 'c', kind: 'share', projectTitle: '', requestedAt: 1, status: 'requested' }]; }, 'shareQueue'],
    ['shareQueue entry bad status', (d) => { d.shareQueue = [{ id: 'a', token: 't', name: 'n', color: 'c', kind: 'share', projectTitle: '', requestedAt: 1, status: 'finished' }]; }, 'shareQueue'],
  ];
  for (const [label, mutate, field] of cases) {
    const d = goodBase();
    mutate(d);
    assert.throws(
      () => validateStateShape(d),
      (e) => e instanceof Error && e.message.includes(field),
      `corrupting ${label} must throw an error naming "${field}"`,
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 11b. boot sweeps ORPHAN per-pid tmp files but RETAINS the .corrupt sidecars.
//      savePersistentState writes `${STATE_FILE}.${pid}.tmp` then atomically
//      renames; a power-cut in the fsync->rename window strands that .tmp
//      forever. The boot sweep must clear those (matched by `.<digits>.tmp`)
//      WITHOUT touching the `.corrupt-<ts>-<pid>` quarantine sidecars (forensics)
//      or the real state.json. Unit-level against the exported sweep (mirrors the
//      validateStateShape unit test: throwaway STAGE_STATE_FILE + fresh require).
// ---------------------------------------------------------------------------
test('sweep: boot removes orphan .tmp files but keeps .corrupt sidecars and state.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-sweep-'));
  const sf = path.join(dir, 'state.json');
  process.env.STAGE_STATE_FILE = sf;

  // Orphan tmp files from a DIFFERENT (dead) pid — must be swept.
  fs.writeFileSync(`${sf}.99999.tmp`, 'interrupted write 1');
  fs.writeFileSync(`${sf}.12345.tmp`, 'interrupted write 2');
  // A .corrupt-* quarantine sidecar — forensics, must SURVIVE.
  const corruptSidecar = `${sf}.corrupt-1700000000000-4242`;
  fs.writeFileSync(corruptSidecar, 'preserved corrupt bytes');
  // The real state file — must be untouched.
  fs.writeFileSync(sf, JSON.stringify({ identities: [] }));

  // Fresh require so config picks up the throwaway STAGE_STATE_FILE, then call
  // the exported sweep directly (module load already calls it, but calling it
  // explicitly pins the behaviour regardless of load-order timing).
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../state')];
  const { sweepOrphanTmpFiles } = require('../state');
  sweepOrphanTmpFiles();

  assert.ok(!fs.existsSync(`${sf}.99999.tmp`), 'orphan tmp (pid 99999) is swept');
  assert.ok(!fs.existsSync(`${sf}.12345.tmp`), 'orphan tmp (pid 12345) is swept');
  assert.ok(fs.existsSync(corruptSidecar), '.corrupt-* quarantine sidecar is RETAINED');
  assert.equal(fs.readFileSync(corruptSidecar, 'utf8'), 'preserved corrupt bytes', 'sidecar bytes untouched');
  assert.ok(fs.existsSync(sf), 'real state.json is untouched');
  assert.equal(fs.readFileSync(sf, 'utf8'), JSON.stringify({ identities: [] }), 'state.json bytes untouched');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 12. valid-JSON-but-WRONG-TYPE on load is quarantined too. A state file that
//     PARSES to a JSON array (or bare primitive) is corruption: the old loose
//     `typeof === 'object'` test let an array straight through, and its original
//     bytes were destroyed by the first save. This is the MAJOR adversarial
//     finding's regression lock — quarantine must fire on parse-success-wrong-
//     shape, not only on parse-error.
// ---------------------------------------------------------------------------
test('corruption: a valid-JSON array (wrong type) is quarantined, not silently destroyed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-wrongtype-'));
  const sf = path.join(dir, 'state.json');
  const badBlob = JSON.stringify([1, 2, 3, 'important recoverable data']); // parses, but is an array
  fs.writeFileSync(sf, badBlob);

  let boot;
  try {
    boot = await bootOnce(sf);

    const sidecars = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
    assert.equal(sidecars.length, 1, 'a wrong-type (array) file is quarantined to exactly one sidecar');
    const sidecarPath = path.join(dir, sidecars[0]);
    assert.equal(fs.readFileSync(sidecarPath, 'utf8'), badBlob, 'sidecar holds the original array bytes byte-for-byte');
    assert.ok(boot.stderr().includes('[STATE CORRUPTION]'), 'wrong-type corruption is logged loudly');

    // First post-boot save must not destroy the preserved copy.
    const base = `http://127.0.0.1:${boot.port}`;
    await fetch(base + '/api/event/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Recover' }),
    });
    const joined = await fetch(base + '/api/join', { method: 'POST' });
    assert.equal(joined.status, 200, 'a guest can join the recovered room');
    const recovered = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.ok(!Array.isArray(recovered) && typeof recovered === 'object', 'first save wrote a fresh OBJECT-shaped state');
    assert.equal(fs.readFileSync(sidecarPath, 'utf8'), badBlob, 'the first save did NOT destroy the sidecar');
  } finally {
    if (boot && boot.child && !boot.child.killed) boot.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 13. a malformed-but-PARSEABLE timer must NOT crash-loop the appliance. The
//     adversarial BLOCKER: load-side hydration accepted any object as the timer,
//     the write-side gate rejected it, and the gate threw UNCAUGHT out of a route
//     handler -> whole-process crash on the first /api/join -> reboot -> same file
//     -> crash again, forever. Reproduces the exact scenario (open event + a
//     timer:{legacy:true}) and asserts the room stays alive and serving.
// ---------------------------------------------------------------------------
test('resilience: a malformed persisted timer does not crash the room on first join', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-badtimer-'));
  const sf = path.join(dir, 'state.json');
  // Parses fine; event hydrates as OPEN (so /api/join is allowed); the timer is
  // a shape the write-side gate would reject.
  fs.writeFileSync(sf, JSON.stringify({
    identities: [],
    playHistory: [],
    queue: [],
    reports: [],
    eventsArchive: [],
    lastPlayedRequesterByVotes: { '0': null },
    timer: { legacy: true }, // <-- the poison: object but no id/status/endsAt
    event: { id: 'evt-badtimer', title: 'Bad Timer', status: 'open', openedAt: 1, closedAt: null },
    mode: 'free-jukebox',
    visuals: {},
  }));

  let boot;
  try {
    boot = await bootOnce(sf);
    const base = `http://127.0.0.1:${boot.port}`;

    // The exact crash trigger from the finding: a guest join drives createIdentity
    // -> savePersistentState. Before the fix this threw uncaught and killed the
    // process; now the malformed timer is loaded as null, so the save is clean.
    const joined = await fetch(base + '/api/join', { method: 'POST' });
    assert.equal(joined.status, 200, 'join succeeds — the malformed timer did not crash the save');

    // The process is still alive and serving a SECOND request (a crash would make
    // this fetch reject / connection-refuse).
    const still = await fetch(base + '/api/config');
    assert.ok(still.ok, 'server is still up and serving after the join');

    // The poison timer was dropped on load, so persisted state carries timer:null.
    const persisted = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.equal(persisted.timer, null, 'malformed timer was dropped to null, not persisted forward');
  } finally {
    if (boot && boot.child && !boot.child.killed) boot.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sprint-mode helpers. sseSnapshotAt opens the first SSE frame on an arbitrary
// base (the boot children run on their own ports); waitForSprint polls the show
// stream until a predicate over the `sprint` projection holds, or throws.
// ---------------------------------------------------------------------------
function sseSnapshotAt(base, streamPath = '/api/events') {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const r = http.get(base + streamPath, (res) => {
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

async function waitForSprint(pred, { base = BASE, streamPath = '/api/show-events', timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const snap = await sseSnapshotAt(base, streamPath);
    last = snap.sprint;
    if (pred(snap.sprint)) return snap;
    if (Date.now() > deadline) {
      throw new Error(`waitForSprint timed out; last sprint = ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

// ---------------------------------------------------------------------------
// 14. autonomous advance + override + wind-down (shared running child). A phase
//     timer ending must, WITHOUT any human action, run the wind-down ceremony and
//     advance to the next phase (riding the ONE state.js timer, not a parallel
//     sprint timeout). Then exercise the host overrides: skip, pause/resume
//     (round-tripping the one timer), extend, stop, and the double-start guard.
// ---------------------------------------------------------------------------
test('sprint: autonomous advance off the timer-end path + host overrides', async () => {
  await openEvent('Sprint Test');

  // Tiny durations + tiny windDownMs so a full phase + ceremony fits sub-second.
  const r = await post('/api/sprint/start', { durations: [150, 150, 150], windDownMs: 120 });
  assert.equal(r.status, 200);
  assert.equal(r.body.sprint.status, 'running');
  assert.equal(r.body.sprint.phaseIndex, 0);
  assert.equal(r.body.sprint.totalPhases, 3);

  // phase 0 (150ms) ends -> wind-down (120ms) -> autonomous advance to phase 1.
  await waitForSprint((s) => s && s.phaseIndex === 1 && s.status === 'running');

  let snap = await sseSnapshot('/api/events');
  assert.equal(snap.sprint.phaseIndex, 1, 'advanced autonomously off the timer-end path');
  assert.equal(snap.version, 1, 'protocol version stays 1 (additive field)');
  assert.equal(snap.mode, snap.sprint.currentPhase.mode, 'room mode tracks the active phase');
  assert.ok(snap.timer && snap.timer.status === 'running', 'a fresh phase timer was armed on advance');

  // override: skip advances now (full ceremony, just early).
  await post('/api/sprint/skip');
  await waitForSprint((s) => s && s.phaseIndex === 2);

  // pause/resume round-trips through the ONE timer.
  const pz = await post('/api/sprint/pause');
  assert.equal(pz.body.sprint.status, 'paused');
  const badExtend = await post('/api/sprint/extend', { minutes: 5 });
  assert.equal(badExtend.status, 409, 'extend rejected while paused');
  const rs = await post('/api/sprint/resume');
  assert.equal(rs.body.sprint.status, 'running');

  // extend while running succeeds.
  const ex = await post('/api/sprint/extend', { minutes: 1 });
  assert.equal(ex.status, 200);

  // stop returns the room to idle + free-jukebox.
  const stop = await post('/api/sprint/stop');
  assert.equal(stop.body.sprint, null);
  snap = await sseSnapshot('/api/events');
  assert.equal(snap.sprint, null, 'sprint projection is null after stop');
  assert.equal(snap.mode, 'free-jukebox', 'room handed back to the jukebox on stop');

  // double-start guard.
  await post('/api/sprint/start', { durations: [150] });
  const dup = await post('/api/sprint/start', { durations: [150] });
  assert.equal(dup.status, 409, 'a second start while running is a 409');
  await post('/api/sprint/stop');

  // regression: a FINISHED session ('done') must allow an immediate fresh start.
  // The done state holds for DONE_HOLD_MS before clearing to idle; during that
  // window /api/sprint/start previously 409'd with a misleading "already running".
  // Starting now must succeed (clearAllTimers cancels the pending done->idle hold).
  await post('/api/sprint/start', { durations: [120], windDownMs: 80 });
  await waitForSprint((s) => s && s.status === 'done');
  const restart = await post('/api/sprint/start', { durations: [150] });
  assert.equal(restart.status, 200, 'a new sprint starts immediately after one finishes (done state), not 409');
  assert.equal(restart.body.sprint.status, 'running');
  await post('/api/sprint/stop');
});

// ---------------------------------------------------------------------------
// 15. restart-resume mid-sprint. A Pi restart mid-sprint must resume the RIGHT
//     phase with the RIGHT remaining time (no double-advance when the timer is
//     still in the future; catch-up when it already ended while down).
// ---------------------------------------------------------------------------
test('sprint: a restart mid-sprint resumes the right phase (future + past timer)', async () => {
  const plan = [
    { mode: 'sprint-build', label: 'Build 1', durationMs: 60000 },
    { mode: 'sprint-share', label: 'Share 1', durationMs: 60000 },
  ];

  // ---- variant A: timer still in the FUTURE -> resume phase 0, no advance ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-resume-'));
    const sf = path.join(dir, 'state.json');
    const now = Date.now();
    fs.writeFileSync(sf, JSON.stringify({
      identities: [], playHistory: [], queue: [], reports: [], eventsArchive: [],
      lastPlayedRequesterByVotes: { '0': null },
      timer: { id: 't1', label: 'Build 1', durationMs: 60000, startedAt: now - 1000, endsAt: now + 59000, status: 'running' },
      sprint: { sessionId: 's1', plan, phaseIndex: 0, status: 'running', pausedRemainingMs: null },
      event: { id: 'evt-sprint', title: 'Sprint', status: 'open', openedAt: 1, closedAt: null },
      mode: 'sprint-build', visuals: {},
    }));
    let boot;
    try {
      boot = await bootOnce(sf);
      const base = `http://127.0.0.1:${boot.port}`;
      const snap = await sseSnapshotAt(base, '/api/show-events');
      assert.equal(snap.sprint.status, 'running', 'resumed running');
      assert.equal(snap.sprint.phaseIndex, 0, 'resumed the SAME phase (no double-advance)');
      assert.equal(snap.sprint.currentPhase.label, 'Build 1');
      assert.ok(snap.timer, 'the persisted phase timer was re-armed on boot');
    } finally {
      if (boot && boot.child && !boot.child.killed) boot.child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- variant B: timer in the PAST -> phase ended while down -> catch up ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-resume-past-'));
    const sf = path.join(dir, 'state.json');
    const now = Date.now();
    fs.writeFileSync(sf, JSON.stringify({
      identities: [], playHistory: [], queue: [], reports: [], eventsArchive: [],
      lastPlayedRequesterByVotes: { '0': null },
      timer: { id: 't2', label: 'Build 1', durationMs: 60000, startedAt: now - 61000, endsAt: now - 1000, status: 'running' },
      sprint: { sessionId: 's2', plan, phaseIndex: 0, status: 'running', pausedRemainingMs: null },
      event: { id: 'evt-sprint2', title: 'Sprint', status: 'open', openedAt: 1, closedAt: null },
      mode: 'sprint-build', visuals: {},
    }));
    let boot;
    try {
      boot = await bootOnce(sf);
      const base = `http://127.0.0.1:${boot.port}`;
      // The stale phase ended while down: armSprintOnBoot finishes the wind-down
      // (default WIND_DOWN_MS) and advances to phase 1. Poll until it lands.
      await waitForSprint((s) => s && s.phaseIndex === 1, { base, timeoutMs: 60000 });
    } finally {
      if (boot && boot.child && !boot.child.killed) boot.child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// 16. a malformed persisted sprint degrades (no crash), and the wire field is
//     additive + null when idle + version stays 1. Mirrors the test-13 crash-loop
//     lock for the new persisted field.
// ---------------------------------------------------------------------------
test('sprint: a malformed persisted sprint degrades to idle without crashing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-badsprint-'));
  const sf = path.join(dir, 'state.json');
  // Parses fine; event hydrates OPEN (so /api/join is allowed); the sprint is a
  // shape the write-side gate would reject (missing sessionId/plan).
  fs.writeFileSync(sf, JSON.stringify({
    identities: [], playHistory: [], queue: [], reports: [], eventsArchive: [],
    lastPlayedRequesterByVotes: { '0': null },
    timer: null,
    sprint: { status: 'running', phaseIndex: 0 }, // poison: no sessionId/plan
    event: { id: 'evt-badsprint', title: 'Bad Sprint', status: 'open', openedAt: 1, closedAt: null },
    mode: 'free-jukebox', visuals: {},
  }));

  let boot;
  try {
    boot = await bootOnce(sf);
    const base = `http://127.0.0.1:${boot.port}`;

    // A guest join drives createIdentity -> savePersistentState. The malformed
    // sprint must NOT crash the save (it was dropped to null on load).
    const joined = await fetch(base + '/api/join', { method: 'POST' });
    assert.equal(joined.status, 200, 'join succeeds — malformed sprint did not crash the save');
    const still = await fetch(base + '/api/config');
    assert.ok(still.ok, 'server is still up and serving after the join');

    // The poison sprint was dropped on load, so persisted state carries sprint:null.
    const persisted = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.equal(persisted.sprint, null, 'malformed sprint dropped to null, not persisted forward');

    // The wire field is present, additive, null when idle, and version stays 1.
    const snap = await sseSnapshotAt(base, '/api/events');
    assert.equal(snap.version, 1, 'protocol version stays 1');
    assert.ok('sprint' in snap, 'sprint field is present on the public stream');
    assert.equal(snap.sprint, null, 'sprint is null when idle');
  } finally {
    if (boot && boot.child && !boot.child.killed) boot.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// MILESTONE 2 — phone-led share queue. These extend the shared server child.
// Helpers: setConsent drives /api/profile (the only consent surface);
// rawBody fetches a stream's first SSE frame as RAW TEXT (for the leak test —
// a substring search is the strongest "absence-by-design, not by-accident").
// ===========================================================================

async function setConsent(token, { recording = false, research = false, title = 'Project', desc = 'desc' } = {}) {
  return post('/api/profile', {
    token,
    projectTitle: title,
    projectDescription: desc,
    consentRecording: recording,
    consentResearch: research,
  });
}

// Read the first SSE frame as raw text (not parsed) so we can substring-search
// for a token / transcript that must NOT appear.
function rawSseFrame(streamPath) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const r = http.get(BASE + streamPath, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        const i = buf.indexOf('\n\n');
        if (i >= 0) { res.destroy(); resolve(buf.slice(0, i)); }
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    r.setTimeout(5000, () => { r.destroy(); reject(new Error('raw SSE timeout')); });
  });
}

// ---------------------------------------------------------------------------
// M2-1. request -> admit -> ONLY-ADMITTED-streams (the core path + the gate).
// ---------------------------------------------------------------------------
test('share: request, admit, and ONLY the admitted token may stream transcript', async () => {
  await openEvent('Share Core');
  const A = (await join()).body;
  const B = (await join()).body;
  await setConsent(A.token, { recording: true });
  await setConsent(B.token, { recording: true });

  // A requests to share.
  const reqA = await post('/api/share/request', { token: A.token, kind: 'share' });
  assert.equal(reqA.status, 200, 'A can request to present (recording consent set)');
  const idA = reqA.body.id;
  assert.ok(idA, 'request returns an opaque id');

  // Disk has one 'requested' entry for A's token.
  let st = readState();
  assert.equal(st.shareQueue.length, 1, 'one entry persisted');
  assert.equal(st.shareQueue[0].token, A.token);
  assert.equal(st.shareQueue[0].status, 'requested');

  // Public projection shows the entry WITHOUT a token field, WITH the id.
  let pub = await sseSnapshot('/api/events');
  assert.equal(pub.shareQueue.length, 1, 'public stream carries the queue');
  assert.ok(!('token' in pub.shareQueue[0]), 'public entry has NO token field');
  assert.equal(pub.shareQueue[0].id, idA, 'public entry carries the opaque id');

  // B requests too.
  const reqB = await post('/api/share/request', { token: B.token, kind: 'progress' });
  assert.equal(reqB.status, 200);
  st = readState();
  assert.equal(st.shareQueue.length, 2, 'queue now length 2');

  // Host admits A — starts A's spotlight, A's entry -> admitted, public still tokenless.
  const admit = await post('/api/share/admit', { token: A.token });
  assert.equal(admit.status, 200, 'host admits A');
  const show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight.participantToken, A.token, 'A is the spotlight presenter');
  const aEntry = show.shareQueue.find((e) => e.id === idA);
  assert.equal(aEntry.status, 'admitted', "A's entry is admitted");
  assert.equal(aEntry.token, A.token, 'SHOW projection carries the token for host controls');
  pub = await sseSnapshot('/api/events');
  assert.ok(pub.shareQueue.every((e) => !('token' in e)), 'public projection STILL has no token');

  // A streams a transcript — accepted.
  const okT = await post('/api/spotlight/transcript', { token: A.token, transcript: 'hello', isFinal: false });
  assert.equal(okT.status, 200, "admitted A's transcript is accepted");

  // B (NON-ADMITTED) tries to stream — REJECTED 403, transcript uncontaminated.
  const hijack = await post('/api/spotlight/transcript', { token: B.token, transcript: 'hijack' });
  assert.equal(hijack.status, 403, 'a non-admitted token is rejected (403)');
  const show2 = await sseSnapshot('/api/show-events');
  assert.equal(show2.spotlight.transcript, 'hello', "B's hijack did not contaminate the transcript");

  // Missing token -> 401; never-minted token -> 401.
  assert.equal((await post('/api/spotlight/transcript', { transcript: 'x' })).status, 401, 'missing token -> 401');
  assert.equal((await post('/api/spotlight/transcript', { token: 'zzz', transcript: 'x' })).status, 401, 'unknown token -> 401');
});

// ---------------------------------------------------------------------------
// M2-2. correction is a HARD gate on archive: finish before correct -> 409.
// ---------------------------------------------------------------------------
test('share: finish is hard-gated on the correction step', async () => {
  await openEvent('Share Correct');
  const A = (await join()).body;
  await setConsent(A.token, { recording: true, research: false });
  await post('/api/share/request', { token: A.token, kind: 'share' });
  await post('/api/share/admit', { token: A.token });
  await post('/api/spotlight/transcript', { token: A.token, transcript: 'helo wrld', isFinal: false });

  const reportsBefore = (await get('/api/reports')).body.reports.length;

  // Finish before the guest confirms -> 409, NO report archived.
  const early = await post('/api/share/finish', { token: A.token });
  assert.equal(early.status, 409, 'finish before correction is 409');
  assert.equal((await get('/api/reports')).body.reports.length, reportsBefore, 'no report archived early');

  // A confirms the corrected transcript.
  const corr = await post('/api/spotlight/correct', { token: A.token, transcript: 'hello world' });
  assert.equal(corr.status, 200, 'presenter can correct');
  let show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight.transcript, 'hello world', 'corrected text is live');
  assert.equal(show.spotlight.isFinal, true);
  assert.equal(show.spotlight.status, 'corrected');
  const aEntry = show.shareQueue.find((e) => e.token === A.token);
  assert.equal(aEntry.status, 'correcting', "A's entry is now correcting");

  // A different (non-present) token cannot correct.
  const B = (await join()).body;
  await setConsent(B.token, { recording: true });
  assert.equal((await post('/api/spotlight/correct', { token: B.token, transcript: 'x' })).status, 403, 'only the presenter may correct');

  // Now finish succeeds, archives 'hello world' with the right eventId, clears
  // the spotlight, and prunes A's entry.
  const evtId = (await get('/api/event')).body.event.id;
  const fin = await post('/api/share/finish', { token: A.token });
  assert.equal(fin.status, 200, 'finish after correction succeeds');
  const reports = (await get('/api/reports')).body.reports;
  assert.ok(reports.length > reportsBefore, 'a report was archived');
  assert.equal(reports[0].transcript, 'hello world', 'archived transcript is the corrected text');
  assert.equal(reports[0].eventId, evtId, 'archived report carries the open event id');
  show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight, null, 'spotlight cleared on finish');
  assert.ok(!show.shareQueue.some((e) => e.token === A.token), "A's entry pruned (terminal)");
  const st = readState();
  assert.ok(!st.shareQueue.some((e) => e.token === A.token), 'disk shareQueue no longer contains A');
});

// ---------------------------------------------------------------------------
// M2-3. finish/stop re-gate stale tokens; concurrent admit refused.
// ---------------------------------------------------------------------------
test('share: stale tokens re-gated after the turn ends; second concurrent admit refused', async () => {
  await openEvent('Share Stale');
  const A = (await join()).body;
  await setConsent(A.token, { recording: true });
  await post('/api/share/request', { token: A.token, kind: 'share' });
  await post('/api/share/admit', { token: A.token });
  await post('/api/spotlight/correct', { token: A.token, transcript: 'done' });
  await post('/api/share/finish', { token: A.token });

  // After finish, A's transcript POST hits a cleared spotlight -> 409.
  assert.equal((await post('/api/spotlight/transcript', { token: A.token, transcript: 'late' })).status, 409, 'stale token after finish -> 409');

  // New turn: admit B, then STOP (not archived), B re-gated.
  const B = (await join()).body;
  await setConsent(B.token, { recording: true });
  await post('/api/share/request', { token: B.token, kind: 'progress' });
  await post('/api/share/admit', { token: B.token });
  const reportsBefore = (await get('/api/reports')).body.reports.length;
  const stop = await post('/api/share/stop');
  assert.equal(stop.status, 200, 'host stops the live presenter');
  let show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight, null, 'stop clears the spotlight');
  assert.ok(!show.shareQueue.some((e) => e.token === B.token), "B's entry pruned on stop");
  assert.equal((await get('/api/reports')).body.reports.length, reportsBefore, 'stop does NOT archive');
  assert.equal((await post('/api/spotlight/transcript', { token: B.token, transcript: 'x' })).status, 409, 'stopped token -> 409');

  // Second concurrent admit: admit B again, then try to admit C -> 409.
  await post('/api/share/request', { token: B.token, kind: 'share' });
  await post('/api/share/admit', { token: B.token });
  const C = (await join()).body;
  await setConsent(C.token, { recording: true });
  await post('/api/share/request', { token: C.token, kind: 'share' });
  const dup = await post('/api/share/admit', { token: C.token });
  assert.equal(dup.status, 409, 'a second concurrent admit is refused (409)');
  show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight.participantToken, B.token, 'B remains the sole presenter');
  await post('/api/share/stop'); // cleanup
});

// ---------------------------------------------------------------------------
// M2-4. consent is preserved: no recording-consent -> request 409; no research-
//       consent -> finish archives with insights:null (no research run).
// ---------------------------------------------------------------------------
test('share: consent gates are enforced server-side', async () => {
  await openEvent('Share Consent');

  // D has NO recording consent -> request rejected 409.
  const D = (await join()).body;
  await setConsent(D.token, { recording: false });
  assert.equal((await post('/api/share/request', { token: D.token, kind: 'share' })).status, 409, 'no recording consent -> request 409');

  // E has recording but NOT research consent -> finish archives, insights:null.
  const E = (await join()).body;
  await setConsent(E.token, { recording: true, research: false });
  await post('/api/share/request', { token: E.token, kind: 'share' });
  await post('/api/share/admit', { token: E.token });
  await post('/api/spotlight/correct', { token: E.token, transcript: 'no research please' });
  const fin = await post('/api/share/finish', { token: E.token });
  assert.equal(fin.status, 200, 'finish succeeds without research consent');
  const report = (await get('/api/reports')).body.reports[0];
  assert.equal(report.transcript, 'no research please', 'transcript still archived');
  assert.equal(report.insights, null, 'research skipped -> insights null');
});

// ---------------------------------------------------------------------------
// M2-5. public stream leaks NO token and NO transcript; show stream DOES carry
//       both (proving the split is real, not absence-by-accident).
// ---------------------------------------------------------------------------
test('share: public stream leaks no token/transcript; show stream carries both', async () => {
  await openEvent('Share Leak');
  const A = (await join()).body;
  await setConsent(A.token, { recording: true });
  await post('/api/share/request', { token: A.token, kind: 'share' });
  await post('/api/share/admit', { token: A.token });
  await post('/api/spotlight/transcript', { token: A.token, transcript: 'secret transcript words', isFinal: false });

  const pubRaw = await rawSseFrame('/api/events');
  assert.ok(!pubRaw.includes(A.token), 'public stream does NOT contain the presenter token');
  assert.ok(!pubRaw.includes('secret transcript words'), 'public stream does NOT contain the transcript');
  assert.ok(!pubRaw.includes('participantToken'), 'public stream has no participantToken key');
  const pubParsed = JSON.parse(pubRaw.slice('data: '.length));
  assert.ok(pubParsed.shareQueue.every((e) => !('token' in e)), 'no token key in public shareQueue entries');

  const showRaw = await rawSseFrame('/api/show-events');
  assert.ok(showRaw.includes(A.token), 'show stream DOES contain the presenter token');
  assert.ok(showRaw.includes('secret transcript words'), 'show stream DOES contain the transcript');
  await post('/api/share/stop'); // cleanup
});

// ---------------------------------------------------------------------------
// M2-6. wire is additive + version stays 1; all pre-existing top-level fields
//       remain present and unchanged in shape.
// ---------------------------------------------------------------------------
test('share: wire is additive, version stays 1, prior fields intact', async () => {
  await openEvent('Share Wire');
  const pub = await sseSnapshot('/api/events');
  assert.equal(pub.version, 1, 'protocol version stays 1');
  assert.ok(Array.isArray(pub.shareQueue), 'shareQueue is an array');
  for (const key of ['event', 'nowPlaying', 'queue', 'timer', 'mode', 'announcement', 'visuals', 'visualEvent', 'sprint']) {
    assert.ok(key in pub, `pre-existing field "${key}" still present`);
  }
});

// ---------------------------------------------------------------------------
// M2-7. malformed persisted shareQueue degrades (#808): garbage dropped, live
//       states downgraded to 'requested', valid survives, no crash. Non-array -> [].
// ---------------------------------------------------------------------------
test('share: a malformed persisted shareQueue degrades without crashing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-badshare-'));
  const sf = path.join(dir, 'state.json');
  fs.writeFileSync(sf, JSON.stringify({
    identities: [], playHistory: [], queue: [], reports: [], eventsArchive: [],
    lastPlayedRequesterByVotes: { '0': null },
    timer: null, sprint: null,
    shareQueue: [
      { id: 'v1', token: 't-valid', name: 'Valid', color: 'c', kind: 'share', projectTitle: 'P', requestedAt: 1, status: 'requested' },
      { id: 'bad', name: 'NoToken', color: 'c', kind: 'share', projectTitle: '', requestedAt: 1, status: 'requested' }, // garbage: no token
      { id: 'a1', token: 't-admit', name: 'WasLive', color: 'c', kind: 'progress', projectTitle: 'Q', requestedAt: 2, status: 'admitted' }, // downgrade
    ],
    event: { id: 'evt-badshare', title: 'Bad Share', status: 'open', openedAt: 1, closedAt: null },
    mode: 'free-jukebox', visuals: {},
  }));

  let boot;
  try {
    boot = await bootOnce(sf);
    const base = `http://127.0.0.1:${boot.port}`;
    // Server is up and serving (no crash).
    const snap = await sseSnapshotAt(base, '/api/events');
    assert.equal(snap.version, 1);
    // garbage dropped; the live 'admitted' entry downgraded to 'requested'; valid survives.
    const ids = snap.shareQueue.map((e) => e.id).sort();
    assert.deepEqual(ids, ['a1', 'v1'], 'garbage entry dropped; valid + downgraded survive');
    const downgraded = snap.shareQueue.find((e) => e.id === 'a1');
    assert.equal(downgraded.status, 'requested', 'live entry downgraded to requested on boot (no dangling presenter)');
    // room.spotlight is NOT resumed -> no dangling presenter.
    const show = await sseSnapshotAt(base, '/api/show-events');
    assert.equal(show.spotlight, null, 'no spotlight resumed for the downgraded presenter');

    // Trigger a save (join) and confirm the rewritten file passes the gate.
    await fetch(base + '/api/join', { method: 'POST' });
    const persisted = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.equal(persisted.shareQueue.length, 2, 'only well-formed entries persisted');
    assert.ok(persisted.shareQueue.every((e) => ['requested', 'admitted', 'correcting'].includes(e.status)), 'all persisted entries have a non-terminal status');
  } finally {
    if (boot && boot.child && !boot.child.killed) boot.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Separately: a non-array shareQueue degrades to [].
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-badshare2-'));
  const sf2 = path.join(dir2, 'state.json');
  fs.writeFileSync(sf2, JSON.stringify({
    identities: [], playHistory: [], queue: [], reports: [], eventsArchive: [],
    lastPlayedRequesterByVotes: { '0': null },
    timer: null, sprint: null, shareQueue: 'not-an-array',
    event: { id: 'evt-badshare2', title: 'Bad Share 2', status: 'open', openedAt: 1, closedAt: null },
    mode: 'free-jukebox', visuals: {},
  }));
  let boot2;
  try {
    boot2 = await bootOnce(sf2);
    const base = `http://127.0.0.1:${boot2.port}`;
    const snap = await sseSnapshotAt(base, '/api/events');
    assert.deepEqual(snap.shareQueue, [], 'non-array shareQueue degrades to []');
    assert.ok((await fetch(base + '/api/config')).ok, 'server healthy after non-array shareQueue');
  } finally {
    if (boot2 && boot2.child && !boot2.child.killed) boot2.child.kill('SIGKILL');
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M2-8. event boundary clears the queue (open AND close) on disk and on the wire.
// ---------------------------------------------------------------------------
test('share: event boundary clears the queue', async () => {
  await openEvent('Share Boundary');
  const A = (await join()).body;
  await setConsent(A.token, { recording: true });
  await post('/api/share/request', { token: A.token, kind: 'share' });
  assert.equal((await sseSnapshot('/api/events')).shareQueue.length, 1, 'queue has an entry');

  // Close clears it.
  await closeEvent();
  assert.deepEqual((await sseSnapshot('/api/events')).shareQueue, [], 'close clears the queue on the wire');
  assert.deepEqual(readState().shareQueue, [], 'close clears the queue on disk');

  // Open a fresh event: still empty, and a new request does not see old entries.
  await openEvent('Share Boundary 2');
  assert.deepEqual((await sseSnapshot('/api/events')).shareQueue, [], 'fresh event starts with an empty queue');
});

// ---------------------------------------------------------------------------
// M2-regression: the LEGACY host-driven spotlight routes are reconciled with the
// share queue so neither can orphan a queue entry. This is the MAJOR the
// adversarial review found — two host control surfaces (legacy spotlight panel +
// new admit/finish/stop) that did not reconcile.
// ---------------------------------------------------------------------------
test('share: legacy spotlight routes reconcile with the queue (no orphan entries)', async () => {
  await openEvent('Reconcile Test');
  const A = (await join()).body;
  const B = (await join()).body;
  await setConsent(A.token, { recording: true });
  await setConsent(B.token, { recording: true });

  // (1) legacy /api/spotlight/start must NOT silently steal a share-admitted
  //     presenter's spotlight (the single-active invariant now covers it too).
  await post('/api/share/request', { token: A.token, kind: 'share' });
  await post('/api/share/admit', { token: A.token }); // A is the live presenter
  const overwrite = await post('/api/spotlight/start', { token: B.token, kind: 'introduction' });
  assert.equal(overwrite.status, 409, 'legacy start cannot steal an active presenter');
  let show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight.participantToken, A.token, 'A is still the presenter after the blocked legacy start');

  // (2) legacy /api/spotlight/end must PRUNE A's queue entry, not strand it.
  const ended = await post('/api/spotlight/end', { token: A.token });
  assert.equal(ended.status, 200);
  show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight, null, 'spotlight cleared by legacy end');
  assert.ok(!show.shareQueue.some((e) => e.token === A.token), "A's queue entry was pruned, not orphaned");
  assert.ok(!(readState().shareQueue || []).some((e) => e.token === A.token), 'disk queue has no orphaned A');

  // (3) the room is clean afterward: stop with nothing live is a graceful 409.
  const stopClean = await post('/api/share/stop');
  assert.equal(stopClean.status, 409, 'stop with no live presenter is a clean 409, not a crash');
});

// ===========================================================================
// GUARDED-MUTATION API (#11 / task #837). Validation gates the MUTATION, not just
// serialization: a request that would produce invalid persisted state never reaches
// disk or the wire. /api/mode rejects a bad mode with a precise SHOW_MODES pre-check
// (a clean 400 before any mutation) AND routes the valid change through commit() as
// the structural backstop — so this test pins the OBSERVABLE property (bad request ->
// room AND disk unchanged) at the route, while the commit() unit below proves the
// rollback machinery itself. Together they lock the memory/disk divergence #808 left
// open (mutate -> broadcast bad state -> save skipped -> disk keeps last-good -> reboot
// time-travels) shut from both ends.
// ===========================================================================
test('guarded mutation: an invalid /api/mode is rejected at the route, room + disk unchanged', async () => {
  await openEvent('Guarded Mode Test');

  // Establish a known-good mode and confirm it on the wire AND on disk.
  const setGood = await post('/api/mode', { mode: 'sprint-build' });
  assert.equal(setGood.status, 200, 'a valid mode is accepted');
  assert.equal(setGood.body.mode, 'sprint-build');
  assert.equal((await sseSnapshot('/api/events')).mode, 'sprint-build', 'wire reflects the good mode');
  assert.equal(readState().mode, 'sprint-build', 'disk reflects the good mode');

  // The bad request: a mode outside SHOW_MODES. The pre-check returns 400 before any
  // mutation; commit() would also reject + roll back if the pre-check were bypassed
  // (proven by the commit() unit below). Either way: nothing is mutated or broadcast.
  const bad = await post('/api/mode', { mode: 'totally-not-a-mode' });
  assert.equal(bad.status, 400, 'an invalid mode is rejected at the route (400)');

  // THE PROPERTY: room unchanged (wire still shows the good mode) AND disk
  // unchanged (last-good preserved) — the rejected request left both untouched.
  assert.equal((await sseSnapshot('/api/events')).mode, 'sprint-build', 'room mode UNCHANGED after the rejected mutation');
  assert.equal(readState().mode, 'sprint-build', 'disk mode UNCHANGED after the rejected mutation');

  // The success path still works end to end through the same guarded boundary.
  const setGood2 = await post('/api/mode', { mode: 'cool-down' });
  assert.equal(setGood2.status, 200);
  assert.equal((await sseSnapshot('/api/events')).mode, 'cool-down', 'a subsequent valid mode still applies on the wire');
  assert.equal(readState().mode, 'cool-down', 'and persists to disk');
});

// ---------------------------------------------------------------------------
// commit() unit: a mutation whose RESULT is invalid throws, rolls back EVERY
// room-owned field it touched (scalar + container), and leaves the on-disk
// last-good copy byte-for-byte unchanged (no partial/bad write). Mirrors the
// validateStateShape/sweep unit tests: throwaway STAGE_STATE_FILE + fresh require,
// with minimal hooks wired (the composition root's job) so commit() can persist.
// ---------------------------------------------------------------------------
test('guarded mutation: commit() rolls back room AND leaves disk untouched on an invalid result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-commit-'));
  const sf = path.join(dir, 'state.json');
  process.env.STAGE_STATE_FILE = sf;
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../state')];
  const state = require('../state');
  state.wireHooks({
    broadcast() {}, playNext() {}, onTimerEnded() {},
    currentEventId: () => null, getEvent: () => null, getEventsArchive: () => [],
  });

  // A valid commit applies the change, persists it, and returns the mutator result.
  const r = state.commit(() => { state.room.mode = 'cool-down'; return 'sentinel'; });
  assert.equal(r, 'sentinel', 'commit returns the mutator result on success');
  assert.equal(state.room.mode, 'cool-down', 'valid mutation applied to room');
  assert.equal(JSON.parse(fs.readFileSync(sf, 'utf8')).mode, 'cool-down', 'valid mutation persisted to disk');

  // Capture last-good before the bad mutation.
  const diskBefore = fs.readFileSync(sf, 'utf8');
  const modeBefore = state.room.mode;
  const queueLenBefore = state.queue.length;

  // An invalid result: corrupt a SCALAR (mode) AND a CONTAINER (push an id-less
  // track, which validateStateShape rejects). commit must throw and roll back BOTH.
  assert.throws(() => state.commit(() => {
    state.queue.push({ title: 'no id here' });
    state.room.mode = 'bogus-mode';
  }), /STATE VALIDATION/, 'commit throws on a result the persistence gate rejects');

  assert.equal(state.room.mode, modeBefore, 'room.mode scalar rolled back');
  assert.equal(state.queue.length, queueLenBefore, 'queue.push container mutation rolled back');
  assert.equal(fs.readFileSync(sf, 'utf8'), diskBefore, 'disk is byte-for-byte unchanged (no bad write)');

  // Adversarial (cage-match Carnot #4): a mutator that REASSIGNS room.shareQueue to
  // a non-array must be rejected AND the rollback must not throw. A naive
  // `room.shareQueue.splice(...)` would TypeError on the reassigned string, failing
  // the rollback itself; restoreSnapshot repairs the canonical-array alias first.
  const shareRefBefore = state.room.shareQueue; // the exported-const array reference
  assert.throws(
    () => state.commit(() => { state.room.shareQueue = 'not-an-array'; }),
    /shareQueue is not an array/,
    'commit rejects a non-array shareQueue (validateStateShape)',
  );
  assert.ok(Array.isArray(state.room.shareQueue), 'room.shareQueue is a valid array after the reassign-rollback');
  assert.equal(state.room.shareQueue, shareRefBefore, 'rollback restored the canonical shareQueue reference (the exported binding stays stable)');
  assert.equal(fs.readFileSync(sf, 'utf8'), diskBefore, 'disk still byte-for-byte unchanged after the reassign-rollback');

  // A reassigned-scalar field (visuals) rolls back by VALUE. Note the contract
  // asymmetry, both correct per state.js's reference-stability design: reassigned
  // scalars (timer/mode/visuals/sprint) are restored as deep clones (value-equal,
  // importers read room.x fresh), while CONTAINERS (queue/shareQueue/identities)
  // are restored IN PLACE (reference-stable, importers hold the binding).
  const visualsValueBefore = { ...state.room.visuals };
  const queueRefBefore = state.queue;
  assert.throws(
    () => state.commit(() => { state.room.visuals = { theme: 'not-a-real-theme' }; }),
    /visuals\.theme/,
    'commit rejects an invalid visuals theme',
  );
  assert.deepEqual(state.room.visuals, visualsValueBefore, 'room.visuals rolled back by value (reassigned scalar)');
  assert.equal(state.queue, queueRefBefore, 'the exported queue array reference is unchanged across rollback (container, in-place)');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Atomic event lifecycle (#9 / cage-match #20 follow-up). openEvent/closeEvent
// must do exactly ONE durable write so a crash mid-transition can't strand a
// partial state (timer=null + queue cleared on disk while the event is still
// 'open'). The mechanism: they clear the timer IN MEMORY (clearTimerInMemory)
// and let their single final save flush it, instead of clearTimer() which
// self-persists mid-transition. This pins that clearTimerInMemory does NOT touch
// disk while clearTimer() does.
// ---------------------------------------------------------------------------
test('atomic lifecycle: clearTimerInMemory clears room.timer WITHOUT persisting; clearTimer persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-atomictimer-'));
  const sf = path.join(dir, 'state.json');
  process.env.STAGE_STATE_FILE = sf;
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../state')];
  const state = require('../state');
  let broadcasts = 0;
  state.wireHooks({
    broadcast() { broadcasts += 1; }, playNext() {}, onTimerEnded() {},
    currentEventId: () => null, getEvent: () => null, getEventsArchive: () => [],
  });

  // startTimer self-persists: disk gets the timer.
  state.startTimer({ durationMs: 60000, label: 'T' });
  assert.ok(state.room.timer, 'timer set in memory');
  assert.ok(JSON.parse(fs.readFileSync(sf, 'utf8')).timer, 'startTimer persisted the timer to disk');

  // clearTimerInMemory nulls room.timer but must NOT write to disk — disk keeps
  // the timer until the caller's own (later, single) save flushes it.
  state.clearTimerInMemory();
  assert.equal(state.room.timer, null, 'clearTimerInMemory nulled room.timer');
  assert.ok(JSON.parse(fs.readFileSync(sf, 'utf8')).timer, 'disk STILL has the timer — the in-memory clear did NOT persist mid-transition');

  // The caller's single final save flushes the cleared timer atomically.
  state.savePersistentState();
  assert.equal(JSON.parse(fs.readFileSync(sf, 'utf8')).timer, null, 'the caller-owned save flushes the cleared timer');

  // And the public clearTimer() DOES persist on its own (route/sprint contract).
  state.startTimer({ durationMs: 60000, label: 'T2' });
  state.clearTimer();
  assert.equal(state.room.timer, null, 'clearTimer nulled room.timer');
  assert.equal(JSON.parse(fs.readFileSync(sf, 'utf8')).timer, null, 'clearTimer persisted the clear by itself');

  // Broadcast ordering: the in-memory variants must NOT broadcast (so a lifecycle
  // transition emits no partial frame); the public variants DO broadcast.
  state.showAnnouncement({ title: 'x', message: 'y', durationMs: 60000 });
  let b = broadcasts;
  state.clearAnnouncementInMemory();
  assert.equal(state.room.announcement, null, 'clearAnnouncementInMemory nulled the announcement');
  assert.equal(broadcasts, b, 'clearAnnouncementInMemory did NOT broadcast (no mid-transition partial frame)');
  state.showAnnouncement({ title: 'x', message: 'y', durationMs: 60000 });
  b = broadcasts;
  state.clearAnnouncement();
  assert.ok(broadcasts > b, 'public clearAnnouncement DOES broadcast');
  // clearTimerInMemory likewise must not broadcast.
  state.startTimer({ durationMs: 60000, label: 'T3' });
  b = broadcasts;
  state.clearTimerInMemory();
  assert.equal(broadcasts, b, 'clearTimerInMemory did NOT broadcast');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// MILESTONE 3 — Dreamfinder facilitation (Slice 1, backend spine). Autonomous,
// source-grounded, opt-in, host-veto. These extend the shared server child for the
// integration paths (the no-research-consent QUIP path is deterministic + needs no
// network) and add pure unit tests for the shaping helpers (cursor cycle, stable
// sids, verbatim authoredBy) that a live-GitHub fetch can't reliably cover in CI.
// ===========================================================================

// Drive a presenter through request -> admit -> correct (the finalize that triggers
// autonomous facilitation). Returns the presenter token. recording consent always;
// research consent per-arg (false => the deterministic QUIP path, no network).
async function presentTo(correctText, { research = false } = {}) {
  const A = (await join()).body;
  await setConsent(A.token, { recording: true, research });
  await post('/api/share/request', { token: A.token, kind: 'share' });
  await post('/api/share/admit', { token: A.token });
  await post('/api/spotlight/correct', { token: A.token, transcript: correctText });
  return A.token;
}

// Poll the show stream until spotlight.facilitation satisfies pred (or time out).
async function waitForFacilitation(pred, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const snap = await sseSnapshot('/api/show-events');
    last = snap.spotlight ? snap.spotlight.facilitation : null;
    if (pred(last, snap)) return last;
    if (Date.now() > deadline) throw new Error(`waitForFacilitation timed out; last = ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

// ---------------------------------------------------------------------------
// M3-1. facilitation starts null on the show stream and is ABSENT on the public
//       stream; version stays 1 (additive, show-stream-only, nested in spotlight).
// ---------------------------------------------------------------------------
test('m3: facilitation is show-stream-only and starts null; public stream unchanged; version 1', async () => {
  await openEvent('M3 Wire');
  const A = (await join()).body;
  await setConsent(A.token, { recording: true });
  await post('/api/share/request', { token: A.token, kind: 'share' });
  await post('/api/share/admit', { token: A.token });

  // SHOW stream: spotlight present, facilitation null before any generation.
  const show = await sseSnapshot('/api/show-events');
  assert.equal(show.version, 1, 'protocol version stays 1');
  assert.ok('facilitation' in show.spotlight, 'spotlight always carries a facilitation key');
  assert.equal(show.spotlight.facilitation, null, 'facilitation starts null');

  // PUBLIC stream: NO spotlight at all (so certainly no facilitation) — byte-clean.
  const pubRaw = await rawSseFrame('/api/events');
  assert.ok(!pubRaw.includes('"spotlight"'), 'public stream omits spotlight entirely');
  assert.ok(!pubRaw.includes('facilitation'), 'public stream never mentions facilitation');
  const pub = JSON.parse(pubRaw.slice('data: '.length));
  assert.equal(pub.version, 1, 'public version stays 1');
  for (const key of ['event', 'nowPlaying', 'queue', 'timer', 'mode', 'announcement', 'visuals', 'visualEvent', 'sprint', 'shareQueue']) {
    assert.ok(key in pub, `pre-existing public field "${key}" still present (no-op on current room)`);
  }
  await post('/api/share/stop');
});

// ---------------------------------------------------------------------------
// M3-2. AUTONOMOUS reach to 'asked' with NO host action; no-research-consent
//       yields a QUIP candidate (kind:'quip', authoredBy:'dreamfinder-quip').
// ---------------------------------------------------------------------------
test('m3: facilitation reaches asked autonomously; no-repo path yields a quip', async () => {
  await openEvent('M3 Autonomous');
  // research:false -> the no-repo QUIP branch -> deterministic, no network.
  const token = await presentTo('here is my final report', { research: false });

  // No host call here — generation fires off /api/spotlight/correct.
  const fac = await waitForFacilitation((f) => f && f.status === 'asked');
  assert.equal(fac.status, 'asked', 'facilitation advanced to asked WITHOUT a host action');
  assert.ok(fac.asked, 'the asked candidate is frozen on the facilitation');
  assert.equal(fac.candidate.kind, 'quip', 'no research consent -> quip candidate');
  assert.equal(fac.candidate.authoredBy, 'dreamfinder-quip', 'quip authoredBy flag');
  assert.ok(typeof fac.candidate.quip === 'string' && fac.candidate.quip.length > 0, 'quip text present');
  assert.ok(!('primaryQuestion' in fac.candidate), 'a quip carries no grounded question');
  assert.equal(fac.askedAt && typeof fac.askedAt, 'number', 'askedAt stamped');

  await post('/api/share/stop', { token });
});

// ---------------------------------------------------------------------------
// M3-3. host VETO: dismiss -> dismissed (any status); 409 when nothing to dismiss.
// ---------------------------------------------------------------------------
test('m3: dismiss transitions to dismissed; proper 409s', async () => {
  await openEvent('M3 Dismiss');

  // 409 with no live spotlight.
  assert.equal((await post('/api/spotlight/facilitation/dismiss')).status, 409, 'dismiss with no spotlight -> 409');

  const token = await presentTo('report for dismiss', { research: false });
  await waitForFacilitation((f) => f && f.status === 'asked');

  const dis = await post('/api/spotlight/facilitation/dismiss');
  assert.equal(dis.status, 200, 'dismiss succeeds');
  assert.equal(dis.body.facilitation.status, 'dismissed', 'facilitation is now dismissed');
  const show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight.facilitation.status, 'dismissed', 'dismissed visible on the show stream');

  await post('/api/share/stop', { token });
});

// ---------------------------------------------------------------------------
// M3-4. 'another' on a QUIP facilitation (no grounded questions, set exhausted)
//       triggers a rate-limited RE-SEARCH (202), and a second immediate call is
//       throttled (429). (Cursor-cycle-without-refetch over a multi-question set is
//       covered in the pure unit test below, since it needs a grounded insights.)
// ---------------------------------------------------------------------------
test('m3: another on an exhausted set re-searches (202) and is rate-limited (429)', async () => {
  await openEvent('M3 Another');

  assert.equal((await post('/api/spotlight/facilitation/another')).status, 409, 'another with no spotlight -> 409');

  const token = await presentTo('report for another', { research: false });
  await waitForFacilitation((f) => f && f.status === 'asked');

  // Quip has no grounded question set -> 'another' must re-search (202), throttled.
  const first = await post('/api/spotlight/facilitation/another');
  assert.equal(first.status, 202, 'another with an exhausted set kicks off a re-search (202)');
  const second = await post('/api/spotlight/facilitation/another');
  assert.equal(second.status, 429, 'an immediate second re-search is rate-limited (429)');

  await post('/api/share/stop', { token });
});

// ---------------------------------------------------------------------------
// M3-5. /api/share/finish does NOT re-run the search (the decouple). With research
//       consent, developFacilitation runs ONCE off correct and stamps insights.
//       searchedAt; finish must archive that SAME insights without re-searching, so
//       the archived searchedAt is unchanged. (Network-independent: the research
//       pipeline always stamps searchedAt even when every fetch yields nothing.)
// ---------------------------------------------------------------------------
test('m3: finish archives existing facilitation and does NOT re-run the search', async () => {
  await openEvent('M3 Decouple');
  // research:true so the pipeline runs once on correct and stamps insights.searchedAt
  // (a non-existent handle => fetches fail/empty => quip fallback, but insights is
  // still built+stamped; we assert the timestamp doesn't move across finish).
  const A = (await join()).body;
  await setConsent(A.token, { recording: true, research: true, title: 'Decouple Project' });
  await post('/api/share/request', { token: A.token, kind: 'share' });
  await post('/api/share/admit', { token: A.token });
  await post('/api/spotlight/correct', { token: A.token, transcript: 'final decouple report' });

  // Wait for the autonomous generation to settle to 'asked'.
  await waitForFacilitation((f) => f && f.status === 'asked', { timeoutMs: 40000 });
  const showA = await sseSnapshot('/api/show-events');
  const searchedAtAtCorrect = showA.spotlight.insights ? showA.spotlight.insights.searchedAt : null;

  const reportsBefore = (await get('/api/reports')).body.reports.length;
  const fin = await post('/api/share/finish', { token: A.token });
  assert.equal(fin.status, 200, 'finish succeeds');
  const reports = (await get('/api/reports')).body.reports;
  assert.equal(reports.length, reportsBefore + 1, 'exactly one report archived (no born-and-destroyed)');
  const report = reports[0];
  // The decouple proof: finish did NOT re-search, so the archived insights.searchedAt
  // is the SAME timestamp generation stamped at correct-time (a re-search would move it).
  if (searchedAtAtCorrect != null) {
    assert.equal(report.insights && report.insights.searchedAt, searchedAtAtCorrect,
      'archived insights.searchedAt is unchanged — finish did NOT re-run the search');
  }
  // The asked facilitation rides into the archive (additive reports[] field).
  assert.ok('facilitation' in report, 'archived report carries a facilitation field');
});

// ---------------------------------------------------------------------------
// M3-6. PURE shaping helpers: shapeFacilitation cursor-cycles over the retrieved
//       set WITHOUT re-fetching, assigns STABLE sids, derives evidenceIds, and
//       carries authoredBy verbatim. assignSids dedupes by url + caps + stamps.
// ---------------------------------------------------------------------------
test('m3: shapeFacilitation/assignSids/buildQuipCandidate are pure and stable', () => {
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../state')];
  delete require.cache[require.resolve('../research')];
  const research = require('../research');

  // assignSids: dedupe by url, cap, stable s0..sN.
  const sided = research.assignSids([
    { title: 'A', url: 'https://x/a', kind: 'github-source' },
    { title: 'dup', url: 'https://x/a', kind: 'github' }, // same url -> dropped
    { title: 'B', url: 'https://x/b', kind: 'arxiv' },
  ]);
  assert.deepEqual(sided.map((s) => s.sid), ['s0', 's1'], 'sids are stable s0..sN, deduped by url');
  assert.equal(sided.length, 2, 'duplicate url dropped');

  // A grounded insights object with multiple questions + sids (as developSpotlight
  // Insights would have stamped them) and a model authoredBy to carry verbatim.
  const insights = {
    questions: ['What is the smallest test for foo?', 'Which assumption about bar to invalidate?', 'Who tackled foo nearby?'],
    connections: ['c1', 'c2', 'c3'],
    sources: sided,
    authoredBy: 'openai:gpt-test',
    terms: ['foo', 'bar'],
    projectTitle: 'Foo Project',
  };

  const c0 = research.shapeFacilitation(insights, 0);
  assert.equal(c0.kind, 'grounded', 'grounded candidate');
  assert.equal(c0.primaryQuestion, insights.questions[0], 'cursor 0 -> first question');
  assert.deepEqual(c0.connections, ['c1', 'c2'], 'connections capped at two');
  assert.equal(c0.authoredBy, 'openai:gpt-test', 'authoredBy carried VERBATIM from insights');
  assert.ok(c0.interpretation && typeof c0.interpretation === 'string', 'interpretation present and non-empty');
  assert.ok(c0.citations.every((c) => typeof c.sid === 'string' && 'host' in c), 'citations carry sid + host');

  // Cursor advance WITHOUT re-fetch: same insights, different cursor -> next question,
  // and the SAME stable sids (citations identical) — proving the rotation is pure.
  const c1 = research.shapeFacilitation(insights, 1);
  assert.equal(c1.primaryQuestion, insights.questions[1], 'cursor 1 -> second question (no re-fetch)');
  assert.deepEqual(c1.citations.map((c) => c.sid), c0.citations.map((c) => c.sid), 'citations sids identical across cursor (stable, built once)');

  // Cursor wraps modulo the set length.
  const c3 = research.shapeFacilitation(insights, 3);
  assert.equal(c3.primaryQuestion, insights.questions[0], 'cursor wraps modulo question count');

  // No questions -> null (caller falls back to quip).
  assert.equal(research.shapeFacilitation({ questions: [], sources: [] }, 0), null, 'no questions -> null');

  // buildQuipCandidate: kind:'quip', authoredBy flag, name interpolated, no question.
  const quip = research.buildQuipCandidate('@octocat');
  assert.equal(quip.kind, 'quip');
  assert.equal(quip.authoredBy, 'dreamfinder-quip');
  assert.ok(quip.quip.includes('octocat') || !quip.quip.includes('{name}'), 'quip interpolates the handle (no raw {name})');
  assert.ok(!('primaryQuestion' in quip), 'quip has no grounded question');

  // buildInterpretation is deterministic for the same inputs.
  const i1 = research.buildInterpretation('foo', 'Foo Project', 2);
  const i2 = research.buildInterpretation('foo', 'Foo Project', 2);
  assert.equal(i1, i2, 'buildInterpretation is deterministic');
  assert.notEqual(research.buildInterpretation('foo', 'Foo', 0), research.buildInterpretation('foo', 'Foo', 1),
    'interpretation differs when source was read vs not');
});

// ---------------------------------------------------------------------------
// M3-7 (cage-match Carnot finding): a host VETO that lands MID-RESEARCH must be
// DURABLE — developFacilitation must NOT overwrite a 'dismissed' status with
// 'asked' when it completes. Uses research:true so the pipeline takes a real
// (network) moment, dismisses while status==='research', then asserts the final
// state stays dismissed. The spotlightId guard alone can't catch this (same
// spotlight, different status), so this pins the explicit status re-check.
// ---------------------------------------------------------------------------
test('m3: a dismiss during research is durable (not overwritten by the completing generation)', async () => {
  await openEvent('M3 Dismiss Race');
  const A = (await join()).body;
  await setConsent(A.token, { recording: true, research: true, title: 'Race Project' });
  await post('/api/share/request', { token: A.token, kind: 'share' });
  await post('/api/share/admit', { token: A.token });
  // correct triggers autonomous generation; with research consent it goes through
  // the (network) research pipeline, so there's a real 'research' window.
  await post('/api/spotlight/correct', { token: A.token, transcript: 'race report' });

  // Dismiss immediately — likely while status==='research'. Even if generation has
  // already reached 'asked', dismiss-any->dismissed still applies; the assertion is
  // that the FINAL state is dismissed regardless of the in-flight generation.
  const dis = await post('/api/spotlight/facilitation/dismiss');
  assert.equal(dis.status, 200, 'dismiss accepted');
  assert.equal(dis.body.facilitation.status, 'dismissed', 'dismissed immediately');

  // Give any in-flight generation ample time to (try to) complete and overwrite.
  await new Promise((r) => setTimeout(r, 4000));
  const show = await sseSnapshot('/api/show-events');
  assert.equal(show.spotlight.facilitation.status, 'dismissed',
    'the completing generation did NOT resurrect the question over the host veto');

  await post('/api/share/stop', { token: A.token });
});
