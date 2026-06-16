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
function bootOnce(stateFilePath, { expectExit = false } = {}) {
  return new Promise((resolve, reject) => {
    const myPort = bootPort++;
    const c = spawn(process.execPath, [SERVER], {
      env: { ...process.env, STAGE_NO_AUDIO: '1', PORT: String(myPort), STAGE_STATE_FILE: stateFilePath },
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
