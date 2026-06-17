// --- The Reader (agentic Claude that READS a participant's repo) ---
//
// One half of "Dreamfinder's Two Minds": The Reader is agentic Claude Code,
// spawned headless and CONTAINED, that reads a participant's repository and
// returns a structured *finding* — the single non-obvious thing a sharp senior
// dev would notice on a careful read (see PERSONA.md, "the eerie repo read").
// The Voice (OpenAI, elsewhere) later speaks the finding. This module is The
// Reader's machinery ONLY; Slice 3 wires it into routes/state.
//
// === THE TRUST-BOUNDARY CRUX ===
// This spawns an agentic LLM with READ access over ATTACKER-CONTROLLABLE input
// (a participant asserts any GitHub handle/repo; the repo content is whatever
// that account published). The containment that makes this defensible:
//
//   1. Server-side clone — Claude never touches git or the network. Node does a
//      shallow `git clone` into a per-spotlight scratch dir, then spawns Claude
//      with cwd = that dir. So even a hostile repo only gets Claude to READ files
//      already on disk; there is no fetch/checkout under model control.
//   2. Read-only tools — `--allowedTools "Read,Grep,Glob"` and an explicit
//      `--disallowedTools "Write,Edit,Bash,WebFetch,WebSearch"`. A malicious
//      README can only make Claude *say* something (prompt injection → bad
//      finding text), never *act*. The output contract is defensively parsed and
//      every cited path is validated to exist inside the clone, so an injected
//      "finding" can't even fabricate a path.
//   3. Clean allowlist child env — the child gets ONLY { HOME, CLAUDE_CONFIG_DIR,
//      CLAUDE_CODE_OAUTH_TOKEN, PATH }, NOT a spread of process.env. No server
//      secret (OPENAI/GITHUB tokens, state paths) leaks into the model's process.
//   4. COST SAFETY (the $1,800 footgun) — if ANTHROPIC_API_KEY is present in the
//      child env (or would be inherited), the run is ABORTED. With both an API
//      key and an OAuth token set, the API key WINS precedence and bills METERED.
//      We run on the Max-plan OAuth path only; a metered fall-through is a hard
//      error, never a silent bill. We also do NOT pass `--bare` (it ignores
//      CLAUDE_CODE_OAUTH_TOKEN and falls back to the API key).
//   5. Lifecycle — concurrency 1 (single spotlight); a clone size cap + clone
//      wall-clock timeout (DoS guards); a model wall-clock timeout that SIGTERMs
//      then SIGKILLs the child (mirrors sprint.js's chime kill-guard); the scratch
//      dir is wiped in a finally{} on EVERY exit path (success/timeout/error).
//      Any failure resolves to a null finding — NEVER throws to the caller, NEVER
//      leaves a zombie. The caller's fallback chain (the no-repo quip) takes over.
//
// !!! UNTRUSTED-REPO CONSTRAINT (read before Slice 3 / production) !!!
// The OS sandbox (Slice 8 — seccomp/namespaces under sudo) is NOT built yet.
// Until it lands, reader.js confines the model to read-only TOOLS but does NOT
// confine the model's *process* at the OS level. So it must be pointed ONLY at
// TRUSTED repos for now. Do not point it at arbitrary attendee repos in
// production until Slice 8 sandboxes the process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ── tunables (env-overridable; safe production defaults) ─────────────────────
// Kept local rather than in config.js: reader.js is not wired into the engine
// yet (Slice 3), so it owns its own knobs until then. All numeric envs degrade
// to the default on a non-finite value.
function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// These three are read at CALL time (functions, not module-load consts) on
// purpose: reader.js is not wired into the engine yet (Slice 3 owns that), so it
// has no composition-root pass to inject config — and resolving them per-run lets
// an operator (or a test harness) point the binary / token / scratch elsewhere
// without re-requiring the module. The numeric tunables below stay load-time
// consts (they don't change between runs).
//
// The claude binary. On the Pi it is ~/.local/bin/claude (on PATH for nick's
// shell). Configurable so a different host can point elsewhere; default 'claude'.
function claudeBin() { return process.env.STAGE_READER_CLAUDE_BIN || 'claude'; }
// Where the OAuth token lives (gitignored, chmod 600). Read in node, never echoed.
function tokenFile() {
  return process.env.STAGE_READER_TOKEN_FILE || path.join(__dirname, 'ops', 'reader.local.env');
}
// Scratch root for clones + per-run HOME/config. Prefer a writable system dir
// (survives across runs, easy to clear), else os.tmpdir().
function scratchRoot() { return process.env.STAGE_READER_SCRATCH || '/var/lib/stage-reader'; }
// Clone checkout size cap — reject a repo whose checkout exceeds this (DoS guard).
function cloneMaxBytes() { return numEnv('STAGE_READER_CLONE_MAX_BYTES', 50 * 1024 * 1024); } // ~50MB
// git clone wall-clock timeout.
function cloneTimeoutMs() { return numEnv('STAGE_READER_CLONE_TIMEOUT_MS', 30000); }
// Claude model run wall-clock timeout (SIGTERM, then SIGKILL after the grace).
function readTimeoutMs() { return numEnv('STAGE_READER_TIMEOUT_MS', 60000); }
// Grace between SIGTERM and SIGKILL (mirrors sprint.js's chime guard idea).
function killGraceMs() { return numEnv('STAGE_READER_KILL_GRACE_MS', 3000); }

