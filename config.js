// Stage configuration — env-derived constants and frozen lookup sets.
// Leaf module: every other module (state, mpv, research) requires this rather
// than re-reading process.env, so env is read exactly once at load and config
// stays stable even if process.env were later mutated.

const path = require('path');

// Engine wire-protocol version — stamped onto every SSE statePayload so any
// frontend (guest PWA, admin, room TV, and future native apps like webOS) can
// detect a breaking change to the contract documented in ENGINE.md. Bump ONLY
// on a breaking change (field removed/renamed, or semantics changed); additive
// fields do NOT bump it. Frontends should warn — not hard-fail — on a higher
// major than they know, so an updated engine degrades gracefully on old clients.
const ENGINE_PROTOCOL_VERSION = 1;

const PORT = Number(process.env.PORT || 3000);
const MPV_SOCK = '/tmp/dreamfinder-mpv.sock';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = process.env.STAGE_STATE_FILE || path.join(__dirname, 'stage-state.json');
const HISTORY_LIMIT = 200;
const REPORT_LIMIT = 100;
const AUDIO_ENABLED = process.env.STAGE_NO_AUDIO !== '1';
const JOIN_URL = process.env.STAGE_JOIN_URL || 'https://imagineering.cc/stage';
// STAGE_OPENAI_API_KEY (namespaced) wins; falls back to the canonical OPENAI_API_KEY
// from ~/.claude/.env so the key is single-sourced rather than duplicated per project.
// On the Pi the private systemd drop-in supplies STAGE_OPENAI_API_KEY (its deploy copy);
// for local dev, `source ~/.claude/.env` exposes OPENAI_API_KEY and this picks it up.
const OPENAI_API_KEY = process.env.STAGE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.STAGE_OPENAI_MODEL || 'gpt-5.4-mini';
const GITHUB_TOKEN = process.env.STAGE_GITHUB_TOKEN || '';
const SHOW_MODES = new Set(['welcome', 'free-jukebox', 'sprint-build', 'sprint-share', 'sprint-break', 'cool-down']);

// M5 personal-pulse bound. A guest gesture (phone shake / deliberate submit)
// injects a TRANSIENT, identity-keyed burst into the shared room canvas via the
// `visualEvent` wire field. This is the per-token cooldown that keeps the burst
// BOUNDED rather than continuous: no single participant may overwrite the shared
// background more often than once per this window, so the room can't be spammed
// or held by one phone. Distinct from a sub-second anti-double-fire debounce —
// this is the M5 "distinct variations without continuous overwriting" invariant.
// Env-overridable so tests can pin a deterministic window; production default 4s.
const GESTURE_COOLDOWN_MS = Number(process.env.STAGE_GESTURE_COOLDOWN_MS || 4000);
const VISUAL_THEMES = new Set(['aurora', 'nebula', 'prism', 'embers', 'ocean']);

// Sprint-mode (autonomous Dreamfinder host) timing constants. WIND_DOWN_MS is
// the duration of the graceful musical wind-down at each phase boundary: the
// currently-playing jukebox track is ducked from DUCK_FROM down to DUCK_TO over
// this window, a soft chime lands CHIME_LEAD_MS before the boundary, then volume
// is restored as the next phase begins. DONE_HOLD_MS holds the 'cool-down' phase
// after the final phase ends before the session clears to idle. All overridable
// per-start (windDownMs) only for tests; durations are the production defaults.
const WIND_DOWN_MS = Number(process.env.STAGE_WIND_DOWN_MS || 45000);
const DONE_HOLD_MS = Number(process.env.STAGE_DONE_HOLD_MS || 30000);
const CHIME_LEAD_MS = Number(process.env.STAGE_CHIME_LEAD_MS || 10000);
const DUCK_FROM = 70; // matches mpv's --volume=70 start
const DUCK_TO = 8;    // soft floor the track ducks to under the chime

module.exports = {
  ENGINE_PROTOCOL_VERSION,
  PORT,
  MPV_SOCK,
  PUBLIC_DIR,
  STATE_FILE,
  HISTORY_LIMIT,
  REPORT_LIMIT,
  AUDIO_ENABLED,
  JOIN_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  GITHUB_TOKEN,
  SHOW_MODES,
  VISUAL_THEMES,
  GESTURE_COOLDOWN_MS,
  WIND_DOWN_MS,
  DONE_HOLD_MS,
  CHIME_LEAD_MS,
  DUCK_FROM,
  DUCK_TO,
};
