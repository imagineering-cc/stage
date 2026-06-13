// Dreamfinder — meetup room stage
// Pi plays music; room/admin shows a stable join QR;
// attendees join, get a PWA-ish page, search YouTube, queue tracks.
// Single-file Node server, zero npm deps. SSE for live updates.

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const MPV_SOCK = '/tmp/dreamfinder-mpv.sock';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = process.env.STAGE_STATE_FILE || path.join(__dirname, 'stage-state.json');
const HISTORY_LIMIT = 200;
const AUDIO_ENABLED = process.env.STAGE_NO_AUDIO !== '1';
const JOIN_URL = process.env.STAGE_JOIN_URL || 'https://imagineering.cc/stage';

// --- name generator (Dreamfinder handles) ---
const ADJECTIVES = ['Indigo','Velvet','Crimson','Silver','Golden','Cobalt','Amber','Jade','Coral','Ivory','Onyx','Ruby','Saffron','Azure','Verdant','Lilac','Russet','Ochre','Pearl','Obsidian'];
const ANIMALS   = ['Heron','Fox','Otter','Lynx','Owl','Stag','Hare','Falcon','Wolf','Mantis','Wren','Lark','Magpie','Raven','Badger','Marten','Swift','Kestrel','Ibis','Crane'];
function generateName() {
  const a = ADJECTIVES[Math.floor(Math.random()*ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random()*ANIMALS.length)];
  return `${a} ${b}`;
}
function colorForName(name) {
  // Deterministic pleasing hue from the name; saturation/lightness fixed.
  const h = crypto.createHash('md5').update(name).digest();
  const hue = h[0] * 360 / 256;
  return `hsl(${hue.toFixed(0)}, 60%, 55%)`;
}

// --- state ---
function loadPersistentState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('state load failed', err.message);
    return {};
  }
}

const savedState = loadPersistentState();
const savedIdentities = Array.isArray(savedState.identities)
  ? savedState.identities.filter(item => Array.isArray(item) && item.length === 2)
  : [];
const identities = new Map(savedIdentities); // token -> { name, color, mintedAt }
const playHistory = Array.isArray(savedState.playHistory)
  ? savedState.playHistory.slice(0, HISTORY_LIMIT)
  : [];
const queue = Array.isArray(savedState.queue)
  ? savedState.queue.filter(track => track && typeof track.id === 'string')
  : [];                       // [{ id, requesterToken, requesterName, color, videoId, title, thumbnail, addedAt, voterTokens }]
let nowPlaying = null;        // { ...trackEntry } | null
const lastPlayedRequesterByVotes = savedState.lastPlayedRequesterByVotes &&
  typeof savedState.lastPlayedRequesterByVotes === 'object'
  ? { ...savedState.lastPlayedRequesterByVotes }
  : { 0: savedState.lastPlayedRequesterToken || null };
const sseClients = new Set(); // { res, includeSpotlight } stream clients

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