// The hunt prompt — the amazement engine (PERSONA.md §"the eerie repo read").
// Instruct Claude to find the SINGLE non-obvious thing, cite exact files, and
// return finding:null rather than a weak finding. Output ONLY the JSON object.
const HUNT_PROMPT = [
  'You are reading a software repository as a sharp, careful senior engineer.',
  '',
  'Find the SINGLE thing the author would be STUNNED someone noticed on a careful',
  'read — an inconsistency, a load-bearing TODO, a pattern that breaks its own',
  'convention, a clever-but-fragile choice, an abstraction that leaks in exactly',
  'one place. NOT a summary. NOT "I see you use X". The jaw-on-the-floor "how did',
  'it notice THAT?" thing that a sharp senior dev would catch.',
  '',
  'Cite exact files (and line ranges where you can). If nothing genuinely',
  'non-obvious exists, return {"finding": null} — a weak finding is worse than',
  'none, and a confidently-wrong observation is the opposite of magic.',
  '',
  'Return ONLY a single JSON object, no prose around it, in exactly this shape:',
  '{',
  '  "finding": "<one or two sentences, the non-obvious specific observation>",',
  '  "evidence": [{"path": "relative/path.ext", "lines": "10-24", "why": "<why this is the anchor>"}],',
  '  "question": "<one inviting question — \'deliberate, or did it predate the pattern?\' energy>",',
  '  "confidence": "high" | "medium" | "reach",',
  '  "kind": "eerie-read"',
  '}',
  'evidence: 1 to 3 anchors, each citing a real file in this repo. lines is optional.',
  'If you have nothing worth saying, return {"finding": null} and nothing else.',
].join('\n');

// ── concurrency: one Reader at a time (single spotlight) ─────────────────────
let active = false;

// ── small helpers ────────────────────────────────────────────────────────────

// Read the OAuth token from the gitignored env file (KEY=value lines). Returns
// the token string or null. Never logs the value.
function readOAuthToken() {
  let raw;
  try {
    raw = fs.readFileSync(tokenFile(), 'utf8');
  } catch {
    return null; // missing file → no token → caller aborts to null finding
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$/);
    if (m) {
      // Strip surrounding quotes if present.
      return m[1].replace(/^["']|["']$/g, '').trim() || null;
    }
  }
  return null;
}

// Recursively sum file sizes under dir, short-circuiting as soon as the running
// total exceeds `cap` (so a giant repo can't make us walk forever). Skips the
// .git dir (clone metadata is not the checkout we're guarding). Returns the
// total bytes seen, which may stop early at > cap.
function dirSizeBytes(dir, cap) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const full = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) continue; // don't follow symlinks (loop/escape guard)
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* vanished mid-walk; ignore */
        }
        if (total > cap) return total; // short-circuit
      }
    }
  }
  return total;
}

