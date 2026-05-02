// Dreamfinder — meetup music jukebox
// Pi plays music; admin mints QR codes for attendees;
// attendees scan, get a PWA-ish page, search YouTube, queue tracks.
// Single-file Node server, zero npm deps. SSE for live updates.

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const PORT = 3000;
const MPV_SOCK = '/tmp/dreamfinder-mpv.sock';
const PUBLIC_DIR = path.join(__dirname, 'public');

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
const identities = new Map(); // token -> { name, color, mintedAt }
const queue = [];             // [{ id, requesterName, color, videoId, title, thumbnail, addedAt }]
let nowPlaying = null;        // { ...trackEntry } | null
const sseClients = new Set(); // res objects

function broadcast() {
  const payload = JSON.stringify({ nowPlaying, queue });
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch(e) {}
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
    '--audio-device=alsa/plughw:CARD=vc4hdmi1,DEV=0',
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
  const next = queue.shift();
  nowPlaying = next;
  broadcast();
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
  if (method === 'GET' && p === '/admin') return serveStatic(res, 'admin.html');
  if (method === 'GET' && p === '/room')  return serveStatic(res, 'room.html');
  if (method === 'GET' && p.startsWith('/static/')) return serveStatic(res, p.slice('/static/'.length));

  // who am i (token in query)
  if (method === 'GET' && p === '/api/whoami') {
    const t = url.searchParams.get('t');
    const id = identities.get(t);
    if (!id) return send(res, 404, { error: 'unknown token' });
    return send(res, 200, { name: id.name, color: id.color });
  }

  // admin: list all minted attendees (for hydration after admin reload)
  if (method === 'GET' && p === '/api/attendees') {
    const out = [];
    for (const [token, id] of identities) {
      out.push({ token, name: id.name, color: id.color, mintedAt: id.mintedAt });
    }
    out.sort((a, b) => a.mintedAt - b.mintedAt);
    return send(res, 200, { attendees: out });
  }

  // admin: mint a new attendee
  if (method === 'POST' && p === '/api/mint') {
    const token = crypto.randomBytes(8).toString('hex');
    const name = generateName();
    const color = colorForName(name);
    identities.set(token, { name, color, mintedAt: Date.now() });
    return send(res, 200, { token, name, color });
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
      requesterName: id.name,
      color: id.color,
      videoId: body.videoId,
      title: body.title,
      thumbnail: body.thumbnail || `https://i.ytimg.com/vi/${body.videoId}/mqdefault.jpg`,
      addedAt: Date.now(),
    };
    queue.push(entry);
    broadcast();
    if (!nowPlaying) playNext();
    return send(res, 200, { ok: true, queued: entry });
  }

  // admin: skip current
  if (method === 'POST' && p === '/api/skip') {
    try { await mpvSend(['stop']); } catch(e) {}
    return send(res, 200, { ok: true });
  }

  // SSE event stream
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ nowPlaying, queue })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  res.writeHead(404); res.end('not found');
});

startMpv();
setTimeout(listenMpvEvents, 1500); // give mpv a moment to create the socket
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dreamfinder listening on http://0.0.0.0:${PORT}`);
});
