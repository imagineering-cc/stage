// --- state ---
// The mutable-state nexus for the whole server. This module OWNS every shared
// mutable global and is required by everyone (mpv, sse-hub, research, routes).
//
// Two export mechanisms, matched to mutation style:
//
//   (A) REFERENCE-STABLE CONTAINERS — `identities`, `queue`, `playHistory`,
//       `reports`, `lastPlayedRequesterByVotes`, `sseClients`, `gestureTimes`.
//       Every mutation in the codebase is IN-PLACE (`.set`/`.push`/`.splice`/
//       `.unshift`; sortQueue uses `queue.splice(0, queue.length, ...ranked)`,
//       never `queue = ...`). The binding never changes, so they're exported as
//       bare `const` references and importers mutate the live object directly.
//
//   (B) REASSIGNED SCALARS — `nowPlaying`, `timer`, `mode`, `announcement`,
//       `visuals`, `visualEvent`, `spotlight`. These ARE reassigned, so a bare
//       `let` export would go stale in importers the instant it's reassigned.
//       They live as FIELDS on the single exported `room` holder and are only
//       ever reassigned as `room.x = ...`. Importers always read `room.x` fresh.
//
//   (C) BROADCAST / PLAYNEXT / EVENT CALLBACK CYCLE — state functions need to
//       call `broadcast()` (sse-hub), `playNext()` (mpv), and the event-session
//       accessors (`currentEventId`/`event`/`eventsArchive`, still in server.js
//       pending a later carve). A static require either direction is a cycle.
//       Instead state exports a mutable `hooks` object that the composition root
//       (server.js) wires with the real implementations after all requires.
//
// `timerTimeout`/`announcementTimeout` stay module-PRIVATE — never read across
// modules, only created/cleared internally.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  STATE_FILE,
  HISTORY_LIMIT,
  REPORT_LIMIT,
  SHOW_MODES,
  VISUAL_THEMES,
} = require('./config');

const { generateName, colorForName } = require('./names');

// Late-bound cross-module callbacks (see header note C). The composition root
// calls wireHooks() once every module is loaded; until then they are inert.
const hooks = {
  broadcast: () => {},
  playNext: () => {},
  currentEventId: () => null,
  getEvent: () => null,
  getEventsArchive: () => [],
  publicEvent: () => null,
  // Fired by markTimerEnded() AFTER the timer is marked 'ended', BEFORE its save.
  // Inert until the composition root wires sprint.onTimerEnded; this is the seam
  // that lets the sprint sequencer ride the ONE timer's end event (autonomous
  // phase advance) instead of owning a competing setTimeout. See sprint.js.
  onTimerEnded: () => {},
};