// Wipe a directory tree, swallowing errors (best-effort cleanup in finally{}).
function wipeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('[READER] temp wipe failed for', dir, '-', err.message);
  }
}

// Validate a participant-asserted GitHub handle/repo segment: GitHub's own
// charset, no path traversal, no protocol smuggling. Keeps the clone URL clean
// (the clone is by Node, not the model, but defence-in-depth on the URL).
function safeSegment(s) {
  return typeof s === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(s);
}

// Defensive parse of Claude's `--output-format json` envelope → our finding
// contract, or null on ANY miss. The CLI wraps the model output; the finding is
// the last assistant message text, which itself must be the JSON object. We
// (1) parse the CLI envelope, (2) pull the result text, (3) parse THAT as our
// finding JSON, (4) shape-validate + clamp. `cloneDir` lets us reject cited
// paths that don't exist in the checkout (an injected/hallucinated anchor).
function parseFinding(stdout, cloneDir) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return null;
  }
  // claude --output-format json returns an object whose `.result` is the final
  // assistant text (newer CLIs) — fall back across a couple of shapes defensively.
  let text =
    (envelope && typeof envelope.result === 'string' && envelope.result) ||
    (typeof envelope === 'string' ? envelope : '') ||
    '';
  text = String(text).trim();
  if (!text) return null;

  // The model may wrap the JSON in ```json fences or stray prose; extract the
  // first balanced {...} object before parsing.
  const obj = extractJsonObject(text);
  if (!obj) return null;

  let finding;
  try {
    finding = JSON.parse(obj);
  } catch {
    return null;
  }
  if (!finding || typeof finding !== 'object') return null;

  // Explicit "nothing worth saying" → null finding (the contract's escape hatch).
  if (finding.finding === null || finding.finding === undefined) {
    return { finding: null };
  }
  if (typeof finding.finding !== 'string' || !finding.finding.trim()) return null;

  // Validate + clamp evidence anchors; drop any whose path does not exist inside
  // the clone (rejects fabricated/injected paths). Require at least one real one.
  const rawEvidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const evidence = [];
  for (const e of rawEvidence) {
    if (!e || typeof e !== 'object' || typeof e.path !== 'string') continue;
    if (!pathExistsInClone(cloneDir, e.path)) continue;
    const anchor = { path: e.path.slice(0, 300) };
    if (e.lines !== undefined && e.lines !== null) anchor.lines = String(e.lines).slice(0, 40);
    anchor.why = typeof e.why === 'string' ? e.why.slice(0, 400) : '';
    evidence.push(anchor);
    if (evidence.length >= 3) break;
  }
  if (evidence.length === 0) return null; // a finding with no real anchor is unverifiable

  const confidence = ['high', 'medium', 'reach'].includes(finding.confidence)
    ? finding.confidence
    : 'medium';

  return {
    finding: finding.finding.slice(0, 800),
    evidence,
    question: typeof finding.question === 'string' ? finding.question.slice(0, 400) : '',
    confidence,
    kind: 'eerie-read',
  };
}

