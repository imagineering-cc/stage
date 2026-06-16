// --- sprint (autonomous Dreamfinder-hosted meetup sequencer) ---
// Sprint mode is Dreamfinder HOSTING the meetup: an ordered list of phases
// (welcome -> build/share x3 -> cool-down) that the engine drives ITSELF.
// When a phase's timer ends, Dreamfinder ducks the music, lands a soft chime,
// announces the next phase in its own voice, and ADVANCES — no human in the
// loop. The host can grab the wheel at any time (pause/resume/skip/extend/stop),
// but the DEFAULT is the room running the show.
//
// === THE ARCHITECTURE CRUX ===
// Autonomous advance rides the EXISTING state.js timer machinery, NOT a parallel
// setTimeout. state.js already (a) arms a setTimeout that fires markTimerEnded()
// at endsAt and (b) re-arms itself on boot from the persisted endsAt. A second
// sprint-owned timeout would be a competing source of truth (drift, double-fire,
// missed boot re-arm). So markTimerEnded() invokes the late-bound
// `state.hooks.onTimerEnded`, which this module subscribes to. Boot-resume comes
// for free: armTimerTimeout() fires (or immediately-ends) on boot, which calls
// the hook. armSprintOnBoot() then reconciles the persisted session explicitly —
// the double-safety (tolerant hook + explicit boot reconcile) is deliberate.
//
// The phase deadline IS room.timer.endsAt — there is NO separate sprint
// endsAt/startedAt. sprint reads room.timer for remaining time; advance/extend/
// pause/resume all manipulate the ONE timer through state.startTimer/clearTimer.
//
// Dependency direction: sprint -> {state, config, mpv}. sse-hub -> {state, sprint}
// and routes -> sprint, but neither is required back here, so there is no cycle.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');
const { AUDIO_ENABLED, WIND_DOWN_MS, DONE_HOLD_MS, CHIME_LEAD_MS, DUCK_FROM, DUCK_TO } = config;
const state = require('./state');
const { room } = state;

// mpv is required LAZILY (not at module top) on purpose. The static require graph
// is sse-hub -> sprint and mpv -> sse-hub; a top-level `require('./mpv')` here
// would close a cycle (sse-hub -> sprint -> mpv -> sse-hub) and hand mpv a
// half-initialised sse-hub whose `broadcast` is still undefined. Deferring the
// require to call-time (after all modules have finished loading) breaks the cycle
// without a hooks indirection, and audio is never touched at load time anyway.
function mpvSend(cmd) {
  return require('./mpv').mpvSend(cmd);
}

// The Imagineering 3x25 meetup spine. Modes are all in SHOW_MODES; visuals merge
// (partial) over current room.visuals via normalizeVisuals so each phase gives
// the room a distinct palette with no new render code. Durations are production
// values; tests override via {durations:[...ms...]}.
const DEFAULT_SPRINT_PLAN = [
  { mode: 'welcome',      label: 'Welcome & Intros', durationMs: 10 * 60 * 1000, visuals: { theme: 'aurora', energy: 0.55, complexity: 0.5 } },
  { mode: 'sprint-build', label: 'Build — Sprint 1', durationMs: 25 * 60 * 1000, visuals: { theme: 'nebula', energy: 0.85, complexity: 0.7 } },
  { mode: 'sprint-share', label: 'Share — Sprint 1', durationMs: 10 * 60 * 1000, visuals: { theme: 'prism',  energy: 0.7,  complexity: 0.6 } },
  { mode: 'sprint-break', label: 'Break',            durationMs:  5 * 60 * 1000, visuals: { theme: 'ocean',  energy: 0.35, complexity: 0.4 } },
  { mode: 'sprint-build', label: 'Build — Sprint 2', durationMs: 25 * 60 * 1000, visuals: { theme: 'nebula', energy: 0.85, complexity: 0.7 } },
  { mode: 'sprint-share', label: 'Share — Sprint 2', durationMs: 10 * 60 * 1000, visuals: { theme: 'prism',  energy: 0.7,  complexity: 0.6 } },
  { mode: 'sprint-break', label: 'Break',            durationMs:  5 * 60 * 1000, visuals: { theme: 'ocean',  energy: 0.35, complexity: 0.4 } },
  { mode: 'sprint-build', label: 'Build — Sprint 3', durationMs: 25 * 60 * 1000, visuals: { theme: 'nebula', energy: 0.85, complexity: 0.7 } },
  { mode: 'sprint-share', label: 'Share — Sprint 3', durationMs: 10 * 60 * 1000, visuals: { theme: 'prism',  energy: 0.7,  complexity: 0.6 } },
  { mode: 'cool-down',    label: 'Wrap-up & Reflect', durationMs: 10 * 60 * 1000, visuals: { theme: 'embers', energy: 0.3, complexity: 0.3 } },
];

