// Zero-dep unit tests for reader.js (The Reader — agentic Claude repo read).
//
// Node built-ins ONLY (node:test, node:assert, node:fs/os/path/child_process).
// No live `claude` spawn here — these pin the pure/deterministic logic:
//   - defensive JSON parse (good / garbage / empty / null-finding / fabricated path)
//   - the ANTHROPIC_API_KEY cost-safety assertion (throws when set)
//   - the clean-env allowlist (no process.env secret leaks to the child)
//   - balanced JSON-object extraction (fenced / trailing prose)
//   - path-escape rejection (cited ../.. is dropped)
//   - size-cap short-circuit
//   - temp-dir wipe in finally{} + concurrency decline + non-zero exit → null,
//     driven through runReader with a FAKE claude binary (a shell script) so the
//     real spawn/timeout/reap path runs without the network or a real model.
//
// The on-Pi observation test (a real claude run against a trusted repo) is the
// REAL gate and is run by hand on the Pi — CI cannot run claude.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reader = require('../reader.js');

// ── defensive JSON parse ──────────────────────────────────────────────────────

// A clone dir with a couple of real files so path-validation can pass/fail.
function makeClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-clone-'));
  fs.writeFileSync(path.join(dir, 'server.js'), '// hi\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'worker.js'), '// worker\n');
  return dir;
}

test('parseFinding: a valid envelope with a real cited path returns the finding', () => {
  const clone = makeClone();
  const result = {
    finding: 'Three retry strategies; the queue worker disagrees with the other two.',
    evidence: [{ path: 'src/worker.js', lines: '1-1', why: 'the odd one out' }],
    question: 'Deliberate, or did it predate the pattern?',
    confidence: 'high',
    kind: 'eerie-read',
  };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  const parsed = reader.parseFinding(envelope, clone);
  assert.equal(parsed.kind, 'eerie-read');
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.evidence.length, 1);
  assert.equal(parsed.evidence[0].path, 'src/worker.js');
  fs.rmSync(clone, { recursive: true, force: true });
});

test('parseFinding: garbage stdout → null', () => {
  const clone = makeClone();
  assert.equal(reader.parseFinding('not json at all {{{', clone), null);
  fs.rmSync(clone, { recursive: true, force: true });
});

test('parseFinding: empty stdout → null', () => {
  const clone = makeClone();
  assert.equal(reader.parseFinding('', clone), null);
  assert.equal(reader.parseFinding('   ', clone), null);
  fs.rmSync(clone, { recursive: true, force: true });
});

test('parseFinding: explicit {"finding": null} → {finding:null} (the escape hatch)', () => {
  const clone = makeClone();
  const envelope = JSON.stringify({ result: JSON.stringify({ finding: null }) });
  assert.deepEqual(reader.parseFinding(envelope, clone), { finding: null });
  fs.rmSync(clone, { recursive: true, force: true });
});

test('parseFinding: a finding whose every cited path is fabricated → null (no real anchor)', () => {
  const clone = makeClone();
  const result = {
    finding: 'A finding that cites files that do not exist.',
    evidence: [{ path: 'does/not/exist.js', why: 'fabricated' }],
    confidence: 'reach',
  };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  assert.equal(reader.parseFinding(envelope, clone), null);
  fs.rmSync(clone, { recursive: true, force: true });
});

test('parseFinding: a cited path escaping the clone (../..) is dropped → null', () => {
  const clone = makeClone();
  const result = {
    finding: 'tries to cite outside the clone',
    evidence: [{ path: '../../../etc/passwd', why: 'escape attempt' }],
    confidence: 'reach',
  };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  assert.equal(reader.parseFinding(envelope, clone), null);
  fs.rmSync(clone, { recursive: true, force: true });
});

test('parseFinding: tolerates ```json fences and trailing prose around the object', () => {
  const clone = makeClone();
  const result = {
    finding: 'fenced output still parses',
    evidence: [{ path: 'server.js', why: 'real file' }],
    confidence: 'medium',
  };
  const text = '```json\n' + JSON.stringify(result) + '\n```\nThanks!';
  const envelope = JSON.stringify({ result: text });
  const parsed = reader.parseFinding(envelope, clone);
  assert.equal(parsed.finding, 'fenced output still parses');
  fs.rmSync(clone, { recursive: true, force: true });
});

