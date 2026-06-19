// --- The Reader, wired into the live spotlight (Two Minds, Slice 3) ---
//
// reader.js is PURE MACHINERY (spawn the contained claude, parse the finding) and
// stays decoupled from engine state so its 43 unit tests run in isolation. THIS
// module is the thin seam that wires that machinery into a live spotlight:
//
//   /api/share/admit  →  developReaderFinding(spotlightId, handle)   [non-blocking]
//       │  resolve the participant's focus repo (most-recently-updated, non-fork)
//       │  runReader({handle, repo, spotlightId})  ← the CONTAINED agentic read
//       ▼
//   room.spotlight.read = { status, finding, evidence, question, ... }
//       │  broadcast → /api/show-events (host/admin); NEVER the public stream
//       ▼  The Voice (later slice) speaks room.spotlight.read.finding in-character.
//
// It mirrors research.js's developFacilitation EXACTLY for concurrency safety:
//   • the live `read` is EPHEMERAL (nested on room.spotlight; not persisted);
//   • every access goes through `room.spotlight` (never a stale captured local);
//   • before each write we re-read room.spotlight and bail if its `id` changed or
//     it was cleared — so a replaced/ended/new spotlight never receives a stale
//     Reader write (the same concurrent-cancellation guard developFacilitation uses);
//   • it NEVER throws to the caller and never blocks the admit response.
//
// SECURITY: the repo is attacker-controllable (a participant asserts any handle).
// The CONTAINMENT is reader.js + the OS cage (ops/reader-sandbox.md), verified by
// ops/verify-reader-cage.sh. This module only chooses WHICH repo and WHERE the
// (already-contained, defensively-parsed) finding lands; raw repo bytes reach only
// the contained reader, never this module.

const { GITHUB_TOKEN } = require('./config');
const state = require('./state');
const { room, normalizeGithubHandle } = state;
const { broadcast } = require('./sse-hub');
const { runReader } = require('./reader');

// Autorun gate: ON by default (production). The smoke harness sets
// STAGE_READER_AUTORUN=0 so /api/share/admit does not fire a real GitHub fetch +
// contained claude spawn during tests (keeps the suite network-free and fast).
function autorunEnabled() {
  return process.env.STAGE_READER_AUTORUN !== '0';
}

// Is room.spotlight still the SAME live spotlight we started for? The stale-write
// guard: any reassignment/clear of room.spotlight (end, skip, a new admit) changes
// its `id`, so a Reader result that resolves late is silently dropped instead of
// landing on the wrong (or absent) spotlight. Mirrors developFacilitation.
function stillLive(spotlightId) {
  return !!room.spotlight && room.spotlight.id === spotlightId && room.spotlight.active;
}

// Write the `read` projection onto the live spotlight and broadcast — but ONLY if
// the spotlight is still the one we started for (stale-guard). Returns false when
// the write was dropped as stale, so the caller can stop early.
function writeRead(spotlightId, read) {
  if (!stillLive(spotlightId)) return false;
  room.spotlight.read = read;
  broadcast();
  return true;
}

// Resolve the participant's FOCUS repo: their most-recently-updated, non-fork
// public repo — the SAME selection research.js's githubResearch uses, so the
// Reader and the source-backed facilitation read the same repo. Returns the repo
// NAME or null. Degrades to null on ANY failure (no token, rate-limit, no repos,
// network) — the caller then records a 'none' read, never throws.
async function resolveFocusRepo(handle) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Dreamfinder-Stage' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const url = `https://api.github.com/users/${encodeURIComponent(handle)}/repos?sort=updated&per_page=8`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    const repos = await res.json();
    if (!Array.isArray(repos)) return null;
    const usable = repos.find(r => r && r.name && r.html_url && !r.fork);
    return usable ? usable.name : null;
  } catch (err) {
    console.error(`[READER-WIRE] focus-repo resolve failed for ${handle}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fire the Reader for the live spotlight. NON-BLOCKING by contract — the caller
// (/api/share/admit) does NOT await this; it kicks it off so the finding is ready
// by barge-in. Every exit path writes a terminal `read` state (ready|none) or
// drops silently if the spotlight changed. NEVER throws.
//
//   read.status: 'reading'  — fired; repo resolved; the contained read is running
//                'ready'    — a non-null finding landed (finding/evidence/question)
//                'none'     — ran but produced nothing (no repo, null finding, error)
async function developReaderFinding(spotlightId, rawHandle) {
  if (!autorunEnabled()) return;
  const handle = normalizeGithubHandle(rawHandle);
  if (!handle) { writeRead(spotlightId, { status: 'none', reason: 'no-handle' }); return; }

  // Mark "reading" up front so the room can show "Dreamfinder is reading the repo…".
  if (!writeRead(spotlightId, { status: 'reading', startedAt: Date.now() })) return;

  try {
    const repo = await resolveFocusRepo(handle);
    if (!stillLive(spotlightId)) return;                       // spotlight changed mid-resolve
    if (!repo) { writeRead(spotlightId, { status: 'none', reason: 'no-repo' }); return; }

    if (!writeRead(spotlightId, { status: 'reading', repo, startedAt: Date.now() })) return;

    const finding = await runReader({ handle, repo, spotlightId });
    if (!stillLive(spotlightId)) return;                       // spotlight changed mid-read

    if (finding && finding.finding) {
      writeRead(spotlightId, {
        status: 'ready',
        repo,
        finding: finding.finding,
        evidence: Array.isArray(finding.evidence) ? finding.evidence : [],
        question: typeof finding.question === 'string' ? finding.question : '',
        confidence: finding.confidence || 'medium',
        kind: finding.kind || 'eerie-read',
        readyAt: Date.now(),
      });
    } else {
      writeRead(spotlightId, { status: 'none', repo, reason: 'no-finding' });
    }
  } catch (err) {
    // Belt-and-braces: runReader already degrades to a null finding rather than
    // throwing (except the cost-safety abort, which is a deliberate hard stop we
    // do NOT swallow silently — surface it, but still don't crash the room).
    console.error('[READER-WIRE] developReaderFinding failed:', err.message);
    writeRead(spotlightId, { status: 'none', reason: 'error' });
  }
}

module.exports = { developReaderFinding, resolveFocusRepo };