// Dreamfinder's voice — templated persona copy keyed by mode, so renaming a
// human-facing label never desyncs the spoken line. LLM-authored patter is a
// follow-up; templated is enough for the first slice.
const dreamfinderCopy = {
  begin(ph) {
    const map = {
      'welcome': 'Welcome in — settle, say hello.',
      'sprint-build': `Heads down. ${ph.label} — make something.`,
      'sprint-share': `${ph.label} — show the room what you made.`,
      'sprint-break': 'Breathe. Stretch. Back soon.',
      'cool-down': 'That is a wrap. Let it land.',
      'free-jukebox': ph.label,
    };
    return map[ph.mode] || ph.label;
  },
  windDown(cur, next) { return `Wrapping up — ${next} is next.`; },
};

// Module-private ceremony handles. clearAllTimers() clears all four; EVERY
// transition entry point calls it first so there are never overlapping ramps,
// grace windows, or done-holds (a /skip during wind-down cancels the in-flight
// ceremony cleanly).
let duckInterval = null;
let graceTimeout = null;
let doneTimeout = null;
let chimeTimeout = null;
// Per-session wind-down override (tests pass a tiny value so the ceremony fits
// sub-second). null => use the config default. Not persisted in the plan.
let windDownOverrideMs = null;

function windDownMs() {
  return Number.isFinite(windDownOverrideMs) ? windDownOverrideMs : WIND_DOWN_MS;
}

function clearAllTimers() {
  if (duckInterval) { clearInterval(duckInterval); duckInterval = null; }
  if (graceTimeout) { clearTimeout(graceTimeout); graceTimeout = null; }
  if (doneTimeout) { clearTimeout(doneTimeout); doneTimeout = null; }
  if (chimeTimeout) { clearTimeout(chimeTimeout); chimeTimeout = null; }
}

// ── projection (the public wire field) ───────────────────────────────────────
// Only current+next phase are projected (the full plan is host-only via
// GET /api/sprint) to keep the public frame small. progress 0..1 is derived from
// the ONE timer, so the existing clock/progress-bar render needs no new data.
function sprintProjection() {
  const s = room.sprint;
  if (!s || s.status === 'idle') return null;
  const cur = s.plan[s.phaseIndex];
  const nxt = s.phaseIndex + 1 < s.plan.length ? s.plan[s.phaseIndex + 1] : null;
  let progress = 0;
  const t = room.timer;
  if (s.status === 'running' && t && Number.isFinite(t.endsAt) && cur.durationMs > 0) {
    progress = Math.min(1, Math.max(0, 1 - (t.endsAt - Date.now()) / cur.durationMs));
  } else if (s.status === 'winding-down') {
    progress = 1;
  } else if (s.status === 'paused' && cur.durationMs > 0 && Number.isFinite(s.pausedRemainingMs)) {
    progress = Math.min(1, Math.max(0, 1 - s.pausedRemainingMs / cur.durationMs));
  }
  return {
    status: s.status,
    phaseIndex: s.phaseIndex,
    totalPhases: s.plan.length,
    currentPhase: { label: cur.label, mode: cur.mode, durationMs: cur.durationMs, progress },
    nextPhase: nxt ? { label: nxt.label, mode: nxt.mode } : null,
  };
}

// ── phase application ────────────────────────────────────────────────────────
// Re-assert mode+visuals for a phase WITHOUT touching the timer or announcing —
// used on boot to make the TV correct without restarting/double-firing anything.
function applyPhaseVisualsAndMode(ph) {
  room.mode = ph.mode;
  if (ph.visuals) {
    room.visuals = state.normalizeVisuals({ ...room.visuals, ...ph.visuals, editedBy: 'Dreamfinder', editedAt: Date.now() });
  }
}

