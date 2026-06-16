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

// Reassigned scalars live on this single holder (see header note B).
const room = {
  nowPlaying: null,           // { ...trackEntry } | null
  timer: isValidTimer(savedState.timer) ? savedState.timer : null,
  mode: SHOW_MODES.has(savedState.mode) ? savedState.mode : 'free-jukebox',
  announcement: null,         // { id, title, message, detail, createdAt, expiresAt, color } | null
  visuals: normalizeVisuals(savedState.visuals),
  visualEvent: null,          // short-lived phone gesture effect; never persisted
  spotlight: null,            // consented live speech transcript; archived only when explicitly ended
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

function savePersistentState() {
  // Fail loud, not silent: persisting before hooks are wired would write
  // event:null over a real event (see wireHooks above).
  if (!hooksWired) {
    throw new Error('savePersistentState() before state.wireHooks(): event/eventsArchive would persist as null. Wire hooks in the composition root before any save.');
  }
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  // Build the object literal first so the shape gate runs on it BEFORE stringify
  // and BEFORE the write try/catch — a validation throw must propagate like the
  // hooksWired guard, never be swallowed by the unlink-and-continue catch below.
  const data = {
    identities: Array.from(identities.entries()),
    playHistory,
    queue,
    lastPlayedRequesterByVotes,
    timer: room.timer,
    mode: room.mode,
    visuals: room.visuals,
    reports,
    event: hooks.getEvent(),
    eventsArchive: hooks.getEventsArchive(),
  };
  // Shape gate. A violation means in-memory state is corrupt; the validator's
  // JOB is to keep garbage OFF disk — achieve that by SKIPPING this write and
  // logging loudly, NOT by throwing. The throw is uncaught in request handlers
  // (createIdentity -> route -> process crash); a malformed-but-parseable
  // persisted field would otherwise crash-loop the room on the first /api/join.
  // The last good on-disk copy is left intact. KNOWN TRADEOFF: in-memory changes
  // since the last good save won't survive a restart until the bad state is
  // corrected — the loud log surfaces it. A stale/empty room beats a crash-loop.
  // (The hooksWired guard above still throws: that's a boot-wiring/deploy bug
  // that cannot occur at request time, so crashing loudly is correct there.)
  try {
    validateStateShape(data);
  } catch (err) {
    console.error(`state save skipped: ${err.message}`);
    return;
  }
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
  savePersistentState,
  validateStateShape,
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
