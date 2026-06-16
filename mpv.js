// --- mpv control ---
// Owns the audio playback engine: spawning mpv, sending it JSON IPC commands,
// listening for end-of-track events, and advancing the queue (`playNext`).
//
// These four functions move together on purpose: `playNext` is the sole callback
// of `listenMpvEvents` and recurses on a loadfile error, so splitting them would
// risk duplicate socket-listener loops. `playNext` mutates shared room state
// (`room.nowPlaying`, the in-place `queue`, `lastPlayedRequesterByVotes`) and
// calls state/sse-hub helpers — all reached through the live references owned by
// state.js, so semantics are identical to the single-file version.
//
// Dependency direction is one-way: mpv requires state/config/sse-hub, never the
// reverse. state.js reaches back here only through its late-bound
// `hooks.playNext` (wired by the composition root in server.js). `playNext` also
// needs `currentEventId`, which still lives in server.js (event-session
// lifecycle), reached through the same `state.hooks.currentEventId` indirection.

const net = require('net');
const { spawn } = require('child_process');

const { MPV_SOCK, AUDIO_ENABLED } = require('./config');

const state = require('./state');
const {
  room,
  queue,
  sortQueue,
  voteCount,
  recordPlay,
  lastPlayedRequesterByVotes,
} = state;

const { broadcast } = require('./sse-hub');

let mpv;
function startMpv() {
  // --no-video: audio only. --idle: stay alive between tracks. --no-terminal: no stdin handling.
  mpv = spawn('mpv', [
    '--no-video',
    '--idle=yes',
    '--no-terminal',
    `--input-ipc-server=${MPV_SOCK}`,
    '--audio-display=no',
    '--audio-device=alsa/plughw:CARD=vc4hdmi0,DEV=0',
    '--volume=70',
    '--ytdl-format=bestaudio',
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  mpv.on('exit', (code) => {
    console.log(`mpv exited (${code}); restarting in 1s`);
    setTimeout(startMpv, 1000);
  });
}

function mpvSend(cmd) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(MPV_SOCK);
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify({ command: cmd }) + '\n'));
    sock.on('data', d => {
      buf += d.toString();
      const line = buf.split('\n').find(l => l.trim());
      if (line) {
        try { resolve(JSON.parse(line)); } catch(e) { resolve(null); }
        sock.end();
      }
    });
    sock.on('error', reject);
  });
}

// Listen for end-of-track events on a separate persistent connection.
function listenMpvEvents() {
  const sock = net.createConnection(MPV_SOCK);
  let buf = '';
  sock.on('connect', () => {
    sock.write(JSON.stringify({ command: ['observe_property', 1, 'idle-active'] }) + '\n');
  });
  sock.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch(e) { continue; }
      if (msg.event === 'property-change' && msg.name === 'idle-active' && msg.data === true) {
        // mpv finished playing (or was idle from start). Advance.
        if (room.nowPlaying) { room.nowPlaying = null; broadcast(); }
        playNext();
      }
    }
  });
  sock.on('error', () => setTimeout(listenMpvEvents, 1000));
  sock.on('close', () => setTimeout(listenMpvEvents, 1000));
}

async function playNext() {
  // No playback without an open event — closing stops the show even if the mpv
  // idle observer fires after the queue was cleared.
  if (!state.hooks.currentEventId()) { room.nowPlaying = null; broadcast(); return; }
  if (!queue.length) { room.nowPlaying = null; broadcast(); return; }
  sortQueue();
  const next = queue.shift();
  lastPlayedRequesterByVotes[String(voteCount(next))] = next.requesterToken;
  sortQueue();
  room.nowPlaying = next;
  recordPlay(next);
  broadcast();
  if (!AUDIO_ENABLED) return;
  const url = `https://www.youtube.com/watch?v=${next.videoId}`;
  try {
    await mpvSend(['loadfile', url, 'replace']);
  } catch(e) {
    console.error('mpv loadfile failed', e);
    room.nowPlaying = null;
    broadcast();
    playNext();
  }
}

module.exports = { startMpv, mpvSend, listenMpvEvents, playNext };