// Begin phase i: set mode+visuals, arm the ONE timer for its duration (which
// saves+broadcasts), and announce in the Dreamfinder voice.
function applyPhase(i) {
  const s = room.sprint;
  const ph = s.plan[i];
  applyPhaseVisualsAndMode(ph);
  state.startTimer({ durationMs: ph.durationMs, label: ph.label });
  state.showAnnouncement({
    title: 'Dreamfinder',
    message: dreamfinderCopy.begin(ph),
    detail: `${i + 1} of ${s.plan.length}`,
    durationMs: 5000,
    color: '#3b82f6',
  });
}

// ── wind-down ceremony (duck + chime + restore) ──────────────────────────────
function restoreVolumeImmediate() {
  if (AUDIO_ENABLED) mpvSend(['set_property', 'volume', DUCK_FROM]).catch(() => {});
}

function playChime() {
  if (!AUDIO_ENABLED) return;
  const wav = path.join(__dirname, 'public', 'chime.wav');
  if (!fs.existsSync(wav)) { console.log('[SPRINT] chime.wav missing; skipping chime'); return; }
  // Single mpv = single stream, so the chime CANNOT come from the main idle
  // instance without interrupting the ducked track. Spawn a short-lived SECOND
  // mpv so the chime mixes at ALSA over the ducked jukebox track. Self-reaps; a
  // 5s guard kills any hang (chime.wav is ~1-2s).
  let c;
  try {
    c = spawn('mpv', ['--no-video', '--no-terminal', '--idle=no', '--audio-device=alsa/plughw:CARD=vc4hdmi0,DEV=0', '--volume=55', wav], { stdio: 'ignore' });
  } catch (e) {
    console.error('[SPRINT] chime spawn failed', e.message);
    return;
  }
  c.on('error', e => console.error('[SPRINT] chime spawn failed', e.message));
  setTimeout(() => { if (c && !c.killed) c.kill('SIGTERM'); }, 5000);
}

// Enter the wind-down: announce, start ducking the music, schedule the chime,
// and schedule the advance after the grace window. Under !AUDIO_ENABLED there is
// no duck/chime but the graceTimeout still fires advancePhase(), so the FSM is
// fully testable headless. Per-session windDownMs keeps the test ceremony tiny.
function enterWindDown() {
  clearAllTimers();
  const s = room.sprint;
  s.status = 'winding-down';
  const curLabel = s.plan[s.phaseIndex].label;
  const nextLabel = s.phaseIndex + 1 < s.plan.length ? s.plan[s.phaseIndex + 1].label : 'Reflection';
  const wd = windDownMs();
  state.showAnnouncement({
    title: 'Dreamfinder',
    message: dreamfinderCopy.windDown(curLabel, nextLabel),
    detail: '',
    durationMs: Math.max(1000, wd),
    color: '#fbbf24',
  });
  state.savePersistentState();
  state.hooks.broadcast();

  if (AUDIO_ENABLED) {
    const ticks = Math.max(1, Math.floor(wd / 250));
    let n = 0;
    duckInterval = setInterval(() => {
      n++;
      const vol = Math.round(DUCK_FROM + (DUCK_TO - DUCK_FROM) * (n / ticks));
      mpvSend(['set_property', 'volume', Math.max(DUCK_TO, vol)]).catch(() => {});
      if (n >= ticks) { clearInterval(duckInterval); duckInterval = null; }
    }, 250);
    chimeTimeout = setTimeout(playChime, Math.max(0, wd - CHIME_LEAD_MS));
  }
  graceTimeout = setTimeout(() => { graceTimeout = null; restoreVolumeImmediate(); advancePhase(); }, wd);
}

