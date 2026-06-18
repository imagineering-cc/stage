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

// ── Slice 8: the OS-sandbox spawn-path selection (STAGE_READER_SANDBOX) ───────
// buildSpawn is the pure selector between DIRECT (spawn claude as-is) and
// SANDBOX (spawn `sudo <wrapper> <cloneDir> -- claude ...`). We pin the argv
// shape + env minimalism in both modes WITHOUT a live spawn.

test('buildSpawn: DIRECT mode (flag unset) spawns claude with cwd + childEnv', () => {
  const saved = process.env.STAGE_READER_SANDBOX;
  delete process.env.STAGE_READER_SANDBOX;
  process.env.STAGE_READER_CLAUDE_BIN = '/opt/claude';
  try {
    const childEnv = { HOME: '/h', PATH: '/bin' };
    const s = reader.buildSpawn('/var/lib/stage-reader/clones/run1/clone', childEnv);
    assert.equal(s.command, '/opt/claude');
    assert.equal(s.unit, null);
    assert.equal(s.spawnOpts.cwd, '/var/lib/stage-reader/clones/run1/clone');
    assert.deepEqual(s.spawnOpts.env, childEnv);
    // The read-only tool restrictions are present.
    assert.ok(s.args.includes('--allowedTools'));
    assert.ok(s.args.includes('--disallowedTools'));
    assert.ok(!s.args.includes('--bare'), 'never --bare (would prefer the API key)');
  } finally {
    delete process.env.STAGE_READER_CLAUDE_BIN;
    if (saved === undefined) delete process.env.STAGE_READER_SANDBOX;
    else process.env.STAGE_READER_SANDBOX = saved;
  }
});