function savePersistentState() {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  const data = JSON.stringify({
    identities: Array.from(identities.entries()),
    playHistory,
    queue,
    lastPlayedRequesterByVotes,
  }, null, 2);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('state save failed', err.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function createIdentity() {
  const token = crypto.randomBytes(16).toString('hex');
  const name = generateName();
  const color = colorForName(name);
  identities.set(token, { name, color, mintedAt: Date.now() });
  savePersistentState();
  return { token, name, color };
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
    githubHandle: normalizeGithubHandle(id.githubHandle),
  };
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
  playHistory.unshift({ ...publicTrack(track), playedAt: Date.now() });
  playHistory.length = Math.min(playHistory.length, HISTORY_LIMIT);
  savePersistentState();
}

function statePayload({ includeSpotlight = false } = {}) {
  const payload = {
    nowPlaying: publicTrack(nowPlaying),
    queue: publicQueue(),
  };
  return payload;
}

function broadcast() {
  const publicPayload = JSON.stringify(statePayload());
  const showPayload = JSON.stringify(statePayload({ includeSpotlight: true }));
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${client.includeSpotlight ? showPayload : publicPayload}\n\n`);
    } catch(e) {}
  }
}

// --- mpv control ---
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
        if (nowPlaying) { nowPlaying = null; broadcast(); }
        playNext();
      }
    }
  });
  sock.on('error', () => setTimeout(listenMpvEvents, 1000));
  sock.on('close', () => setTimeout(listenMpvEvents, 1000));
}

async function playNext() {
  if (!queue.length) { nowPlaying = null; broadcast(); return; }
  sortQueue();
  const next = queue.shift();
  lastPlayedRequesterByVotes[String(voteCount(next))] = next.requesterToken;
  sortQueue();
  nowPlaying = next;
  recordPlay(next);
  broadcast();
  if (!AUDIO_ENABLED) return;
  const url = `https://www.youtube.com/watch?v=${next.videoId}`;
  try {
    await mpvSend(['loadfile', url, 'replace']);
  } catch(e) {
    console.error('mpv loadfile failed', e);
    nowPlaying = null;
    broadcast();
    playNext();
  }
}

// --- yt-dlp search ---
function ytSearch(query) {
  return new Promise((resolve) => {
    execFile('yt-dlp', [
      '--flat-playlist', '--dump-json', '--no-warnings',
      '--default-search', 'ytsearch5',
      `ytsearch5:${query}`
    ], { maxBuffer: 1024*1024*8, timeout: 15000 }, (err, stdout) => {
      if (err) { console.error('yt-dlp search err', err.message); return resolve([]); }
      const lines = stdout.split('\n').filter(l => l.trim());
      const out = [];
      for (const l of lines) {
        try {
          const j = JSON.parse(l);
          out.push({
            videoId: j.id,
            title: j.title,
            thumbnail: j.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`,
            duration: j.duration,
            channel: j.channel || j.uploader,
          });
        } catch(e) {}
      }
      resolve(out);
    });
  });
}

// --- HTTP helpers ---
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
  });
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(p);
    const ct = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}

// --- routes ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method;

  // pages
  if (method === 'GET' && p === '/')      return serveStatic(res, 'index.html');
  if (method === 'GET' && p === '/stage') return serveStatic(res, 'index.html');
  if (method === 'GET' && p === '/admin') return serveStatic(res, 'admin.html');
  if (method === 'GET' && p === '/room')  return serveStatic(res, 'room.html');
  if (method === 'GET' && p.startsWith('/static/')) return serveStatic(res, p.slice('/static/'.length));

  // room/admin configuration kept local with those host surfaces
  if (method === 'GET' && p === '/api/config') {
    return send(res, 200, { joinUrl: JOIN_URL });
  }

  // who am i (token in query)
  if (method === 'GET' && p === '/api/whoami') {
    const t = url.searchParams.get('t');
    const id = identities.get(t);
    if (!id) return send(res, 404, { error: 'unknown token' });
    return send(res, 200, participantProfile(id));
  }

  // admin: list all minted attendees (for hydration after admin reload)
  if (method === 'GET' && p === '/api/attendees') {
    const out = [];
    for (const [token, id] of identities) {
      out.push({ token, ...participantProfile(id), mintedAt: id.mintedAt });
    }
    out.sort((a, b) => a.mintedAt - b.mintedAt);
    return send(res, 200, { attendees: out });
  }

  // admin: recently selected tracks, retained across restarts
  if (method === 'GET' && p === '/api/history') {
    return send(res, 200, { tracks: playHistory });
  }

  // admin: mint a new attendee
  if (method === 'POST' && p === '/api/mint') {
    return send(res, 200, createIdentity());
  }

  // guest: self-join and receive an identity
  if (method === 'POST' && p === '/api/join') {
    return send(res, 200, createIdentity());
  }

  // search
  if (method === 'GET' && p === '/api/search') {
    const q = url.searchParams.get('q');
    if (!q) return send(res, 400, { error: 'missing q' });
    const results = await ytSearch(q);
    return send(res, 200, { results });
  }

  // queue a track
  if (method === 'POST' && p === '/api/queue') {
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    if (!body.videoId || !body.title) return send(res, 400, { error: 'missing videoId/title' });
    const entry = {
      id: crypto.randomBytes(4).toString('hex'),
      requesterToken: body.token,
      requesterName: identityDisplayName(id),
      color: id.color,
      videoId: body.videoId,
      title: body.title,
      thumbnail: body.thumbnail || `https://i.ytimg.com/vi/${body.videoId}/mqdefault.jpg`,
      addedAt: Date.now(),
      voterTokens: [],
    };
    queue.push(entry);
    sortQueue();
    savePersistentState();
    broadcast();
    if (!nowPlaying) playNext();
    return send(res, 200, { ok: true, queued: publicTrack(entry) });
  }

  // guest: current user's votes for queued tracks
  if (method === 'GET' && p === '/api/votes') {
    const t = url.searchParams.get('t');
    const id = identities.get(t);
    if (!id) return send(res, 404, { error: 'unknown token' });
    const trackIds = queue
      .filter(track => Array.isArray(track.voterTokens) && track.voterTokens.includes(t))
      .map(track => track.id);
    const ownedTrackIds = queue
      .filter(track => track.requesterToken === t)
      .map(track => track.id);
    return send(res, 200, { trackIds, ownedTrackIds });
  }

  // guest: toggle one upvote on a queued track
  if (method === 'POST' && p === '/api/upvote') {
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    const track = queue.find(item => item.id === body.trackId);
    if (!track) return send(res, 404, { error: 'track is no longer queued' });
    if (track.requesterToken === body.token) {
      return send(res, 409, { error: 'cannot vote for your own track' });
    }
    if (!Array.isArray(track.voterTokens)) track.voterTokens = [];
    const existing = track.voterTokens.indexOf(body.token);
    const voted = existing === -1;
    if (voted) {
      track.voterTokens.push(body.token);
    } else {
      track.voterTokens.splice(existing, 1);
    }
    sortQueue();
    savePersistentState();
    broadcast();
    return send(res, 200, { ok: true, voted, track: publicTrack(track), queue: publicQueue() });
  }

  // admin: skip current
  if (method === 'POST' && p === '/api/skip') {
    try { await mpvSend(['stop']); } catch(e) {}
    return send(res, 200, { ok: true });
  }

  // Public SSE stream: deliberately excludes live transcripts and research.
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(statePayload())}\n\n`);
    const client = { res, includeSpotlight: false };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  // Local room/admin stream. This must not be exposed through the public proxy.
  if (method === 'GET' && p === '/api/show-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(statePayload({ includeSpotlight: true }))}\n\n`);
    const client = { res, includeSpotlight: true };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  res.writeHead(404); res.end('not found');
});

sortQueue();
if (AUDIO_ENABLED) {
  startMpv();
  setTimeout(() => {
    listenMpvEvents();
    if (queue.length) playNext();
  }, 1500); // give mpv a moment to create the socket
} else if (queue.length) {
  playNext();
}
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dreamfinder listening on http://0.0.0.0:${PORT}`);
});
