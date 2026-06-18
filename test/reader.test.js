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
    unsafeDirect: process.env.STAGE_READER_UNSAFE_DIRECT,
  };
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PATH = binDir + ':' + process.env.PATH; // our fake git wins
  process.env.STAGE_READER_CLAUDE_BIN = claudePath;
  process.env.STAGE_READER_TOKEN_FILE = tokenFile;
  process.env.STAGE_READER_SCRATCH = scratch;
  // The OS sandbox is ON BY DEFAULT (fail-safe, FIX F). These fake-binary tests
  // exercise the DIRECT spawn path, so opt OUT explicitly — the same way CI does
  // (no sandbox installed). Sandbox-path tests below delete this var to re-enable
  // the cage and point at a fake sudo/wrapper.
  process.env.STAGE_READER_UNSAFE_DIRECT = '1';
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
        ['STAGE_READER_UNSAFE_DIRECT', saved.unsafeDirect],
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

// ── Slice 8: the OS-sandbox spawn-path selection (fail-safe polarity) ─────────
// buildSpawn is the pure selector between SANDBOX (default) and DIRECT
// (STAGE_READER_UNSAFE_DIRECT=1). In sandbox mode the command is PINNED in the
// wrapper, so reader.js passes ONLY `sudo -n <wrapper> <cloneDir>` and pipes the
// prompt via stdin (FIX B). The gate is FAIL-SAFE (FIX F): default → cage.

// Helper: run buildSpawn under a clean env, restoring afterward.
function withSpawnEnv(env, fn) {
  const keys = ['STAGE_READER_UNSAFE_DIRECT', 'STAGE_READER_WRAPPER', 'STAGE_READER_SUDO_BIN', 'STAGE_READER_CLAUDE_BIN', 'ANTHROPIC_API_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('buildSpawn: FAIL-SAFE — default (no env) selects the SANDBOX cage, not direct', () => {
  withSpawnEnv({ STAGE_READER_WRAPPER: '/usr/local/sbin/stage-reader-run' }, () => {
    const s = reader.buildSpawn('/var/lib/stage-reader/clones/run1/clone', { HOME: '/h' });
    // Default = sandbox: the command is sudo, NOT claude. A forgotten flag must
    // fail SAFE (run the cage), never silently spawn claude unconfined.
    assert.equal(s.command, 'sudo', 'default must be the cage');
    // UNIQUE per run: derived from the RUN dir (parent of clone), not "clone".
    assert.equal(s.unit, 'stage-reader-run1');
  });
});

test('buildSpawn: DIRECT mode (STAGE_READER_UNSAFE_DIRECT=1) spawns claude with cwd + childEnv', () => {
  withSpawnEnv({ STAGE_READER_UNSAFE_DIRECT: '1', STAGE_READER_CLAUDE_BIN: '/opt/claude' }, () => {
    const childEnv = { HOME: '/h', PATH: '/bin' };
    const s = reader.buildSpawn('/var/lib/stage-reader/clones/run1/clone', childEnv);
    assert.equal(s.command, '/opt/claude');
    assert.equal(s.unit, null);
    assert.equal(s.stdinPrompt, null, 'direct mode passes prompt as argv, not stdin');
    assert.equal(s.spawnOpts.cwd, '/var/lib/stage-reader/clones/run1/clone');
    assert.deepEqual(s.spawnOpts.env, childEnv);
    assert.ok(s.args.includes('--allowedTools'));
    assert.ok(s.args.includes('--disallowedTools'));
    assert.ok(!s.args.includes('--bare'), 'never --bare (would prefer the API key)');
  });
});

test('buildSpawn: SANDBOX mode passes ONLY `sudo -n <wrapper> <cloneDir>` — NO claude argv (FIX B)', () => {
  withSpawnEnv({ STAGE_READER_WRAPPER: '/usr/local/sbin/stage-reader-run', STAGE_READER_SUDO_BIN: 'sudo', STAGE_READER_CLAUDE_BIN: 'claude' }, () => {
    const cloneDir = '/var/lib/stage-reader/clones/run42/clone';
    const s = reader.buildSpawn(cloneDir, { HOME: '/nick/scratch', CLAUDE_CODE_OAUTH_TOKEN: 'nick-secret' });
    assert.equal(s.command, 'sudo');
    // EXACTLY three args: -n, the wrapper, the clone dir. NOTHING after it — the
    // command + read-only flags are pinned INSIDE the wrapper. No `--`, no claude
    // binary, no tool flags. A caller cannot smuggle a command or a flag.
    assert.deepEqual(s.args, ['-n', '/usr/local/sbin/stage-reader-run', cloneDir]);
    assert.equal(s.args.length, 3, 'no caller-controlled argv after the clone dir');
    assert.ok(!s.args.includes('--'), 'no -- separator (no claude argv at all)');
    assert.ok(!s.args.includes('claude'), 'claude binary is pinned in the wrapper, not passed');
    assert.ok(!s.args.includes('--allowedTools'), 'tool flags pinned in the wrapper, not passed');
    // The transient unit name is UNIQUE per run — derived from the run dir
    // (parent of clone: `run42`), NOT the always-"clone" basename (round-2 MED).
    assert.equal(s.unit, 'stage-reader-run42');
    // The trusted prompt rides STDIN, not argv.
    assert.equal(s.stdinPrompt, reader.HUNT_PROMPT, 'prompt piped via stdin');
    assert.equal(s.spawnOpts.stdio[0], 'pipe', 'stdin is a pipe for the prompt');
    // nick's childEnv / OAuth token is NOT handed to sudo. Only a minimal PATH.
    assert.deepEqual(Object.keys(s.spawnOpts.env), ['PATH']);
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in s.spawnOpts.env, false, 'no token through sudo');
    assert.equal('ANTHROPIC_API_KEY' in s.spawnOpts.env, false);
    assert.equal(s.spawnOpts.cwd, undefined, 'cwd set inside the cage by the wrapper');
  });
});