test('buildSpawn: SANDBOX mode routes through `sudo -n <wrapper> <cloneDir> -- claude ...`', () => {
  const savedFlag = process.env.STAGE_READER_SANDBOX;
  const savedWrap = process.env.STAGE_READER_WRAPPER;
  const savedSudo = process.env.STAGE_READER_SUDO_BIN;
  const savedBin = process.env.STAGE_READER_CLAUDE_BIN;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.STAGE_READER_SANDBOX = '1';
  process.env.STAGE_READER_WRAPPER = '/usr/local/sbin/stage-reader-run';
  process.env.STAGE_READER_SUDO_BIN = 'sudo';
  process.env.STAGE_READER_CLAUDE_BIN = 'claude';
  try {
    const cloneDir = '/var/lib/stage-reader/clones/run42/clone';
    const s = reader.buildSpawn(cloneDir, { HOME: '/nick/scratch', CLAUDE_CODE_OAUTH_TOKEN: 'nick-secret' });
    assert.equal(s.command, 'sudo');
    // sudo -n (non-interactive), then the wrapper, the clone dir, the -- sep,
    // then the claude argv.
    assert.equal(s.args[0], '-n');
    assert.equal(s.args[1], '/usr/local/sbin/stage-reader-run');
    assert.equal(s.args[2], cloneDir);
    assert.equal(s.args[3], '--');
    assert.equal(s.args[4], 'claude');
    assert.ok(s.args.includes('--allowedTools'), 'claude tool restrictions still passed verbatim');
    // The transient unit name is deterministic off the clone basename.
    assert.equal(s.unit, 'stage-reader-clone');
    // Critically: nick's childEnv / OAuth token is NOT handed to sudo. Only a
    // minimal PATH rides along, and NEVER an API key.
    assert.deepEqual(Object.keys(s.spawnOpts.env), ['PATH']);
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in s.spawnOpts.env, false, 'no token through sudo');
    assert.equal('ANTHROPIC_API_KEY' in s.spawnOpts.env, false);
    assert.equal(s.spawnOpts.cwd, undefined, 'cwd set inside the cage by the wrapper, not by sudo');
  } finally {
    for (const [k, v] of [
      ['STAGE_READER_SANDBOX', savedFlag],
      ['STAGE_READER_WRAPPER', savedWrap],
      ['STAGE_READER_SUDO_BIN', savedSudo],
      ['STAGE_READER_CLAUDE_BIN', savedBin],
      ['ANTHROPIC_API_KEY', savedKey],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('runReader: SANDBOX mode invokes the wrapper via a FAKE sudo and parses its finding', async () => {
  // End-to-end through runReader with STAGE_READER_SANDBOX=1, a FAKE `sudo` that
  // stands in for the whole sudo→wrapper→systemd-run→claude chain: it just
  // verifies it was called as `sudo -n <wrapper> <cloneDir> -- claude ...` and
  // emits the claude JSON envelope. This proves the production code path SELECTS
  // and SHAPES the sandboxed invocation correctly (the real OS confinement is an
  // on-Pi gate, per ops/reader-sandbox.md — CI cannot sudo).
  const result = {
    finding: 'sandboxed read still produces a finding',
    evidence: [{ path: 'server.js', why: 'real file in the fixture' }],
    question: 'Deliberate?',
    confidence: 'high',
    kind: 'eerie-read',
  };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  // No token file needed in sandbox mode — runReader skips the nick-side token.
  const fake = withFakeEnv('#!/bin/sh\necho "fake claude should not be called directly in sandbox mode" >&2\nexit 99\n');
  // Fake sudo: assert the argv shape, then emit the envelope as if claude ran.
  const fakeSudo = path.join(fake.sandbox, 'bin', 'sudo');
  fs.writeFileSync(
    fakeSudo,
    '#!/bin/sh\n' +
    '# expected: sudo -n <wrapper> <cloneDir> -- claude ...\n' +
    '[ "$1" = "-n" ] || { echo "missing -n" >&2; exit 2; }\n' +
    'case "$2" in */stage-reader-run) : ;; *) echo "bad wrapper: $2" >&2; exit 2 ;; esac\n' +
    'case "$3" in */clone) : ;; *) echo "bad clonedir: $3" >&2; exit 2 ;; esac\n' +
    '[ "$4" = "--" ] || { echo "missing --" >&2; exit 2; }\n' +
    'cat <<\'EOF\'\n' + envelope + '\nEOF\n',
    { mode: 0o755 },
  );
  const savedFlag = process.env.STAGE_READER_SANDBOX;
  const savedWrap = process.env.STAGE_READER_WRAPPER;
  const savedSudo = process.env.STAGE_READER_SUDO_BIN;
  process.env.STAGE_READER_SANDBOX = '1';
  process.env.STAGE_READER_WRAPPER = '/usr/local/sbin/stage-reader-run';
  process.env.STAGE_READER_SUDO_BIN = fakeSudo;
  try {
    const out = await reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sb1' });
    assert.equal(out.kind, 'eerie-read', 'sandbox path produced the finding');
    assert.equal(out.finding, result.finding);
    assert.equal(leftoverRunDirs(fake.scratch), 0, 'scratch wiped on the sandbox path too');
  } finally {
    for (const [k, v] of [
      ['STAGE_READER_SANDBOX', savedFlag],
      ['STAGE_READER_WRAPPER', savedWrap],
      ['STAGE_READER_SUDO_BIN', savedSudo],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fake.restore();
  }
});

test('runReader: SANDBOX mode does NOT require nick-side OAuth token (stage-reader owns auth)', async () => {
  const result = { finding: 'x', evidence: [{ path: 'server.js', why: 'y' }], confidence: 'high', kind: 'eerie-read' };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  const fake = withFakeEnv('#!/bin/sh\nexit 99\n');
  const fakeSudo = path.join(fake.sandbox, 'bin', 'sudo');
  fs.writeFileSync(fakeSudo, '#!/bin/sh\ncat <<\'EOF\'\n' + envelope + '\nEOF\n', { mode: 0o755 });
  const savedFlag = process.env.STAGE_READER_SANDBOX;
  const savedSudo = process.env.STAGE_READER_SUDO_BIN;
  process.env.STAGE_READER_SANDBOX = '1';
  process.env.STAGE_READER_SUDO_BIN = fakeSudo;
  // Point the token file at a NON-EXISTENT path: in direct mode this aborts, but
  // sandbox mode must not require it.
  process.env.STAGE_READER_TOKEN_FILE = path.join(fake.sandbox, 'no-such-token.env');
  try {
    const out = await reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sb2' });
    assert.equal(out.kind, 'eerie-read', 'sandbox run succeeds without nick-side token');
  } finally {
    for (const [k, v] of [
      ['STAGE_READER_SANDBOX', savedFlag],
      ['STAGE_READER_SUDO_BIN', savedSudo],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fake.restore();
  }
});

test('runReader: SANDBOX mode STILL hard-aborts on ANTHROPIC_API_KEY (cost safety survives)', async () => {
  const fake = withFakeEnv('#!/bin/sh\nexit 99\n');
  const fakeSudo = path.join(fake.sandbox, 'bin', 'sudo');
  fs.writeFileSync(fakeSudo, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
  const savedFlag = process.env.STAGE_READER_SANDBOX;
  const savedSudo = process.env.STAGE_READER_SUDO_BIN;
  process.env.STAGE_READER_SANDBOX = '1';
  process.env.STAGE_READER_SUDO_BIN = fakeSudo;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-leak';
  try {
    await assert.rejects(
      () => reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sb3' }),
      /ANTHROPIC_API_KEY/,
      'the cost-safety assertion is mode-independent',
    );
    assert.equal(leftoverRunDirs(fake.scratch), 0, 'wiped even on the sandbox cost-abort');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    for (const [k, v] of [
      ['STAGE_READER_SANDBOX', savedFlag],
      ['STAGE_READER_SUDO_BIN', savedSudo],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fake.restore();
  }
});