// Advance to the next phase, or finish the session. Always restores volume and
// clears the ceremony timers first.
function advancePhase() {
  clearAllTimers();
  const s = room.sprint;
  if (!s) return;
  restoreVolumeImmediate();
  s.phaseIndex++;
  if (s.phaseIndex >= s.plan.length) {
    // Session complete: hold cool-down for DONE_HOLD_MS, then clear to idle.
    s.status = 'done';
    s.phaseIndex = s.plan.length - 1; // keep index in range for the projection
    room.mode = 'cool-down';
    state.showAnnouncement({ title: 'Dreamfinder', message: 'All sprints complete. Thank you.', detail: '', durationMs: 8000, color: '#10b981' });
    state.savePersistentState();
    state.hooks.broadcast();
    doneTimeout = setTimeout(() => {
      doneTimeout = null;
      room.sprint = null;
      windDownOverrideMs = null;
      state.savePersistentState();
      state.hooks.broadcast();
    }, DONE_HOLD_MS);
    return;
  }
  s.status = 'running';
  applyPhase(s.phaseIndex);
  state.savePersistentState();
  state.hooks.broadcast();
}

// ── the timer-end hook (autonomous advance entry point) ──────────────────────
// markTimerEnded() calls this AFTER setting status:'ended'. Only a RUNNING phase
// reacts; paused/winding-down/done/idle ignore a timer end (tolerant of being
// called before armSprintOnBoot during boot's armTimerTimeout — see header).
function onTimerEnded() {
  if (room.sprint && room.sprint.status === 'running') enterWindDown();
}

// ── boot reconcile ───────────────────────────────────────────────────────────
// Called by the composition root AFTER wireHooks + armTimerTimeout. room.sprint
// is already hydrated+validated by state.js's load. Drive the correct resume.
function armSprintOnBoot() {
  const s = room.sprint;
  if (!s || s.status === 'idle' || s.status === 'done') {
    // 'done' was a transient hold; on a cold boot just clear it to idle.
    if (s && s.status === 'done') { room.sprint = null; }
    return;
  }
  applyPhaseVisualsAndMode(s.plan[s.phaseIndex]); // re-assert TV mode+visuals (no timer restart)
  if (s.status === 'paused') return; // host paused pre-restart; room.timer was cleared at pause. Wait for /resume.
  if (s.status === 'running') {
    // armTimerTimeout() already re-armed the persisted timer or already fired it.
    if (!room.timer || room.timer.status === 'ended') {
      enterWindDown(); // the phase ended while we were down — catch up.
    }
    // else: timer is re-armed; its end will hit onTimerEnded. Nothing to do.
    return;
  }
  if (s.status === 'winding-down') {
    // Crashed mid-ceremony. Don't resume a partial ramp — finish the transition.
    restoreVolumeImmediate();
    advancePhase();
  }
}

// ── plan building / validation ───────────────────────────────────────────────
function buildPlan({ plan, durations } = {}) {
  if (Array.isArray(plan)) {
    // Custom plan: validate each phase against the SAME shape the persist gate
    // uses. Throw on a bad phase so the route can 400.
    const out = plan.map((ph, i) => {
      if (!ph || typeof ph !== 'object') throw new Error(`plan[${i}] is not an object`);
      if (!config.SHOW_MODES.has(ph.mode)) throw new Error(`plan[${i}].mode "${ph.mode}" not in SHOW_MODES`);
      const durationMs = Number(ph.durationMs);
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`plan[${i}].durationMs must be a positive number`);
      const label = state.cleanText(ph.label, 60) || ph.mode;
      const phase = { mode: ph.mode, label, durationMs };
      if (ph.visuals !== undefined) {
        if (typeof ph.visuals !== 'object' || ph.visuals === null || Array.isArray(ph.visuals)) throw new Error(`plan[${i}].visuals is not an object`);
        phase.visuals = ph.visuals;
      }
      return phase;
    });
    if (out.length === 0) throw new Error('plan must have at least one phase');
    return out;
  }
  // Default plan, with optional per-phase millisecond duration overrides (tests).
  const base = DEFAULT_SPRINT_PLAN.map(ph => ({ ...ph }));
  if (Array.isArray(durations)) {
    const out = durations.map((ms, i) => {
      const durationMs = Number(ms);
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`durations[${i}] must be a positive number of ms`);
      const tmpl = base[i] || base[base.length - 1];
      return { ...tmpl, durationMs };
    });
    if (out.length === 0) throw new Error('durations must have at least one entry');
    return out;
  }
  return base;
}