// Extract the first balanced top-level {...} from a string (handles ```json
// fences and trailing prose). Returns the substring or null.
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Is `relPath` a real file inside `cloneDir` (not escaping it via ../ etc.)?
// Resolves and confirms containment so a cited "../../etc/passwd" is rejected.
function pathExistsInClone(cloneDir, relPath) {
  try {
    const base = fs.realpathSync(cloneDir);
    const resolved = path.resolve(base, relPath);
    const rel = path.relative(base, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false; // escaped the clone
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

// Build the CLEAN allowlist child env. NOT a spread of process.env. Throws if
// ANTHROPIC_API_KEY would reach the child (the metered-billing footgun) — both
// in our explicit allowlist and as a paranoid re-check that nothing inherited.
function buildChildEnv(scratchHome, scratchConfig, oauthToken) {
  const env = {
    HOME: scratchHome,
    CLAUDE_CONFIG_DIR: scratchConfig,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  };
  // HARD COST-SAFETY ASSERTION. If an API key is set in OUR process env it would
  // (a) be a candidate to leak and (b) with an OAuth token present, WIN
  // precedence and bill metered. We neither copy it nor tolerate its presence.
  if (process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is set in the server environment; refusing to spawn The Reader ' +
      '(it would take precedence over the OAuth token and bill metered). Unset it.',
    );
  }
  // Paranoid: assert the constructed env itself is clean.
  if ('ANTHROPIC_API_KEY' in env) {
    throw new Error('ANTHROPIC_API_KEY leaked into the Reader child env; aborting.');
  }
  return env;
}

// ── git clone (server-side; Claude never touches git/network) ────────────────
// Shallow, single-branch, no-tags clone into `dest`. Wall-clock bounded; on
// timeout SIGKILLs git. Resolves true on a clean exit 0, false otherwise.
function cloneRepo(handle, repo, dest) {
  return new Promise((resolve) => {
    const url = `https://github.com/${handle}/${repo}`;
    let child;
    try {
      child = spawn(
        'git',
        ['clone', '--depth', '1', '--no-tags', '--single-branch', '--', url, dest],
        {
          stdio: 'ignore',
          // Clean env for git too: no credentials, never prompt (a private/404
          // repo must fail fast, not hang on a credential prompt).
          env: {
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
            HOME: os.tmpdir(),
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '/bin/true',
            GIT_CONFIG_NOSYSTEM: '1',
          },
        },
      );
    } catch (err) {
      console.error('[READER] git clone spawn failed:', err.message);
      return resolve(false);
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(ok);
    };
    const killTimer = setTimeout(() => {
      console.error('[READER] git clone timed out; killing');
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done(false);
    }, cloneTimeoutMs());
    child.on('error', (err) => {
      console.error('[READER] git clone error:', err.message);
      done(false);
    });
    child.on('exit', (code) => done(code === 0));
  });
}

// ── the model run (spawn claude, bounded, parse, reap) ───────────────────────
// Spawns claude read-only over the clone, captures stdout, enforces the wall
// clock with SIGTERM→SIGKILL, and resolves to the parsed finding or null.
function runClaude(cloneDir, childEnv) {
  return new Promise((resolve) => {
    const args = [
      '-p', HUNT_PROMPT,
      '--output-format', 'json',
      '--allowedTools', 'Read,Grep,Glob',
      '--disallowedTools', 'Write,Edit,Bash,WebFetch,WebSearch',
      '--permission-mode', 'dontAsk',
      // NOTE: deliberately NO `--bare` — it ignores CLAUDE_CODE_OAUTH_TOKEN and
      // falls back to ANTHROPIC_API_KEY. Config isolation comes from the scoped
      // HOME/CLAUDE_CONFIG_DIR in childEnv instead.
    ];
    let child;
    try {
      child = spawn(claudeBin(), args, { cwd: cloneDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.error('[READER] claude spawn failed:', err.message);
      return resolve(null);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    let graceTimer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(value);
    };

    // Wall-clock guard: SIGTERM, then SIGKILL after a grace window if the child
    // ignores the term (mirrors sprint.js's chime kill-guard pattern).
    killTimer = setTimeout(() => {
      console.error('[READER] claude run timed out; SIGTERM');
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      graceTimer = setTimeout(() => {
        console.error('[READER] claude ignored SIGTERM; SIGKILL');
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, killGraceMs());
    }, readTimeoutMs());

    child.stdout.on('data', (d) => {
      stdout += d;
      // Cap captured output so a runaway child can't exhaust memory.
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(0, 2 * 1024 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(0, 64 * 1024);
    });
    child.on('error', (err) => {
      console.error('[READER] claude process error:', err.message);
      finish(null);
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[READER] claude exited ${code}${stderr ? ': ' + stderr.slice(0, 200) : ''}`);
        return finish(null);
      }
      finish(parseFinding(stdout, cloneDir));
    });
  });
}

// ── public entry point ───────────────────────────────────────────────────────
// runReader({handle, repo, spotlightId}) → a structured finding object, or
// { finding: null } on ANY failure (busy, bad input, no token, clone fail,
// oversize, timeout, non-zero exit, parse miss). NEVER throws to the caller
// EXCEPT the cost-safety ANTHROPIC_API_KEY assertion, which is a deliberate
// hard abort (a metered bill is worse than a missing finding).
async function runReader({ handle, repo, spotlightId } = {}) {
  // Concurrency 1: a Reader already running → decline (single spotlight).
  if (active) {
    console.error('[READER] declined: a read is already in progress');
    return { finding: null };
  }

  if (!safeSegment(handle) || !safeSegment(repo)) {
    console.error('[READER] declined: invalid handle/repo');
    return { finding: null };
  }

  // Read the OAuth token first — no token means no Max-plan path, so abort
  // rather than risk any other auth route.
  const oauthToken = readOAuthToken();
  if (!oauthToken) {
    console.error('[READER] declined: no CLAUDE_CODE_OAUTH_TOKEN available');
    return { finding: null };
  }

  // Per-run scratch dir. Prefer the configured scratch root if writable, else os.tmpdir().
  const runId = `${safeSegment(spotlightId) ? spotlightId : crypto.randomBytes(6).toString('hex')}`;
  const root = chooseScratchRoot();
  const runDir = path.join(root, runId + '-' + crypto.randomBytes(4).toString('hex'));
  const cloneDir = path.join(runDir, 'clone');
  const homeDir = path.join(runDir, 'home');
  const configDir = path.join(runDir, 'config');

  active = true;
  try {
    fs.mkdirSync(cloneDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    // Build the clean child env BEFORE cloning — the cost-safety assertion throws
    // here if ANTHROPIC_API_KEY is set, aborting before we spend any work.
    const childEnv = buildChildEnv(homeDir, configDir, oauthToken);

    const cloned = await cloneRepo(handle, repo, cloneDir);
    if (!cloned) {
      console.error('[READER] clone failed/timed out for', `${handle}/${repo}`);
      return { finding: null };
    }

    // Size cap (DoS guard): reject an oversize checkout BEFORE handing it to Claude.
    const cap = cloneMaxBytes();
    const bytes = dirSizeBytes(cloneDir, cap);
    if (bytes > cap) {
      console.error(`[READER] checkout too large (${bytes} > ${cap}); rejecting`);
      return { finding: null };
    }

    const finding = await runClaude(cloneDir, childEnv);
    return finding || { finding: null };
  } catch (err) {
    // The cost-safety assertion is the one thing we DO want to surface loudly —
    // but even it must not leave a zombie/temp dir, so we still hit finally{}.
    // Re-throw only the cost assertion; everything else degrades to null.
    if (/ANTHROPIC_API_KEY/.test(err.message)) {
      throw err;
    }
    console.error('[READER] unexpected failure:', err.message);
    return { finding: null };
  } finally {
    active = false;
    wipeDir(runDir); // wipe on EVERY exit path: success, timeout, error
  }
}

// Pick a scratch root: the configured root if we can create+write it, else os.tmpdir().
function chooseScratchRoot() {
  try {
    const root = scratchRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    return path.join(root, 'clones');
  } catch {
    return path.join(os.tmpdir(), 'stage-reader');
  }
}

module.exports = {
  runReader,
  // exported for unit tests (zero-dep, no live spawn needed for these):
  parseFinding,
  extractJsonObject,
  pathExistsInClone,
  buildChildEnv,
  dirSizeBytes,
  safeSegment,
  readOAuthToken,
  HUNT_PROMPT,
};
