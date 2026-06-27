// --- The Voice, made AUDIBLE (Two Minds, Slice 4) ---
//
// voice.js produces Dreamfinder's clean, in-character TEXT (the OPENAI_MODEL
// Responses call + the persona fence). THIS module turns that text into SPOKEN
// audio and plays it through the SAME HDMI ALSA device the music uses (mpv.js), so
// Dreamfinder speaks out of the room's TV.
//
//   utterance.text  ──▶  OpenAI TTS (TTS_MODEL, voice=fable)  ──▶  /tmp/*.mp3
//                                                                     │
//                                          mpv --audio-device=HDMI ───┘  (TV speakers)
//
// CONTRACT:
//   • FIRE-AND-FORGET + TOTAL. speakAloud() never throws and never blocks the
//     caller (the spotlight-finish response). Any failure (no key, API error,
//     mpv missing, device busy) is swallowed with a log — the room simply stays
//     quiet, exactly like voice.js degrades text to a template.
//   • SILENT IN TESTS/CI. When STAGE_NO_AUDIO=1 (the smoke/unit suites and any
//     headless run) it returns immediately WITHOUT a network call or a spawn, so
//     the suite never hits OpenAI and never spawns mpv.
//   • DEVICE CONTENTION is the same ALSA-exclusivity question as the sprint chime
//     (task #14): the music mpv holds the HDMI device while a track plays. The
//     Voice fires at BARGE-IN (a spotlight finishing), when no track is playing,
//     so the device is free — verified on the Pi 2026-06-27. If a track IS playing,
//     mpv's second open fails and speakAloud degrades to silence (logged). Layering
//     over music (dmix) is the task-#14 follow-up, deliberately out of scope here.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  OPENAI_API_KEY,
  TTS_MODEL,
  TTS_VOICE,
  TTS_INSTRUCTIONS,
  VOICE_AUDIO_DEVICE,
  AUDIO_ENABLED,
} = require('./config');

// Hard cap on synthesized text. Dreamfinder speaks ONE or TWO sentences; this
// bounds both the metered TTS cost and the spoken duration regardless of caller.
const MAX_SPEAK_CHARS = 600;
// TTS call ceiling — the room must not hold a process waiting on a slow synth.
const TTS_TIMEOUT_MS = 15 * 1000;

// Synthesize `text` to an mp3 buffer via the OpenAI speech API, or null on any
// failure. NEVER throws. Mirrors voice.js/research.js's graceful-null shape.
async function synthesize(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input: text.slice(0, MAX_SPEAK_CHARS),
        instructions: TTS_INSTRUCTIONS,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[VOICE-AUDIO] TTS http ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error('[VOICE-AUDIO] synthesize failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Play an mp3 file through the HDMI ALSA device, fire-and-forget, then delete the
// temp file when mpv exits (or on spawn error). Never throws.
function playThroughHdmi(file) {
  try {
    const proc = spawn('mpv', ['--no-video', `--audio-device=${VOICE_AUDIO_DEVICE}`, '--really-quiet', file], {
      stdio: 'ignore',
    });
    const cleanup = () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    proc.on('exit', cleanup);
    proc.on('error', (err) => { console.error('[VOICE-AUDIO] mpv spawn failed:', err.message); cleanup(); });
  } catch (err) {
    console.error('[VOICE-AUDIO] playThroughHdmi failed:', err.message);
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

// speakAloud(text) — the one public entry. Synthesize Dreamfinder's line and play
// it through the TV. Fire-and-forget: returns a promise that always resolves (for
// tests), never rejects. No-ops silently when there's nothing to say, no key, or
// audio is disabled (CI/headless) — BEFORE any network call or spawn.
async function speakAloud(text) {
  if (!AUDIO_ENABLED) return;                  // STAGE_NO_AUDIO=1: never synth or spawn
  if (!OPENAI_API_KEY) return;                 // template-only world: nothing to voice
  const line = typeof text === 'string' ? text.trim() : '';
  if (!line) return;
  const mp3 = await synthesize(line);
  if (!mp3 || !mp3.length) return;
  const file = path.join(os.tmpdir(), `df-voice-${crypto.randomBytes(6).toString('hex')}.mp3`);
  try {
    fs.writeFileSync(file, mp3);
  } catch (err) {
    console.error('[VOICE-AUDIO] temp write failed:', err.message);
    return;
  }
  playThroughHdmi(file);
}

module.exports = { speakAloud };