test('buildSpawn: unit name is UNIQUE per run AND agrees with the wrapper derivation (round-2 MED)', () => {
  withSpawnEnv({ STAGE_READER_WRAPPER: '/usr/local/sbin/stage-reader-run' }, () => {
    // Two different runs (different run-dir tokens) → two different units.
    const a = reader.buildSpawn('/var/lib/stage-reader/clones/sp1-aaaa1111/clone', { HOME: '/h' });
    const b = reader.buildSpawn('/var/lib/stage-reader/clones/sp1-bbbb2222/clone', { HOME: '/h' });
    assert.equal(a.unit, 'stage-reader-sp1-aaaa1111');
    assert.equal(b.unit, 'stage-reader-sp1-bbbb2222');
    assert.notEqual(a.unit, b.unit, 'distinct runs get distinct units');
    // The WRAPPER computes `stage-reader-$(basename "$(dirname REAL_CLONE)")` and
    // sanitises to the unit charset. For a safe token (the only kind reader.js
    // produces) the two derivations are byte-identical — assert they agree by
    // replicating the wrapper's shell derivation here.
    const cp = require('node:child_process');
    const cloneDir = '/var/lib/stage-reader/clones/sp1-aaaa1111/clone';
    const shellUnit = cp.execFileSync('/bin/sh', ['-c',
      'T="$(basename "$(dirname -- "$1")")"; T="$(printf "%s" "$T" | tr -c "A-Za-z0-9:_.-" "_")"; printf "stage-reader-%s" "$T"',
      'sh', cloneDir,
    ], { encoding: 'utf8' });
    assert.equal(reader.buildSpawn(cloneDir, { HOME: '/h' }).unit, shellUnit,
      'reader.js unit name byte-matches the wrapper shell derivation');
  });
});