test('parseFinding: an unknown confidence is clamped to "medium"', () => {
  const clone = makeClone();
  const result = {
    finding: 'x',
    evidence: [{ path: 'server.js', why: 'real' }],
    confidence: 'absolutely-certain',
  };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  assert.equal(reader.parseFinding(envelope, clone).confidence, 'medium');
  fs.rmSync(clone, { recursive: true, force: true });
});

test('parseFinding: evidence is capped at 3 anchors', () => {
  const clone = makeClone();
  const result = {
    finding: 'many anchors',
    evidence: [
      { path: 'server.js', why: 'a' },
      { path: 'src/worker.js', why: 'b' },
      { path: 'server.js', why: 'c' },
      { path: 'src/worker.js', why: 'd' },
    ],
    confidence: 'high',
  };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  assert.equal(reader.parseFinding(envelope, clone).evidence.length, 3);
  fs.rmSync(clone, { recursive: true, force: true });
});

// ── extractJsonObject ─────────────────────────────────────────────────────────

test('extractJsonObject: pulls the first balanced object, ignoring braces in strings', () => {
  const s = 'prefix {"a": "has } brace", "b": {"c": 1}} suffix';
  assert.equal(reader.extractJsonObject(s), '{"a": "has } brace", "b": {"c": 1}}');
});

test('extractJsonObject: no object → null', () => {
  assert.equal(reader.extractJsonObject('no braces here'), null);
});

// ── pathExistsInClone ─────────────────────────────────────────────────────────

test('pathExistsInClone: real file true, escaping path false', () => {
  const clone = makeClone();
  assert.equal(reader.pathExistsInClone(clone, 'server.js'), true);
  assert.equal(reader.pathExistsInClone(clone, 'src/worker.js'), true);
  assert.equal(reader.pathExistsInClone(clone, '../../etc/passwd'), false);
  assert.equal(reader.pathExistsInClone(clone, 'nope.js'), false);
  fs.rmSync(clone, { recursive: true, force: true });
});

// ── the cost-safety assertion (THE footgun) ───────────────────────────────────