// Guard against the silent-data-loss footgun: savePersistentState() serializes
// event/eventsArchive THROUGH hooks.getEvent()/getEventsArchive(). If a save
// fires before the composition root wires them, the inert defaults return
// null/[] and we'd persist `event:null` over a real open event. wireHooks()
// flips this flag; savePersistentState() refuses to run until it does. There is
// no legitimate save before wiring (loads/migration don't save; every save is
// request-time), so this only ever catches a genuine wiring bug.
let hooksWired = false;
function wireHooks(impl) {
  Object.assign(hooks, impl);
  hooksWired = true;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Preserve a corrupt state file so the next save (atomic rename) cannot destroy
// the only recoverable copy, then let the caller boot empty — an empty room
// beats a bricked appliance mid-meetup. Timestamp+pid suffix avoids collisions
// under rapid restart loops.
function quarantineCorruptFile(reason) {
  const quarantine = `${STATE_FILE}.corrupt-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(STATE_FILE, quarantine);
    console.error(`[STATE CORRUPTION] ${STATE_FILE} ${reason}; preserved at ${quarantine} for recovery. Booting with empty state.`);
  } catch (renameErr) {
    console.error(`[STATE CORRUPTION] ${STATE_FILE} ${reason} AND could not be quarantined (${renameErr.message}). Booting with empty state; the original file may still be at ${STATE_FILE}.`);
  }
}

// Remove ORPHAN per-pid tmp files left by an interrupted save. savePersistentState
// writes `${STATE_FILE}.${pid}.tmp`, fsyncs, then atomically renames it over
// STATE_FILE; on the normal error path it unlinks the tmp. But a power-cut or
// SIGKILL in the fsync->rename window strands the tmp forever — harmless (load
// only ever reads STATE_FILE, never a .tmp) but it accretes. Sweep them at boot.
//
// Matches ONLY `<basename>.<digits>.tmp` (the per-pid naming). The `\d+` anchor
// is deliberate: it can NEVER match a `.corrupt-<ts>-<pid>` quarantine sidecar
// (those carry the `corrupt-` prefix and no trailing `.tmp`), which is forensics
// we must retain. The CURRENT process's own tmp, if any, is an in-flight write —
// skipped by pid. Fully defensive: any failure (unreadable dir, racing unlink)
// is swallowed so a sweep can NEVER block boot.
function sweepOrphanTmpFiles() {
  try {
    const dir = path.dirname(STATE_FILE);
    const base = path.basename(STATE_FILE);
    // Escape regex metacharacters in the basename so a literal '.' in the file
    // name matches a '.', not any character (defensive; basenames are tame here).
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tmpPattern = new RegExp(`^${escaped}\\.(\\d+)\\.tmp$`);
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      const m = tmpPattern.exec(name);
      if (!m) continue;
      if (Number(m[1]) === process.pid) continue; // our own in-flight write
      try {
        fs.unlinkSync(path.join(dir, name));
        removed += 1;
      } catch (_) { /* racing unlink / gone already — fine */ }
    }
    if (removed > 0) console.log(`[STATE] swept ${removed} orphan tmp file(s)`);
  } catch (_) { /* a sweep failure must never block boot */ }
}

function loadPersistentState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {}; // first boot: silent, expected
    quarantineCorruptFile(`was unreadable (${err.message})`);
    return {};
  }
  // Parsed, but the persisted root must be a PLAIN object. A JSON array or a
  // bare primitive (string/number/null) is corruption too: the old loose
  // `typeof === 'object'` test let an array straight through, and a primitive's
  // original file was left on disk to be silently destroyed by the next save.
  // Quarantine the same way before booting empty (the valid-JSON-wrong-type gap
  // the adversarial review surfaced).
  if (!isPlainObject(raw)) {
    const kind = Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw;
    quarantineCorruptFile(`parsed to a non-object (${kind})`);
    return {};
  }
  return raw;
}

const savedState = loadPersistentState();
// Sweep stale orphan tmp files at module load — the same boot seam as the load
// above, so it runs exactly once, AFTER STATE_FILE is known, and inside state.js
// (the module that owns the tmp naming) rather than bolted onto the composition
// root. Deliberately AFTER loadPersistentState so it never races the real read.
sweepOrphanTmpFiles();
const savedIdentities = Array.isArray(savedState.identities)
  ? savedState.identities.filter(item => Array.isArray(item) && item.length === 2)
  : [];
const identities = new Map(savedIdentities); // token -> { name, color, mintedAt }
const playHistory = Array.isArray(savedState.playHistory)
  ? savedState.playHistory.slice(0, HISTORY_LIMIT)
  : [];
const reports = Array.isArray(savedState.reports)
  ? savedState.reports.slice(0, REPORT_LIMIT)
  : [];
const queue = Array.isArray(savedState.queue)
  ? savedState.queue.filter(track => track && typeof track.id === 'string')
  : [];                       // [{ id, requesterToken, requesterName, color, videoId, title, thumbnail, addedAt, voterTokens }]
const lastPlayedRequesterByVotes = savedState.lastPlayedRequesterByVotes &&
  typeof savedState.lastPlayedRequesterByVotes === 'object'
  ? { ...savedState.lastPlayedRequesterByVotes }
  : { 0: savedState.lastPlayedRequesterToken || null };
const sseClients = new Set(); // { res, includeSpotlight } stream clients
const gestureTimes = new Map();

// A persisted sprint session is only well-formed if it carries the fields the
// running code (and the write-side gate) require. Hoisted above `room` so the
// holder can hydrate room.sprint through it. SHARED by load-side hydration and
// validateStateShape so the two can never disagree (the #808 lesson: anything
// the gate rejects on write is dropped to null on read, so a lenient load can't
// feed garbage to a strict write and crash-loop the appliance). A malformed
// sprint degrades to idle (null), never crashes, never destroys other state.
function isValidSprintSession(s) {
  if (!isPlainObject(s)) return false;
  if (typeof s.sessionId !== 'string') return false;
  if (!['idle', 'running', 'winding-down', 'paused', 'done'].includes(s.status)) return false;
  if (!Number.isInteger(s.phaseIndex) || s.phaseIndex < 0) return false;
  if (s.pausedRemainingMs !== null && !Number.isFinite(s.pausedRemainingMs)) return false;
  if (!Array.isArray(s.plan) || s.plan.length === 0) return false;
  if (s.phaseIndex >= s.plan.length) return false;
  for (const ph of s.plan) {
    if (!isPlainObject(ph)) return false;
    if (!SHOW_MODES.has(ph.mode)) return false;
    if (typeof ph.label !== 'string') return false;
    if (!Number.isFinite(ph.durationMs) || ph.durationMs <= 0) return false;
    if (ph.visuals !== undefined && !isPlainObject(ph.visuals)) return false;
  }
  return true;
}

// A persisted share-queue entry is only well-formed if it carries the fields the
// running code (and the write-side gate) require. SHARED by load-side hydration
// and validateStateShape so the two can never disagree (the #808 lesson: anything
// the gate rejects on write is dropped on read, so a lenient load can't feed
// garbage to a strict write and crash-loop the appliance). A malformed entry is
// dropped on load; a non-array shareQueue degrades to []. Only NON-TERMINAL
// statuses ever persist — terminal entries are pruned at transition, so the
// persisted set is exactly {requested, admitted, correcting}; a downgrade on boot
// (see downgradeShareEntryOnBoot) collapses the two live states to 'requested'
// because room.spotlight is not resumed across a restart.
const SHARE_QUEUE_KINDS = new Set(['share', 'progress']);
const SHARE_QUEUE_PERSISTED_STATUSES = new Set(['requested', 'admitted', 'correcting']);
function isValidShareQueueEntry(e) {
  if (!isPlainObject(e)) return false;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.token !== 'string' || e.token.length === 0) return false;
  if (typeof e.name !== 'string') return false;
  if (typeof e.color !== 'string') return false;
  if (!SHARE_QUEUE_KINDS.has(e.kind)) return false;
  if (typeof e.projectTitle !== 'string') return false;
  if (!Number.isFinite(e.requestedAt)) return false;
  if (!SHARE_QUEUE_PERSISTED_STATUSES.has(e.status)) return false;
  return true;
}

// On boot, a live presenter dangles: room.spotlight is NOT resumed across a
// restart (same policy as nowPlaying), so an 'admitted'/'correcting' entry would
// reference a spotlight that no longer exists. Collapse both live states back to
// 'requested' so the host can re-admit cleanly. Terminal entries never reach here
// (pruned at transition, never persisted).
function downgradeShareEntryOnBoot(e) {
  if (e.status === 'admitted' || e.status === 'correcting') {
    return { ...e, status: 'requested', admittedAt: null };
  }
  return e;
}

const shareQueue = Array.isArray(savedState.shareQueue)
  ? savedState.shareQueue.filter(isValidShareQueueEntry).map(downgradeShareEntryOnBoot)
  : []; // [{ id, eventId, token, name, color, kind, projectTitle, requestedAt, admittedAt, status }]

// Reassigned scalars live on this single holder (see header note B).
const room = {
  nowPlaying: null,           // { ...trackEntry } | null
  timer: isValidTimer(savedState.timer) ? savedState.timer : null,
  mode: SHOW_MODES.has(savedState.mode) ? savedState.mode : 'free-jukebox',
  announcement: null,         // { id, title, message, detail, createdAt, expiresAt, color } | null
  visuals: normalizeVisuals(savedState.visuals),
  visualEvent: null,          // short-lived phone gesture effect; never persisted
  spotlight: null,            // consented live speech transcript; archived only when explicitly ended
  sprint: isValidSprintSession(savedState.sprint) ? savedState.sprint : null, // autonomous sprint session | null (idle)
  // Phone-led presentation queue (M2). Reference-stable: mutated in place via
  // .push/.splice (a reassigned-let export would go stale in importers). Lives
  // on `room` for cohesion with spotlight/timer/sprint but is mutated like the
  // (A) containers. Scoped to the open event; cleared at every event boundary.
  shareQueue,
};

// Module-private timeout handles (see header note about privacy).
let timerTimeout = null;
let announcementTimeout = null;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeGithubHandle(value) {
  const handle = cleanText(value, 39).replace(/^@/, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(handle) ? handle : '';
}

function identityDisplayName(id) {
  const handle = normalizeGithubHandle(id?.githubHandle);
  return handle ? `@${handle}` : cleanText(id?.name, 60);
}

function normalizeVisuals(value) {
  const data = value && typeof value === 'object' ? value : {};
  return {
    theme: VISUAL_THEMES.has(data.theme) ? data.theme : 'aurora',
    energy: clamp(data.energy, 0, 1, 0.56),
    complexity: clamp(data.complexity, 0, 1, 0.62),
    hue: Math.round(clamp(data.hue, 0, 360, 212)),
    editedBy: cleanText(data.editedBy, 60),
    editedAt: Number(data.editedAt) || null,
  };
}

// A persisted timer is only well-formed if it carries the fields the running
// code (and the write-side gate) require. Load-side hydration and the validator
// share THIS predicate so the two can never disagree: anything the gate would
// reject on write is loaded as null on read, instead of as garbage that would
// crash the first guest-triggered save (the load/write asymmetry the adversarial
// review proved could crash-loop the appliance).
function isValidTimer(t) {
  return isPlainObject(t)
    && typeof t.id === 'string'
    && typeof t.status === 'string'
    && Number.isFinite(t.endsAt);
}

// Pre-write shape gate. Atomic != valid: an atomic rename will durably persist
// in-memory garbage just as faithfully as good data. This validates ONLY the
// invariants the running code actually guarantees (verified against
// createIdentity/startTimer/normalizeEvent/normalizeVisuals shapes) — NOT
// over-specific per-record fields that legitimate saves don't all carry. On a
// violation it throws LOUDLY (same spirit as the hooksWired guard) so garbage is
// rejected rather than written over the last good copy.
function validateStateShape(d) {
  const fail = (m) => { throw new Error(`[STATE VALIDATION] refusing to persist: ${m}`); };
  if (!d || typeof d !== 'object') fail('root is not an object');

  if (!Array.isArray(d.identities)) fail('identities is not an array');
  d.identities.forEach((it, i) => {
    if (!Array.isArray(it) || it.length !== 2) fail(`identities[${i}] is not a [token, identity] pair`);
    if (typeof it[0] !== 'string') fail(`identities[${i}][0] token is not a string`);
    if (!it[1] || typeof it[1] !== 'object') fail(`identities[${i}][1] is not an object`);
  });

  for (const k of ['playHistory', 'queue']) {
    if (!Array.isArray(d[k])) fail(`${k} is not an array`);
    d[k].forEach((t, i) => {
      if (!t || typeof t !== 'object') fail(`${k}[${i}] is not an object`);
      if (typeof t.id !== 'string') fail(`${k}[${i}].id is not a string`);
    });
  }

  if (!Array.isArray(d.reports)) fail('reports is not an array');
  d.reports.forEach((r, i) => { if (!r || typeof r !== 'object') fail(`reports[${i}] is not an object`); });

  if (!Array.isArray(d.eventsArchive)) fail('eventsArchive is not an array');
  d.eventsArchive.forEach((e, i) => { if (!e || typeof e !== 'object') fail(`eventsArchive[${i}] is not an object`); });

  if (!d.lastPlayedRequesterByVotes || typeof d.lastPlayedRequesterByVotes !== 'object' || Array.isArray(d.lastPlayedRequesterByVotes)) fail('lastPlayedRequesterByVotes is not an object');

  if (d.timer !== null) {
    if (typeof d.timer !== 'object' || Array.isArray(d.timer)) fail('timer is not null or an object');
    if (typeof d.timer.id !== 'string') fail('timer.id is not a string');
    if (typeof d.timer.status !== 'string') fail('timer.status is not a string');
    // Number.isFinite, not typeof: typeof NaN/Infinity === 'number' would slip a
    // non-finite endsAt past the gate and re-corrupt on the next reload.
    if (!Number.isFinite(d.timer.endsAt)) fail('timer.endsAt is not a finite number');
  }

  // sprint: null (idle) or a well-formed session. Uses the SAME predicate the
  // load side hydrates with, so load and write can never disagree (#808 lesson:
  // a lenient load + strict write is a crash-loop). A persisted shape the gate
  // would reject is loaded as null, so it can never reach this branch as garbage.
  if (d.sprint !== null && !isValidSprintSession(d.sprint)) {
    const why = !isPlainObject(d.sprint) ? 'sprint is not null or an object'
      : !Array.isArray(d.sprint.plan) || d.sprint.plan.length === 0 ? 'sprint.plan is not a non-empty array'
      : 'sprint session is malformed (sessionId/status/phaseIndex/plan)';
    fail(why);
  }

  // shareQueue: an array of well-formed non-terminal entries. Uses the SAME
  // predicate the load side hydrates with (#808 symmetry): a persisted shape the
  // gate would reject is loaded as dropped/[], so it can never reach here as
  // garbage — but a save built from in-memory garbage IS rejected loudly, exactly
  // like the other persisted fields. (Terminal-status entries are pruned at
  // transition and never appear in room.shareQueue, so the persisted-status set
  // the predicate enforces is the correct gate.)
  if (!Array.isArray(d.shareQueue)) fail('shareQueue is not an array');
  d.shareQueue.forEach((e, i) => {
    if (!isValidShareQueueEntry(e)) fail(`shareQueue[${i}] is malformed (id/token/name/color/kind/projectTitle/requestedAt/status)`);
  });

  if (d.event !== null && (typeof d.event !== 'object' || Array.isArray(d.event))) fail('event is not null or an object');
  if (d.event && typeof d.event.id !== 'string') fail('event.id is not a string');

  if (!SHOW_MODES.has(d.mode)) fail(`mode "${d.mode}" not in SHOW_MODES`);

  if (!d.visuals || typeof d.visuals !== 'object') fail('visuals is not an object');
  const v = d.visuals;
  if (!VISUAL_THEMES.has(v.theme)) fail(`visuals.theme "${v.theme}" not in VISUAL_THEMES`);
  // Number.isFinite, not typeof: NaN/Infinity are typeof 'number' and pass < / >
  // comparisons as false, so a typeof check would let them through the gate.
  if (!Number.isFinite(v.energy) || v.energy < 0 || v.energy > 1) fail('visuals.energy not a finite number in [0,1]');
  if (!Number.isFinite(v.complexity) || v.complexity < 0 || v.complexity > 1) fail('visuals.complexity not a finite number in [0,1]');
  if (!Number.isFinite(v.hue) || v.hue < 0 || v.hue > 360) fail('visuals.hue not a finite number in [0,360]');
  if (v.editedAt !== null && !Number.isFinite(v.editedAt)) fail('visuals.editedAt not null or a finite number');
}

// Serialize the live persisted state into the exact object savePersistentState
// writes and validateStateShape gates. Pure read of the shared containers + the
// room holder + the event-session hooks; mutates nothing. The single source of
// truth for "what gets persisted", shared by savePersistentState AND commit() so
// the write path and the guarded-mutation path can never serialize a different
// shape (the load/write-symmetry lesson, applied to the two writers).
function buildSnapshot() {
  return {
    identities: Array.from(identities.entries()),
    playHistory,
    queue,
    lastPlayedRequesterByVotes,
    timer: room.timer,
    mode: room.mode,
    visuals: room.visuals,
    reports,
    sprint: room.sprint,
    shareQueue: room.shareQueue,
    event: hooks.getEvent(),
    eventsArchive: hooks.getEventsArchive(),
  };
}

// Atomic durable write of an ALREADY-VALIDATED snapshot. No shape gate here —
// both callers (savePersistentState, commit) validate BEFORE calling this, so a
// double-validate would be wasted work and a single skipped validate would be a
// silent hole. The hooksWired guard stays: persisting before the composition
// root wires the event accessors would write event:null over a real open event
// (a boot/deploy bug, never a request-time condition — so throwing is correct).
function writeSnapshot(data) {
  if (!hooksWired) {
    throw new Error('writeSnapshot() before state.wireHooks(): event/eventsArchive would persist as null. Wire hooks in the composition root before any save.');
  }
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  const json = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    // fsync the tmp file before rename: closes the Pi power-cut window where the
    // rename's metadata lands but the data hasn't flushed -> a zero-length file.
    const fd = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, STATE_FILE);
    // Best-effort dir fsync makes the rename metadata itself durable. Some
    // platforms reject opening a directory fd, so this is isolated — degrading
    // to file-only durability beats failing the save (and keeps CI portable).
    try {
      const dirFd = fs.openSync(path.dirname(STATE_FILE), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (_) { /* file+inode fsync already gives the power-cut safety bar */ }
  } catch (err) {
    console.error('state save failed', err.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err; // propagate — a failed save must not silently look successful
  }
}

// Restore the persisted, room-OWNED mutable state from a (deep-cloned) snapshot,
// IN PLACE so every exported reference (the `identities` Map, the `queue`/
// `reports`/`shareQueue` arrays, the `room` holder) stays stable — importers
// hold those bindings forever. This is commit()'s rollback leg.
//
// SCOPE — deliberately NOT exhaustive over all of buildSnapshot():
//   • event / eventsArchive are owned by event-session.js and are mutated ONLY
//     by the host-lifecycle transitions (openEvent/closeEvent), which are not
//     guarded mutations — so a guarded mutation never changes them and there is
//     nothing to roll back. Restoring them here would mean reaching across the
//     module boundary the composition root exists to keep one-directional.
//   • nowPlaying / announcement / visualEvent / spotlight are EPHEMERAL (never
//     persisted, not in the snapshot), so they cannot cause the persisted
//     memory/disk divergence commit() exists to prevent, and are out of scope.
function restoreSnapshot(s) {
  identities.clear();
  for (const [k, v] of s.identities) identities.set(k, v);
  queue.splice(0, queue.length, ...s.queue);
  playHistory.splice(0, playHistory.length, ...s.playHistory);
  reports.splice(0, reports.length, ...s.reports);
  for (const k of Object.keys(lastPlayedRequesterByVotes)) delete lastPlayedRequesterByVotes[k];
  Object.assign(lastPlayedRequesterByVotes, s.lastPlayedRequesterByVotes);
  room.timer = s.timer;
  room.mode = s.mode;
  room.visuals = s.visuals;
  room.sprint = s.sprint;
  // A buggy mutator could have REASSIGNED room.shareQueue to a non-array — the very
  // class of bug commit() exists to catch (validateStateShape rejects it, which
  // triggers this rollback). The canonical array is the module-scoped `shareQueue`
  // const, which such a reassignment leaves untouched; a bare `room.shareQueue.splice`
  // would TypeError on the reassigned non-array and fail the rollback ITSELF. So
  // repair the alias first, THEN refill the canonical array in place.
  room.shareQueue = shareQueue;
  shareQueue.splice(0, shareQueue.length, ...s.shareQueue);
}

// The rollback-scoped slice of the persisted state — exactly what restoreSnapshot
// puts back, and ONLY that. commit() deep-clones THIS (not the full buildSnapshot)
// so a guarded mutation does not pay to clone the unbounded `eventsArchive`/`event`
// it never rolls back (those are owned by event-session and never touched by a
// guarded mutator). Keeps the per-request clone cost proportional to room-owned
// state, not to the whole archive.
function buildRollbackSnapshot() {
  return {
    identities: Array.from(identities.entries()),
    queue,
    playHistory,
    reports,
    lastPlayedRequesterByVotes,
    timer: room.timer,
    mode: room.mode,
    visuals: room.visuals,
    sprint: room.sprint,
    shareQueue: room.shareQueue,
  };
}

// THE GUARDED-MUTATION BOUNDARY (#11 / task #837).
//
// #808 made savePersistentState() validate at the PERSISTENCE boundary and SKIP
// on failure — the correct emergency stop for a crash-loop, but it leaves a
// divergence: a route mutates `room`, broadcast() fans the bad state to every
// client, the save is skipped, disk keeps last-good, and a reboot silently
// time-travels. commit() closes that by inverting the sequence to
// validate -> persist, with the mutation made provisionally and ROLLED BACK if
// the proposed result is invalid:
//
//   snapshot persisted state  ->  run mutator (in place)  ->  validate result
//     valid   -> persist the validated snapshot, return the mutator's result
//     invalid -> restore the snapshot, THROW (caller maps to 4xx, broadcasts
//                nothing) — so `room` AND disk are left exactly as they were.
//
// The mutator runs the SAME in-place mutation a route would have run inline; the
// only discipline a route adopts is to wrap that mutation in commit() and to
// broadcast ONLY after commit() returns (so a rejected mutation never reaches a
// client). A mutator that itself throws is treated identically to an invalid
// result: roll back and rethrow. Internal valid-by-construction writers
// (createIdentity/recordPlay/startTimer/sprint advances) still persist through
// savePersistentState()'s degrade-not-crash net — commit() is for request-driven
// mutations whose input the room does not fully control.
function commit(mutator) {
  const before = structuredClone(buildRollbackSnapshot());
  try {
    const result = mutator();
    const after = buildSnapshot();
    validateStateShape(after); // throws on a shape the persistence gate would reject
    writeSnapshot(after);      // already validated -> safe to write atomically
    return result;
  } catch (err) {
    restoreSnapshot(before);   // room-owned persisted state back to pre-mutation
    throw err;                 // caller catches -> 4xx; nothing persisted, nothing broadcast
  }
}

function savePersistentState() {
  const data = buildSnapshot();
  // Shape gate. A violation means in-memory state is corrupt; the validator's
  // JOB is to keep garbage OFF disk — achieve that by SKIPPING this write and
  // logging loudly, NOT by throwing. This is the last-line net for INTERNAL
  // valid-by-construction writers (createIdentity, recordPlay, startTimer,
  // sprint advances) that persist outside a request's commit(); a throw here
  // would be uncaught in those paths and could crash-loop the room. Request-
  // driven mutations should route through commit() instead, which validates
  // BEFORE persisting and rejects at the route. KNOWN TRADEOFF: in-memory
  // changes since the last good save won't survive a restart until the bad
  // state is corrected — the loud log surfaces it. A stale room beats a crash.
  try {
    validateStateShape(data);
  } catch (err) {
    console.error(`state save skipped: ${err.message}`);
    return;
  }
  writeSnapshot(data);
}

function createIdentity() {
  const token = crypto.randomBytes(16).toString('hex');
  const name = generateName();
  const color = colorForName(name);
  const eventId = hooks.currentEventId();
  identities.set(token, { name, color, mintedAt: Date.now(), eventIds: eventId ? [eventId] : [] });
  savePersistentState();
  return { token, name, color };
}

function markTimerEnded() {
  if (!room.timer || room.timer.status !== 'running') return;
  room.timer = { ...room.timer, status: 'ended', endedAt: Date.now() };
  // Let the sprint sequencer react to the phase boundary (autonomous advance)
  // BEFORE persisting, so a sprint state change rides the same save. Inert until
  // wired; tolerant of being called when no sprint is running (see sprint.js).
  hooks.onTimerEnded();
  savePersistentState();
}

function currentTimer() {
  if (room.timer?.status === 'running' && Date.now() >= room.timer.endsAt) {
    markTimerEnded();
  }
  return room.timer;
}

function voteCount(track) {
  return Array.isArray(track?.voterTokens) ? track.voterTokens.length : 0;
}

function publicTrack(track) {
  if (!track) return null;
  const { requesterToken, voterTokens, ...out } = track;
  const requester = identities.get(requesterToken);
  return {
    ...out,
    requesterName: requester ? identityDisplayName(requester) : out.requesterName,
    votes: voteCount(track),
  };
}

function publicQueue() {
  return queue.map(publicTrack);
}

function participantProfile(id) {
  return {
    name: identityDisplayName(id),
    dreamfinderName: id.name,
    color: id.color,
    projectTitle: cleanText(id.projectTitle, 100),
    projectDescription: cleanText(id.projectDescription, 420),
    githubHandle: normalizeGithubHandle(id.githubHandle),
    consentRecording: id.consentRecording === true,
    consentResearch: id.consentResearch === true,
  };
}

function currentVisualEvent() {
  if (room.visualEvent && Date.now() - room.visualEvent.at > 5000) room.visualEvent = null;
  return room.visualEvent;
}

function publicSpotlight() {
  if (!room.spotlight) return null;
  const { participantToken, ...visible } = room.spotlight;
  return visible;
}

function hostSpotlight() {
  if (!room.spotlight) return null;
  return { ...publicSpotlight(), participantToken: room.spotlight.participantToken };
}

// --- share queue (phone-led presentation queue, M2) ---
// The single source of truth for "who may speak" is room.spotlight.participantToken
// (see GATING in routes.js); the share-queue entry is kept consistent with it but
// is the host's view of the line. Projection mirrors the spotlight public/host
// split: the PUBLIC wire NEVER carries `token` (the only auth secret on the entry),
// so the guest finds ITS OWN row by the opaque `id` returned from /api/share/request.
function shareQueueEntry(token) {
  return room.shareQueue.find(e => e.token === token) || null;
}

// Remove a now-terminal entry from the live queue. The report (if any) lives in
// the separate persisted reports[] via archiveSpotlight(), so pruning loses
// nothing; only non-terminal entries ever persist, keeping the array lean.
function pruneShareEntry(token) {
  const i = room.shareQueue.findIndex(e => e.token === token);
  if (i >= 0) room.shareQueue.splice(i, 1);
}

function shareQueueProjection(includeToken) {
  return room.shareQueue.map(e => {
    const base = {
      id: e.id,                 // opaque per-request id; how a guest finds ITS OWN entry without seeing token
      name: e.name,             // display-safe (snapshotted at request time)
      color: e.color,           // display-safe
      kind: e.kind,             // 'share' | 'progress'
      projectTitle: e.projectTitle,
      requestedAt: e.requestedAt,
      status: e.status,         // 'requested' | 'admitted' | 'correcting'
    };
    return includeToken ? { ...base, token: e.token } : base; // PUBLIC omits token entirely
  });
}

function rotateRequesterOrder(tokens, votes) {
  const current = tokens.indexOf(lastPlayedRequesterByVotes[String(votes)]);
  if (current < 0) return tokens;
  return tokens.slice(current + 1).concat(tokens.slice(0, current + 1));
}

function scheduleVoteBand(tracks, votes) {
  const byRequester = new Map();
  for (const track of tracks.sort((a, b) => a.addedAt - b.addedAt)) {
    const token = track.requesterToken || track.requesterName;
    if (!byRequester.has(token)) byRequester.set(token, []);
    byRequester.get(token).push(track);
  }
  const order = rotateRequesterOrder(Array.from(byRequester.keys()), votes);
  const scheduled = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const token of order) {
      const next = byRequester.get(token).shift();
      if (next) {
        scheduled.push(next);
        remaining = true;
      }
    }
  }
  return scheduled;
}

function sortQueue() {
  const voteBands = new Map();
  for (const track of queue) {
    const votes = voteCount(track);
    if (!voteBands.has(votes)) voteBands.set(votes, []);
    voteBands.get(votes).push(track);
  }
  const ranked = Array.from(voteBands.keys())
    .sort((a, b) => b - a)
    .flatMap(votes => scheduleVoteBand(voteBands.get(votes), votes));
  queue.splice(0, queue.length, ...ranked);
}

function recordPlay(track) {
  playHistory.unshift({ ...publicTrack(track), eventId: track.eventId || hooks.currentEventId(), playedAt: Date.now() });
  playHistory.length = Math.min(playHistory.length, HISTORY_LIMIT);
  savePersistentState();
}

function startTimer({ durationMs, label }) {
  if (timerTimeout) clearTimeout(timerTimeout);
  const now = Date.now();
  room.timer = {
    id: crypto.randomBytes(4).toString('hex'),
    label: label || 'Sprint',
    durationMs,
    startedAt: now,
    endsAt: now + durationMs,
    status: 'running',
  };
  armTimerTimeout();
  savePersistentState();
  hooks.broadcast();
  return room.timer;
}

function armTimerTimeout() {
  if (timerTimeout) clearTimeout(timerTimeout);
  if (!room.timer || room.timer.status !== 'running') return;
  const remaining = room.timer.endsAt - Date.now();
  if (remaining <= 0) {
    markTimerEnded();
    hooks.broadcast();
    return;
  }
  timerTimeout = setTimeout(() => {
    markTimerEnded();
    hooks.broadcast();
  }, Math.min(remaining, 2147483647));
}

function clearTimer() {
  if (timerTimeout) clearTimeout(timerTimeout);
  timerTimeout = null;
  room.timer = null;
  savePersistentState();
  hooks.broadcast();
}

function currentAnnouncement() {
  if (room.announcement && Date.now() >= room.announcement.expiresAt) {
    room.announcement = null;
  }
  return room.announcement;
}

function showAnnouncement({ title, message, detail, durationMs, color }) {
  if (announcementTimeout) clearTimeout(announcementTimeout);
  const now = Date.now();
  room.announcement = {
    id: crypto.randomBytes(4).toString('hex'),
    title: String(title || 'Dreamfinder').slice(0, 80),
    message: String(message || '').slice(0, 180),
    detail: String(detail || '').slice(0, 180),
    color: String(color || '#fbbf24').slice(0, 40),
    createdAt: now,
    expiresAt: now + durationMs,
  };
  announcementTimeout = setTimeout(() => {
    room.announcement = null;
    hooks.broadcast();
  }, Math.min(durationMs, 2147483647));
  hooks.broadcast();
  return room.announcement;
}

function clearAnnouncement() {
  if (announcementTimeout) clearTimeout(announcementTimeout);
  announcementTimeout = null;
  room.announcement = null;
  hooks.broadcast();
}

module.exports = {
  // the raw parsed state blob, read ONCE here at module load. Exported so
  // event-session.js can hydrate event/eventsArchive from the SAME snapshot
  // rather than re-reading the file (a second parse could diverge if the file
  // changed between reads). See server.js's boot.
  savedState,
  // reassigned-scalar holder (B)
  room,
  // reference-stable containers (A)
  identities,
  queue,
  playHistory,
  reports,
  lastPlayedRequesterByVotes,
  sseClients,
  gestureTimes,
  // late-bound cross-module callbacks (C)
  hooks,
  wireHooks,
  // persistence
  loadPersistentState,
  sweepOrphanTmpFiles,
  savePersistentState,
  validateStateShape,
  isValidSprintSession,
  // guarded mutation (#11): validate-before-persist with rollback (see commit)
  buildSnapshot,
  restoreSnapshot,
  commit,
  // identity + helpers
  createIdentity,
  clamp,
  cleanText,
  normalizeGithubHandle,
  identityDisplayName,
  normalizeVisuals,
  currentVisualEvent,
  participantProfile,
  voteCount,
  publicTrack,
  publicQueue,
  publicSpotlight,
  hostSpotlight,
  // share queue (M2)
  isValidShareQueueEntry,
  shareQueueEntry,
  pruneShareEntry,
  shareQueueProjection,
  sortQueue,
  recordPlay,
  // timer
  currentTimer,
  markTimerEnded,
  startTimer,
  armTimerTimeout,
  clearTimer,
  // announcement
  currentAnnouncement,
  showAnnouncement,
  clearAnnouncement,
};