// For the runReader sandbox e2e tests we re-enable the cage (delete the opt-out
// that withFakeEnv sets) and point STAGE_READER_SUDO_BIN at a fake sudo. The fake
// sudo stands in for the whole sudo→wrapper→systemd-run→claude chain: it asserts
// the pinned-argv shape, reads the prompt from STDIN, and emits the envelope.
function enterSandboxMode(fake, fakeSudoBody) {
  const fakeSudo = path.join(fake.sandbox, 'bin', 'sudo');
  fs.writeFileSync(fakeSudo, fakeSudoBody, { mode: 0o755 });
  const saved = {
    unsafe: process.env.STAGE_READER_UNSAFE_DIRECT,
    wrap: process.env.STAGE_READER_WRAPPER,
    sudo: process.env.STAGE_READER_SUDO_BIN,
  };
  delete process.env.STAGE_READER_UNSAFE_DIRECT; // re-enable the cage (default)
  process.env.STAGE_READER_WRAPPER = '/usr/local/sbin/stage-reader-run';
  process.env.STAGE_READER_SUDO_BIN = fakeSudo;
  return () => {
    for (const [k, v] of [
      ['STAGE_READER_UNSAFE_DIRECT', saved.unsafe],
      ['STAGE_READER_WRAPPER', saved.wrap],
      ['STAGE_READER_SUDO_BIN', saved.sudo],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

test('runReader: SANDBOX mode invokes the wrapper via a FAKE sudo (pinned shape + stdin prompt) and parses its finding', async () => {
  const result = {
    finding: 'sandboxed read still produces a finding',
    evidence: [{ path: 'server.js', why: 'real file in the fixture' }],
    question: 'Deliberate?',
    confidence: 'high',
    kind: 'eerie-read',
  };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  const fake = withFakeEnv('#!/bin/sh\necho "fake claude should not be called directly in sandbox mode" >&2\nexit 99\n');
  // Fake sudo: assert `sudo -n <wrapper> <cloneDir>` with NO 4th arg, assert a
  // non-empty prompt arrives on STDIN, then emit the envelope.
  const exitSandbox = enterSandboxMode(
    fake,
    '#!/bin/sh\n' +
    '[ "$1" = "-n" ] || { echo "missing -n" >&2; exit 2; }\n' +
    'case "$2" in */stage-reader-run) : ;; *) echo "bad wrapper: $2" >&2; exit 2 ;; esac\n' +
    'case "$3" in */clone) : ;; *) echo "bad clonedir: $3" >&2; exit 2 ;; esac\n' +
    '[ -z "$4" ] || { echo "unexpected 4th arg: $4" >&2; exit 2 ;}\n' +
    'prompt="$(cat)"\n' +                       // read the piped prompt from stdin
    '[ -n "$prompt" ] || { echo "empty stdin prompt" >&2; exit 2; }\n' +
    'cat <<\'EOF\'\n' + envelope + '\nEOF\n',
  );
  try {
    const out = await reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sb1' });
    assert.equal(out.kind, 'eerie-read', 'sandbox path produced the finding');
    assert.equal(out.finding, result.finding);
    assert.equal(leftoverRunDirs(fake.scratch), 0, 'scratch wiped on the sandbox path too');
  } finally {
    exitSandbox();
    fake.restore();
  }
});

test('runReader: SANDBOX mode does NOT require nick-side OAuth token (stage-reader owns auth)', async () => {
  const result = { finding: 'x', evidence: [{ path: 'server.js', why: 'y' }], confidence: 'high', kind: 'eerie-read' };
  const envelope = JSON.stringify({ result: JSON.stringify(result) });
  const fake = withFakeEnv('#!/bin/sh\nexit 99\n');
  const exitSandbox = enterSandboxMode(fake, '#!/bin/sh\ncat >/dev/null\ncat <<\'EOF\'\n' + envelope + '\nEOF\n');
  // Point the token file at a NON-EXISTENT path: in direct mode this aborts, but
  // sandbox mode must not require it.
  process.env.STAGE_READER_TOKEN_FILE = path.join(fake.sandbox, 'no-such-token.env');
  try {
    const out = await reader.runReader({ handle: 'simonw', repo: 'datasette', spotlightId: 'sb2' });
    assert.equal(out.kind, 'eerie-read', 'sandbox run succeeds without nick-side token');
  } finally {
    exitSandbox();
    fake.restore();
  }
});

test('runReader: SANDBOX mode STILL hard-aborts on ANTHROPIC_API_KEY (cost safety survives)', async () => {
  const fake = withFakeEnv('#!/bin/sh\nexit 99\n');
  const exitSandbox = enterSandboxMode(fake, '#!/bin/sh\ncat >/dev/null\necho "{}"\n');
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
    exitSandbox();
    fake.restore();
  }
});

// ── Slice 8: the WRAPPER's own argument validation (FIX B + D), as a shell test ─
// The wrapper is the trust boundary. We can't run its systemd-run exec without
// root, but we CAN drive its validation logic up to the exec by stubbing
// systemd-run + the prerequisite probes on PATH and feeding it hostile args. The
// wrapper must: accept EXACTLY one clone-dir arg (reject any extra → reject a
// non-claude command, FIX B), and reject a clone dir outside /clones (FIX D).

const WRAPPER_PATH = path.join(__dirname, '..', 'ops', 'stage-reader-run');

// Run the wrapper against a fake SCRATCH layout. We can't override the wrapper's
// hardcoded /var/lib/stage-reader paths without root, so this test only exercises
// the EARLY validation (arg shape) which fires BEFORE the path/prereq checks.
function runWrapper(args) {
  const cp = require('node:child_process');
  const r = cp.spawnSync('/bin/bash', [WRAPPER_PATH, ...args], { encoding: 'utf8', input: 'prompt\n' });
  return { code: r.status, stderr: r.stderr || '' };
}

test('wrapper: rejects MORE than one argument — no caller command/flags accepted (FIX B)', () => {
  // The old hole was `stage-reader-run <clone> -- /bin/sh -c ...`. The new wrapper
  // takes EXACTLY one arg; anything after the clone dir is a usage error, so a
  // non-claude command can never be smuggled in.
  const r = runWrapper(['/var/lib/stage-reader/clones/x', '--', '/bin/sh', '-c', 'id']);
  assert.notEqual(r.code, 0, 'extra args rejected');
  assert.match(r.stderr, /exactly one|usage|NO other args/i);
});

test('wrapper: rejects zero arguments', () => {
  const r = runWrapper([]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage|exactly one/i);
});

test('wrapper: rejects a relative (non-absolute) clone dir', () => {
  const r = runWrapper(['relative/path']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /absolute/i);
});

test('wrapper: rejects a clone dir OUTSIDE /var/lib/stage-reader/clones (FIX D + traversal)', () => {
  // A real, existing, absolute dir that is NOT under the clones root. The wrapper
  // realpath-validates containment; a path outside clones/ must NOT proceed to
  // exec. NOTE: the wrapper uses GNU `realpath -e` (correct on the Pi / Bookworm
  // coreutils). On macOS (BSD realpath, no -e flag) the wrapper still REJECTS —
  // it just dies one line earlier with a "does not resolve" message. The
  // security-relevant invariant verified here is "non-zero exit, no exec"; the
  // exact GNU containment message is verified on the Pi (ops/reader-sandbox.md).
  const r = runWrapper(['/tmp']);
  assert.notEqual(r.code, 0, 'a path outside clones/ must be rejected (no exec)');
  assert.match(
    r.stderr,
    /escapes clones root|clones dir missing|not a directory|does not resolve|run install-reader-sandbox/i,
  );
});

// ── Slice 8 round-3 HIGH: the REAPER helper's own argument validation ─────────
// The kill-path reaper is now a single-purpose root-owned helper that REPLACES a
// wildcard `systemctl stop|kill stage-reader-*` sudoers grant. It is the real
// gate, so its name validation must reject every coercion vector before it ever
// reaches systemctl. These run the helper directly (no root needed — every reject
// path fires BEFORE the systemctl call). NOTE the macOS/Linux split: on a host
// WITHOUT systemctl (macOS dev), a VALID name dies at "systemctl not found" (still
// exit 64); on Linux/CI it exits 0 (stop/kill of an absent unit is a no-op). So the
// accept test asserts the name PASSED the gate (no name-rejection message), not a
// specific exit code — same env-aware style as the wrapper realpath test above.

const REAPER_PATH = path.join(__dirname, '..', 'ops', 'stage-reader-reap');

function runReaper(args) {
  const cp = require('node:child_process');
  const r = cp.spawnSync('/bin/bash', [REAPER_PATH, ...args], { encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr || '' };
}

// The rejection message the helper emits for a malformed NAME (not a missing
// systemctl). If a valid name slipped through the gate, none of these appear.
const NAME_REJECTION = /usage|exactly one|illegal character|namespace|empty token|too long/i;

test('reaper: rejects zero arguments', () => {
  const r = runReaper([]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage|exactly one/i);
});

test('reaper: rejects MORE than one argument — the two-token PoC (`stop ssh.service`) dies on arg count', () => {
  // Carnot's PoC was `systemctl stop stage-reader-ok ssh.service`. Against the
  // helper that arrives as TWO args → $# != 1 → rejected before any action.
  const r = runReaper(['stage-reader-ok', 'ssh.service']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage|exactly one/i);
});

test('reaper: rejects an embedded space — the one-arg form of the PoC', () => {
  // Same PoC squeezed into ONE arg. The charset check rejects the space, so it can
  // never be re-split into `<unit> ssh.service` by anything downstream.
  const r = runReaper(['stage-reader-ok ssh.service']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /illegal character/i);
});

test('reaper: rejects a unit outside the stage-reader-* namespace', () => {
  const r = runReaper(['ssh.service']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /namespace/i);
});

test('reaper: rejects the bare prefix with an empty token (enforces the `+` in the regex)', () => {
  const r = runReaper(['stage-reader-']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /namespace|empty token/i);
});

test('reaper: rejects path-traversal / slash bytes in the name', () => {
  for (const bad of ['stage-reader-../evil', 'stage-reader-x/y', 'stage-reader-a;b']) {
    const r = runReaper([bad]);
    assert.notEqual(r.code, 0, `must reject ${bad}`);
    assert.match(r.stderr, /illegal character/i, `${bad} → illegal character`);
  }
});

test('reaper: rejects an over-long name', () => {
  const r = runReaper(['stage-reader-' + 'a'.repeat(300)]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /too long/i);
});

test('reaper: ACCEPTS a valid stage-reader-<token> name (passes the gate; env-aware)', () => {
  // The full wrapper charset: alnum + : . _ - . A valid name must NOT be rejected
  // for a name reason. On Linux/CI it exits 0 (no-op on an absent unit); on macOS
  // it dies "systemctl not found" — neither is a name rejection.
  for (const ok of ['stage-reader-sp1-aaaa1111', 'stage-reader-sp1:run.42_x-y']) {
    const r = runReaper([ok]);
    assert.doesNotMatch(r.stderr, NAME_REJECTION, `${ok} must pass the name gate`);
    if (r.code !== 0) {
      // The ONLY acceptable non-zero for a valid name is the no-systemctl host.
      assert.match(r.stderr, /systemctl not found/i, `${ok}: only systemctl-absent may fail it`);
    }
  }
});