// ── host control transitions (each throws on a precondition violation; the
//    route wraps the throw into a 409) ─────────────────────────────────────────
function startSprint({ plan, durations, windDownMs: wdOverride } = {}) {
  if (room.sprint && room.sprint.status !== 'idle') {
    throw new Error('a sprint session is already running; stop it first');
  }
  clearAllTimers();
  const builtPlan = buildPlan({ plan, durations });
  if (Number.isFinite(wdOverride)) {
    windDownOverrideMs = Math.min(5 * 60 * 1000, Math.max(0, Number(wdOverride)));
  } else {
    windDownOverrideMs = null;
  }
  room.sprint = {
    sessionId: crypto.randomBytes(8).toString('hex'),
    plan: builtPlan,
    phaseIndex: 0,
    status: 'running',
    pausedRemainingMs: null,
  };
  applyPhase(0);
  state.savePersistentState();
  state.hooks.broadcast();
  return sprintProjection();
}

function pauseSprint() {
  const s = room.sprint;
  if (!s || s.status !== 'running') throw new Error('no running sprint phase to pause');
  clearAllTimers();
  const t = room.timer;
  s.pausedRemainingMs = t && Number.isFinite(t.endsAt) ? Math.max(0, t.endsAt - Date.now()) : s.plan[s.phaseIndex].durationMs;
  s.status = 'paused';
  state.clearTimer(); // cancels the timeout + nulls room.timer (saves + broadcasts)
  if (AUDIO_ENABLED) mpvSend(['set_property', 'pause', true]).catch(() => {});
  state.savePersistentState();
  state.hooks.broadcast();
  return sprintProjection();
}

function resumeSprint() {
  const s = room.sprint;
  if (!s || s.status !== 'paused') throw new Error('no paused sprint to resume');
  const remaining = Number.isFinite(s.pausedRemainingMs) && s.pausedRemainingMs > 0 ? s.pausedRemainingMs : 1000;
  s.status = 'running';
  s.pausedRemainingMs = null;
  if (AUDIO_ENABLED) mpvSend(['set_property', 'pause', false]).catch(() => {});
  state.startTimer({ durationMs: remaining, label: s.plan[s.phaseIndex].label }); // saves + broadcasts + re-arms the one timer
  state.savePersistentState();
  state.hooks.broadcast();
  return sprintProjection();
}

function skipPhase() {
  const s = room.sprint;
  if (!s || (s.status !== 'running' && s.status !== 'winding-down')) {
    throw new Error('no running or winding-down sprint phase to skip');
  }
  if (s.status === 'running') {
    enterWindDown(); // full ceremony, just early
  } else {
    // already winding down — cancel the in-flight ramp/grace and advance now
    clearAllTimers();
    restoreVolumeImmediate();
    advancePhase();
  }
  return sprintProjection();
}

function extendSprint({ minutes, seconds } = {}) {
  const s = room.sprint;
  if (!s || s.status !== 'running') throw new Error('no running sprint phase to extend');
  const extendMs = Math.round((Number(seconds) || Number(minutes) * 60 || 0) * 1000);
  if (!Number.isFinite(extendMs) || extendMs < 1000 || extendMs > 60 * 60 * 1000) {
    throw new Error('extension must be between 1 second and 60 minutes');
  }
  const t = room.timer;
  const remaining = t && Number.isFinite(t.endsAt) ? Math.max(0, t.endsAt - Date.now()) : 0;
  state.startTimer({ durationMs: remaining + extendMs, label: s.plan[s.phaseIndex].label }); // re-arms the one timer
  state.savePersistentState();
  state.hooks.broadcast();
  return sprintProjection();
}

function stopSprint() {
  const s = room.sprint;
  if (!s || s.status === 'idle') throw new Error('no sprint session to stop');
  clearAllTimers();
  windDownOverrideMs = null;
  restoreVolumeImmediate();
  if (AUDIO_ENABLED) mpvSend(['set_property', 'pause', false]).catch(() => {});
  state.clearTimer();          // cancels timeout + nulls room.timer (saves + broadcasts)
  room.mode = 'free-jukebox';  // hand the room back to the jukebox
  room.sprint = null;
  state.clearAnnouncement();
  state.savePersistentState();
  state.hooks.broadcast();
  return null;
}

module.exports = {
  DEFAULT_SPRINT_PLAN,
  sprintProjection,
  onTimerEnded,
  armSprintOnBoot,
  startSprint,
  pauseSprint,
  resumeSprint,
  skipPhase,
  extendSprint,
  stopSprint,
};