test('buildChildEnv: THROWS when ANTHROPIC_API_KEY is set in the server env', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-block';
  try {
    assert.throws(
      () => reader.buildChildEnv('/tmp/h', '/tmp/c', 'oauth-token'),
      /ANTHROPIC_API_KEY/,
    );
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('buildChildEnv: clean allowlist — no process.env secret leaks to the child', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.STAGE_OPENAI_API_KEY = 'sk-openai-secret';
  process.env.STAGE_GITHUB_TOKEN = 'ghp-secret';
  try {
    const env = reader.buildChildEnv('/scratch/home', '/scratch/config', 'oauth-tok');
    assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
    assert.equal(env.HOME, '/scratch/home');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/scratch/config');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-tok');
    // No server secret rode along.
    assert.equal('STAGE_OPENAI_API_KEY' in env, false);
    assert.equal('STAGE_GITHUB_TOKEN' in env, false);
    assert.equal('ANTHROPIC_API_KEY' in env, false);
  } finally {
    delete process.env.STAGE_OPENAI_API_KEY;
    delete process.env.STAGE_GITHUB_TOKEN;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

// ── size cap ──────────────────────────────────────────────────────────────────

test('dirSizeBytes: short-circuits above the cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-size-'));
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2048));
  const total = reader.dirSizeBytes(dir, 1024);
  assert.ok(total > 1024, 'reports over-cap');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dirSizeBytes: ignores the .git dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-git-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'huge'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(dir, 'small.txt'), Buffer.alloc(10));
  assert.equal(reader.dirSizeBytes(dir, 1024 * 1024), 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── safeSegment ───────────────────────────────────────────────────────────────

test('safeSegment: accepts valid handles, rejects traversal/protocol smuggling', () => {
  assert.equal(reader.safeSegment('simonw'), true);
  assert.equal(reader.safeSegment('data-on-the-train'), true);
  assert.equal(reader.safeSegment('a.b_c-1'), true);
  assert.equal(reader.safeSegment('../etc'), false);
  assert.equal(reader.safeSegment('a/b'), false);
  assert.equal(reader.safeSegment('https://evil'), false);
  assert.equal(reader.safeSegment(''), false);
  assert.equal(reader.safeSegment(undefined), false);
});

// ── runReader end-to-end with a FAKE claude binary ────────────────────────────
// We stub `claude` with a shell script and stub git clone via a token file +
// pre-seeded scratch. The real spawn/reap/timeout/wipe paths run for real.

// Build an isolated env so runReader uses our fakes. Returns {scratch, tokenFile,
// fakeBin dir} and a restore() fn.
function withFakeEnv(claudeScript, { slow = false } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-e2e-'));
  const binDir = path.join(sandbox, 'bin');
  fs.mkdirSync(binDir);

  // Fake claude: writes the given JSON envelope to stdout. If slow, sleeps long
  // so the wall-clock timeout fires (and we can observe SIGKILL).
  const claudePath = path.join(binDir, 'claude');
  fs.writeFileSync(claudePath, claudeScript, { mode: 0o755 });

  // Fake git: instead of cloning the network, copy a fixture repo into dest.
  // runReader calls `git clone ... -- <url> <dest>`; dest is the last arg.
  const fixture = path.join(sandbox, 'fixture');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'README.md'), '# fixture\nA tiny repo.\n');
  fs.writeFileSync(path.join(fixture, 'server.js'), '// the load-bearing file\n');
  const gitPath = path.join(binDir, 'git');
  fs.writeFileSync(
    gitPath,
    '#!/bin/sh\n' +
    '# fake git: last arg is the clone dest; copy the fixture into it.\n' +
    'for last in "$@"; do :; done\n' +
    'cp -R "' + fixture + '/." "$last"\n' +
    'exit 0\n',
    { mode: 0o755 },
  );

  const tokenFile = path.join(sandbox, 'reader.local.env');
  fs.writeFileSync(tokenFile, 'CLAUDE_CODE_OAUTH_TOKEN=fake-oauth-token\n', { mode: 0o600 });

  const scratch = path.join(sandbox, 'scratch');

  const saved = {
    PATH: process.env.PATH,
    bin: process.env.STAGE_READER_CLAUDE_BIN,
    token: process.env.STAGE_READER_TOKEN_FILE,
    scratchEnv: process.env.STAGE_READER_SCRATCH,
    timeout: process.env.STAGE_READER_TIMEOUT_MS,
    grace: process.env.STAGE_READER_KILL_GRACE_MS,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PATH = binDir + ':' + process.env.PATH; // our fake git wins
  process.env.STAGE_READER_CLAUDE_BIN = claudePath;
  process.env.STAGE_READER_TOKEN_FILE = tokenFile;
  process.env.STAGE_READER_SCRATCH = scratch;
  if (slow) {
    process.env.STAGE_READER_TIMEOUT_MS = '400';
    process.env.STAGE_READER_KILL_GRACE_MS = '200';
  }

  return {
    sandbox,
    scratch,
    restore() {
      process.env.PATH = saved.PATH;
      for (const [k, v] of [
        ['STAGE_READER_CLAUDE_BIN', saved.bin],
        ['STAGE_READER_TOKEN_FILE', saved.token],
        ['STAGE_READER_SCRATCH', saved.scratchEnv],
        ['STAGE_READER_TIMEOUT_MS', saved.timeout],
        ['STAGE_READER_KILL_GRACE_MS', saved.grace],
        ['ANTHROPIC_API_KEY', saved.apiKey],
      ]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

// Count leftover run dirs under the scratch root (proves the finally{} wipe).
function leftoverRunDirs(scratch) {
  const clones = path.join(scratch, 'clones');
  try {
    return fs.readdirSync(clones).length;
  } catch {
    return 0;
  }
}

test('runReader: happy path returns the parsed finding and wipes the scratch run dir', async () => {
  const result = {
    finding: 'The load-bearing file admits it in a comment.',
    evidence: [{ path: 'server.js', why: 'the comment' }],
    question: 'Deliberate?',
    confidence: 'high',
    kind: 'eerie-read',
  };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  const script = '#!/bin/sh\ncat <<\'EOF\'\n' + envelope + '\nEOF\n';
  const fake = withFakeEnv(script);
  try {
    const out = await reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sp1' });
    assert.equal(out.kind, 'eerie-read');
    assert.equal(out.finding, result.finding);
    assert.equal(leftoverRunDirs(fake.scratch), 0, 'run dir wiped in finally{}');
  } finally {
    fake.restore();
  }
});

test('runReader: non-zero claude exit → {finding:null}, still wipes', async () => {
  const script = '#!/bin/sh\necho "boom" >&2\nexit 3\n';
  const fake = withFakeEnv(script);
  try {
    const out = await reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sp2' });
    assert.deepEqual(out, { finding: null });
    assert.equal(leftoverRunDirs(fake.scratch), 0);
  } finally {
    fake.restore();
  }
});

test('runReader: a slow child is SIGKILLed by the wall clock → null, no zombie, wiped', async () => {
  // Sleep far past the 400ms timeout; trap nothing so SIGTERM/SIGKILL works.
  const script = '#!/bin/sh\nsleep 30\necho late\n';
  const fake = withFakeEnv(script, { slow: true });
  try {
    const start = Date.now();
    const out = await reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sp3' });
    const elapsed = Date.now() - start;
    assert.deepEqual(out, { finding: null });
    assert.ok(elapsed < 5000, `bounded by the wall clock, took ${elapsed}ms`);
    assert.equal(leftoverRunDirs(fake.scratch), 0, 'wiped even on timeout');
  } finally {
    fake.restore();
  }
});

test('runReader: invalid handle/repo → {finding:null} without spawning anything', async () => {
  const fake = withFakeEnv('#!/bin/sh\necho should-not-run\n');
  try {
    assert.deepEqual(await reader.runReader({ handle: '../evil', repo: 'x' }), { finding: null });
    assert.deepEqual(await reader.runReader({ handle: 'ok', repo: 'a/b' }), { finding: null });
  } finally {
    fake.restore();
  }
});

test('runReader: missing token file → {finding:null}', async () => {
  const fake = withFakeEnv('#!/bin/sh\necho nope\n');
  process.env.STAGE_READER_TOKEN_FILE = path.join(fake.sandbox, 'does-not-exist.env');
  try {
    assert.deepEqual(await reader.runReader({ handle: 'simonw', repo: 'datasette' }), { finding: null });
  } finally {
    fake.restore();
  }
});

test('runReader: ANTHROPIC_API_KEY set → THROWS (cost safety), and still wipes scratch', async () => {
  const result = { finding: 'x', evidence: [{ path: 'server.js', why: 'y' }], confidence: 'high' };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  const fake = withFakeEnv('#!/bin/sh\necho \'' + envelope + '\'\n');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-leak';
  try {
    await assert.rejects(
      () => reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sp4' }),
      /ANTHROPIC_API_KEY/,
    );
    assert.equal(leftoverRunDirs(fake.scratch), 0, 'wiped even when the cost assertion throws');
  } finally {
    fake.restore();
  }
});

test('runReader: concurrency 1 — a second concurrent call declines with {finding:null}', async () => {
  // A slow-ish (but completing) claude so the first call is still active when the
  // second fires.
  const result = { finding: 'x', evidence: [{ path: 'server.js', why: 'y' }], confidence: 'high' };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  const script = '#!/bin/sh\nsleep 0.5\ncat <<\'EOF\'\n' + envelope + '\nEOF\n';
  const fake = withFakeEnv(script);
  try {
    const first = reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sp5' });
    // Give the first call time to clone + flip `active` before the second starts.
    await new Promise(r => setTimeout(r, 150));
    const second = await reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sp6' });
    assert.deepEqual(second, { finding: null }, 'second concurrent call declined');
    const firstOut = await first;
    assert.equal(firstOut.kind, 'eerie-read', 'first call still succeeded');
  } finally {
    fake.restore();
  }
});
