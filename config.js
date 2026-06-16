// Stage configuration — env-derived constants and frozen lookup sets.
// Leaf module: every other module (state, mpv, research) requires this rather
// than re-reading process.env, so env is read exactly once at load and config
// stays stable even if process.env were later mutated.

const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const MPV_SOCK = '/tmp/dreamfinder-mpv.sock';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = process.env.STAGE_STATE_FILE || path.join(__dirname, 'stage-state.json');
const HISTORY_LIMIT = 200;
const REPORT_LIMIT = 100;
const AUDIO_ENABLED = process.env.STAGE_NO_AUDIO !== '1';
const JOIN_URL = process.env.STAGE_JOIN_URL || 'https://imagineering.cc/stage';
const OPENAI_API_KEY = process.env.STAGE_OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.STAGE_OPENAI_MODEL || 'gpt-5.4-mini';
const GITHUB_TOKEN = process.env.STAGE_GITHUB_TOKEN || '';
const SHOW_MODES = new Set(['welcome', 'free-jukebox', 'sprint-build', 'sprint-share', 'sprint-break', 'cool-down']);
const VISUAL_THEMES = new Set(['aurora', 'nebula', 'prism', 'embers', 'ocean']);

module.exports = {
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
};
