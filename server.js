// Dreamfinder — meetup room stage
// Pi plays music; room/admin shows a stable join QR;
// attendees join, get a PWA-ish page, search YouTube, queue tracks;
// admin can run a visible timer and the room page alarms when it ends.
// Single-file Node server, zero npm deps. SSE for live updates.

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const crypto = require('crypto');

const {
  PORT,
  MPV_SOCK,
  PUBLIC_DIR,
  REPORT_LIMIT,
  AUDIO_ENABLED,
  JOIN_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  GITHUB_TOKEN,
  SHOW_MODES,
} = require('./config');
// Closed set of event states — a frozen constant so the room's state machine
// can't be driven by a stray string literal typo.
const EVENT_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

// --- state ---
// The mutable-state nexus lives in state.js, which OWNS every shared mutable
// global. Reassigned scalars (nowPlaying/timer/mode/announcement/visuals/
// visualEvent/spotlight) are held as fields on the exported `room` holder and
// read fresh as `room.x`; reference-stable containers (identities/queue/...) are
// shared by live reference. state.js reaches back into sse-hub/mpv/event-session
// via its mutable `hooks` registry, wired by this composition root below.
const state = require('./state');
const {
  room,
  identities,
  queue,
  playHistory,
  reports,
  lastPlayedRequesterByVotes,
  sseClients,
  gestureTimes,
  loadPersistentState,
  savePersistentState,
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
  currentTimer,
  markTimerEnded,
  startTimer,
  armTimerTimeout,
  clearTimer,
  currentAnnouncement,
  showAnnouncement,
  clearAnnouncement,
} = state;

const savedState = loadPersistentState();

// --- event session lifecycle ---
// One host-controlled event gates all guest participation. With no open event,
// guests see a friendly closed room and cannot mutate any state. The event
// carries only identity/title/status/dates — the live phase stays in `mode`
// (its single source of truth) and is surfaced as `phase` in the payload.
function normalizeEvent(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    title: cleanText(value.title, 100) || 'Imagineering Meetup',
    status: value.status === EVENT_STATUS.OPEN ? EVENT_STATUS.OPEN : EVENT_STATUS.CLOSED,
    openedAt: Number(value.openedAt) || null,
    closedAt: Number(value.closedAt) || null,
  };
}
let event = normalizeEvent(savedState.event);
const eventsArchive = Array.isArray(savedState.eventsArchive)
  ? savedState.eventsArchive.map(normalizeEvent).filter(Boolean)
  : [];
// Migration: a deployment that predates the event model but has live
// participants keeps running uninterrupted — wrap its state in an open event
// rather than locking the room the instant this code ships. Fresh installs
// (no identities, no queue) start closed: the host opens the first event.
if (!event && (identities.size > 0 || queue.length > 0)) {
  const migratedId = crypto.randomBytes(6).toString('hex');
  event = { id: migratedId, title: 'Imagineering Meetup', status: EVENT_STATUS.OPEN, openedAt: Date.now(), closedAt: null };
  // Identities carry an eventIds *array*: a participant may attend many events,
  // so attendance is many-to-many, not a single bolted-on id.
  for (const identity of identities.values()) if (!Array.isArray(identity.eventIds)) identity.eventIds = [migratedId];
  for (const track of queue) if (!track.eventId) track.eventId = migratedId;
  for (const entry of playHistory) if (!entry.eventId) entry.eventId = migratedId;
  for (const report of reports) if (!report.eventId) report.eventId = migratedId;
}

// --- SSE payload + broadcast ---
// These read state but BELONG to sse-hub (state must not depend on sse), so they
// stay here in the composition root; state.js calls broadcast via its `hooks`.
function statePayload({ includeSpotlight = false } = {}) {
  const payload = {
    event: publicEvent(),
    nowPlaying: publicTrack(room.nowPlaying),
    queue: publicQueue(),
    timer: currentTimer(),
    mode: room.mode,
    announcement: currentAnnouncement(),
    visuals: room.visuals,
    visualEvent: currentVisualEvent(),
  };
  if (includeSpotlight) payload.spotlight = hostSpotlight();
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

// --- event lifecycle helpers ---
// The id of the event new participation should be tagged with, or null when no
// event is open (which is also the signal that guest routes must be rejected).
function currentEventId() {
  return event && event.status === EVENT_STATUS.OPEN ? event.id : null;
}

// Record that an identity participated in the currently open event. Attendance
// is many-to-many (a returning guest, whose token skips /api/join, attends
// several events), so we append to an eventIds array rather than overwriting a
// single id — otherwise returning guests stay bolted to their first event and
// vanish from later events' recaps ("ghost attendees").
function markAttendance(id) {
  const eventId = currentEventId();
  if (!eventId || !id) return;
  if (!Array.isArray(id.eventIds)) id.eventIds = [];
  if (!id.eventIds.includes(eventId)) id.eventIds.push(eventId);
}

// What every surface sees about the event. Phase is read from `mode` (its
// single source of truth), never stored twice.
function publicEvent() {
  if (!event) return null;
  return {
    id: event.id,
    title: event.title,
    status: event.status,
    phase: room.mode,
    openedAt: event.openedAt,
    closedAt: event.closedAt,
  };
}

// Guard for guest-mutating routes: 403 with a client-detectable flag when the
// room is closed. Returns true to proceed, false after having already replied.
function requireOpenEvent(res) {
  if (event && event.status === EVENT_STATUS.OPEN) return true;
  send(res, 403, { error: 'No event is running right now.', eventClosed: true });
  return false;
}

function stopPlayback() {
  room.nowPlaying = null;
  if (AUDIO_ENABLED) mpvSend(['stop']).catch(() => {});
}

function archiveCurrentEvent() {
  if (!event) return;
  const closed = { ...event, status: EVENT_STATUS.CLOSED, closedAt: event.closedAt || Date.now() };
  const existing = eventsArchive.findIndex(e => e.id === closed.id);
  if (existing >= 0) eventsArchive[existing] = closed;
  else eventsArchive.unshift(closed);
  eventsArchive.length = Math.min(eventsArchive.length, 100);
}

// Open a fresh meetup. Clears the pending show (queue/playback/timer/announce/
// spotlight) for a clean slate but keeps eventId-tagged history and reports so
// past events stay reviewable. Callers ensure no event is currently open.
function openEvent(title) {
  stopPlayback();
  queue.splice(0, queue.length);
  // Reset the fair-rotation cursor too, so a fresh meetup doesn't inherit the
  // previous event's requester-ordering pointer (which references dead tokens).
  for (const key of Object.keys(lastPlayedRequesterByVotes)) delete lastPlayedRequesterByVotes[key];
  if (room.spotlight) { archiveSpotlight(); room.spotlight = null; }
  clearTimer();
  clearAnnouncement();
  room.mode = 'welcome';
  event = {
    id: crypto.randomBytes(6).toString('hex'),
    title: cleanText(title, 100) || 'Imagineering Meetup',
    status: EVENT_STATUS.OPEN,
    openedAt: Date.now(),
    closedAt: null,
  };
  savePersistentState();
  broadcast();
  return publicEvent();
}

// Close the open event: stop the show and archive the event so its output stays
// reviewable. Guests immediately see the friendly closed state.
function closeEvent() {
  if (!event) return null;
  stopPlayback();
  // Clear the queue so a closed room actually goes quiet: stopPlayback's mpv
  // `stop` triggers the idle observer → playNext, which would otherwise play
  // the next queued track in a room that's supposed to be resting.
  queue.splice(0, queue.length);
  if (room.spotlight) { archiveSpotlight(); room.spotlight = null; }
  clearTimer();
  clearAnnouncement();
  event = { ...event, status: EVENT_STATUS.CLOSED, closedAt: Date.now() };
  archiveCurrentEvent();
  savePersistentState();
  broadcast();
  return publicEvent();
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
  if (!currentEventId()) { room.nowPlaying = null; broadcast(); return; }
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

// --- yt-dlp search ---
const { ytSearch } = require('./ytSearch');

// --- consented spotlight research and facilitation ---
async function fetchRemote(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function researchTerms(text) {
  const ignored = new Set([
    'about', 'after', 'again', 'also', 'and', 'are', 'been', 'being', 'build', 'building',
    'could', 'from', 'have', 'into', 'just', 'like', 'make', 'project',
    'our', 'stage', 'that', 'the', 'their', 'there', 'these', 'they', 'this', 'through',
    'using', 'want', 'what', 'when', 'where', 'which', 'with', 'would', 'your',
  ]);
  const counts = new Map();
  const words = String(text || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  for (const word of words) {
    if (!ignored.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([word]) => word);
}

function sourceWords(source) {
  return new Set(researchTerms(`${source.title || ''} ${source.summary || ''}`));
}

function overlapScore(terms, source) {
  const words = sourceWords(source);
  return terms.reduce((score, term) => score + (words.has(term) ? 1 : 0), 0);
}

function xmlDecode(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function tagContent(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return cleanText(xmlDecode(match?.[1] || ''), 280);
}

async function githubResearch(focusId, terms) {
  const sourceSets = [];
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Dreamfinder-Stage' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const eligible = Array.from(identities.entries()).filter(([, id]) =>
    id.consentResearch === true && normalizeGithubHandle(id.githubHandle));
  await Promise.all(eligible.map(async ([token, id]) => {
    const handle = normalizeGithubHandle(id.githubHandle);
    try {
      const response = await fetchRemote(
        `https://api.github.com/users/${encodeURIComponent(handle)}/repos?sort=updated&per_page=8`,
        { headers });
      const repositories = await response.json();
      if (!Array.isArray(repositories)) return;
      const sources = repositories
        .filter(repo => repo && repo.html_url && repo.name)
        .map(repo => ({
          title: `${handle}/${repo.name}`,
          url: repo.html_url,
          summary: cleanText(repo.description || `${repo.language || 'Code'} repository`, 210),
          kind: 'github',
          participantName: identityDisplayName(id),
          ownerToken: token,
        }));
      sourceSets.push(...sources);
    } catch (err) {
      console.error(`GitHub research failed for ${handle}:`, err.message);
    }
  }));
  const ranked = sourceSets
    .map(source => ({ ...source, score: overlapScore(terms, source) }))
    .filter(source => source.ownerToken === focusId || source.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 7);
  const connections = ranked
    .filter(source => source.ownerToken !== focusId && source.score > 0)
    .slice(0, 3)
    .map(source => `${source.participantName}'s ${source.title} overlaps on ${terms.filter(term => sourceWords(source).has(term)).join(', ')}.`);
  const distinctSources = ranked.filter((source, index, list) =>
    list.findIndex(candidate => candidate.url === source.url) === index);
  return { sources: distinctSources, connections };
}

async function arxivResearch(terms) {
  if (!terms.length) return [];
  const query = terms.slice(0, 4).map(term => `all:${term}`).join(' AND ');
  try {
    const response = await fetchRemote(
      `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=4`,
      {},
      6000);
    const xml = await response.text();
    return Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi))
      .map(match => ({
        title: tagContent(match[1], 'title'),
        url: tagContent(match[1], 'id'),
        summary: tagContent(match[1], 'summary'),
        kind: 'arxiv',
      }))
      .filter(source => source.title && source.url)
      .slice(0, 4);
  } catch (err) {
    console.error('arXiv research failed:', err.message);
    return [];
  }
}

function openAlexAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  const positioned = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) positioned[position] = word;
  }
  return cleanText(positioned.filter(Boolean).join(' '), 280);
}

function cleanMarkup(value, maxLength) {
  return cleanText(xmlDecode(String(value || '').replace(/<[^>]+>/g, ' ')), maxLength);
}

async function openAlexResearch(terms, projectTitle) {
  if (!terms.length) return [];
  const titleQuery = cleanText(projectTitle, 100).replace(/\bstage\b/ig, '').trim();
  const query = titleQuery || terms.slice(0, 2).join(' ');
  try {
    const response = await fetchRemote(
      `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=4&mailto=hello@imagineering.cc`);
    const data = await response.json();
    return (Array.isArray(data.results) ? data.results : [])
      .map(work => ({
        title: cleanMarkup(work.title, 180),
        url: work.primary_location?.landing_page_url || work.doi || work.id || '',
        summary: openAlexAbstract(work.abstract_inverted_index) ||
          cleanText(`${work.publication_year || ''} scholarly work`, 280),
        kind: 'openalex',
      }))
      .filter(source => source.title && source.url)
      .slice(0, 4);
  } catch (err) {
    console.error('OpenAlex research failed:', err.message);
    return [];
  }
}

function evidenceBasedInsights(profile, transcript, terms, sources, connections) {
  const title = profile.projectTitle || 'this project';
  const leadTerm = terms[0] || 'the core idea';
  const researchDirection = sources.find(source => source.kind === 'arxiv');
  const peerDirection = connections[0];
  return {
    questions: [
      `What is the smallest test that would tell you whether ${leadTerm} is actually helping ${title}?`,
      `Which assumption in ${title} would be most valuable to invalidate before the next sprint?`,
      `Who in the room has tackled something adjacent to ${leadTerm}, and what could you test together?`,
    ],
    directions: [
      peerDirection || `Define one observable outcome for ${title}, then build the narrowest experiment that measures it.`,
      researchDirection
        ? `Compare your approach with "${researchDirection.title}" and extract one technique worth testing.`
        : `Capture one real user interaction with ${title} and let that evidence set the next direction.`,
    ],
    connections,
    sources,
    authoredBy: 'evidence-template',
    note: OPENAI_API_KEY
      ? ''
      : 'Public-source research is live. Configure STAGE_OPENAI_API_KEY for Dreamfinder-authored riffs.',
  };
}

async function modelInsights(profile, transcript, baseline) {
  if (!OPENAI_API_KEY) return null;
  const evidence = baseline.sources
    .map(source => `${source.kind}: ${source.title} - ${source.summary} (${source.url})`)
    .join('\n');
  const prompt = [
    `Participant: ${profile.name}`,
    `Project: ${profile.projectTitle || '(untitled)'}`,
    `Description: ${profile.projectDescription || '(not supplied)'}`,
    `Spoken report: ${transcript || '(no transcript)'}`,
    'Retrieved public evidence:',
    evidence || '(nothing retrieved)',
    `Potential peer overlaps: ${baseline.connections.join(' ') || '(none found)'}`,
  ].join('\n');
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
      directions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
      connections: { type: 'array', maxItems: 3, items: { type: 'string' } },
    },
    required: ['questions', 'directions', 'connections'],
  };
  try {
    const response = await fetchRemote('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        store: false,
        input: [
          {
            role: 'developer',
            content: 'You are Dreamfinder, a precise meetup facilitator. Build on the participant report and supplied evidence only. Ask concise, incisive questions and suggest actionable next sprint directions. Never claim a connection not supported by the evidence.',
          },
          { role: 'user', content: prompt },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'stage_insights',
            strict: true,
            schema,
          },
        },
        max_output_tokens: 650,
      }),
    }, 30000);
    const data = await response.json();
    const text = data.output_text || data.output?.flatMap(item => item.content || [])
      .find(item => item.type === 'output_text')?.text;
    if (!text) return null;
    const generated = JSON.parse(text);
    return {
      ...baseline,
      questions: generated.questions.map(value => cleanText(value, 220)).filter(Boolean),
      directions: generated.directions.map(value => cleanText(value, 240)).filter(Boolean),
      connections: generated.connections.map(value => cleanText(value, 240)).filter(Boolean),
      authoredBy: `openai:${OPENAI_MODEL}`,
      note: '',
    };
  } catch (err) {
    console.error('Dreamfinder model insight generation failed:', err.message);
    return null;
  }
}

async function developSpotlightInsights() {
  if (!room.spotlight?.active) throw new Error('no active spotlight');
  const spotlightId = room.spotlight.id;
  const participantId = room.spotlight.participantToken;
  const participant = identities.get(participantId);
  if (!participant?.consentResearch) throw new Error('research consent required');
  const profile = participantProfile(participant);
  const transcript = cleanText(room.spotlight.transcript, 6000);
  const terms = researchTerms(`${profile.projectTitle} ${profile.projectDescription} ${transcript}`);
  const opening = evidenceBasedInsights(profile, transcript, terms, [], []);
  room.spotlight = {
    ...room.spotlight,
    status: 'researching',
    insights: {
      ...opening,
      directions: [],
      sources: [],
      note: 'Searching opted-in public repositories and research now.',
      searchedAt: null,
    },
  };
  broadcast();
  const [github, arxiv, openAlex] = await Promise.all([
    githubResearch(participantId, terms),
    arxivResearch(terms),
    openAlexResearch(terms, profile.projectTitle),
  ]);
  if (!room.spotlight || room.spotlight.id !== spotlightId) throw new Error('spotlight changed');
  const sources = [
    ...github.sources.slice(0, 6),
    ...arxiv.slice(0, 3),
    ...openAlex.slice(0, 3),
  ].slice(0, 12);
  const baseline = evidenceBasedInsights(profile, transcript, terms, sources, github.connections);
  const generated = await modelInsights(profile, transcript, baseline);
  if (!room.spotlight || room.spotlight.id !== spotlightId) throw new Error('spotlight changed');
  const insights = generated || baseline;
  room.spotlight = { ...room.spotlight, status: 'ready', insights: { ...insights, searchedAt: Date.now() } };
  broadcast();
  return room.spotlight.insights;
}

function archiveSpotlight() {
  if (!room.spotlight || !room.spotlight.transcript) return;
  reports.unshift({
    id: room.spotlight.id,
    eventId: room.spotlight.eventId || currentEventId(),
    participantName: room.spotlight.participantName,
    projectTitle: room.spotlight.projectTitle,
    kind: room.spotlight.kind,
    transcript: cleanText(room.spotlight.transcript, 6000),
    insights: room.spotlight.insights || null,
    startedAt: room.spotlight.startedAt,
    endedAt: Date.now(),
  });
  reports.length = Math.min(reports.length, REPORT_LIMIT);
  savePersistentState();
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

  if (method === 'GET' && p === '/api/reports') {
    return send(res, 200, { reports });
  }

  // event lifecycle (host-only — kept off the public proxy like other controls)
  if (method === 'GET' && p === '/api/event') {
    return send(res, 200, { event: publicEvent(), archive: eventsArchive });
  }

  if (method === 'POST' && p === '/api/event/open') {
    if (event && event.status === EVENT_STATUS.OPEN) {
      return send(res, 409, { error: 'an event is already open; close it first' });
    }
    const body = await readBody(req);
    return send(res, 200, { event: openEvent(body.title) });
  }

  if (method === 'POST' && p === '/api/event/close') {
    if (!event || event.status !== EVENT_STATUS.OPEN) {
      return send(res, 409, { error: 'no open event to close' });
    }
    return send(res, 200, { event: closeEvent() });
  }

  // host: reopen a past event's archived output (reports/history/attendees by tag)
  if (method === 'GET' && p === '/api/event/archive') {
    const id = url.searchParams.get('id');
    if (!id) return send(res, 200, { archive: eventsArchive });
    const archived = eventsArchive.find(e => e.id === id) ||
      (event && event.id === id ? publicEvent() : null);
    if (!archived) return send(res, 404, { error: 'unknown event' });
    return send(res, 200, {
      event: archived,
      reports: reports.filter(report => report.eventId === id),
      history: playHistory.filter(entry => entry.eventId === id),
      attendees: Array.from(identities.values())
        .filter(identity => Array.isArray(identity.eventIds) && identity.eventIds.includes(id))
        .map(identity => participantProfile(identity)),
    });
  }

  // admin: mint a new attendee
  if (method === 'POST' && p === '/api/mint') {
    return send(res, 200, createIdentity());
  }

  // guest: self-join and receive an identity (only while an event is open)
  if (method === 'POST' && p === '/api/join') {
    if (!requireOpenEvent(res)) return;
    return send(res, 200, createIdentity());
  }

  // guest: opt-in project profile used by spotlight and evidence searches
  if (method === 'POST' && p === '/api/profile') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    id.projectTitle = cleanText(body.projectTitle, 100);
    id.projectDescription = cleanText(body.projectDescription, 420);
    id.githubHandle = normalizeGithubHandle(body.githubHandle);
    id.consentRecording = body.consentRecording === true;
    id.consentResearch = body.consentResearch === true;
    savePersistentState();
    broadcast();
    return send(res, 200, { ok: true, profile: participantProfile(id) });
  }

  // guest: evolve the room's generative animation controls
  if (method === 'POST' && p === '/api/visuals') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    room.visuals = normalizeVisuals({
      ...room.visuals,
      theme: body.theme ?? room.visuals.theme,
      energy: body.energy ?? room.visuals.energy,
      complexity: body.complexity ?? room.visuals.complexity,
      hue: body.hue ?? room.visuals.hue,
      editedBy: identityDisplayName(id),
      editedAt: Date.now(),
    });
    savePersistentState();
    broadcast();
    return send(res, 200, { visuals: room.visuals });
  }

  // guest: phone motion triggers a short visual response, rate-limited per person
  if (method === 'POST' && p === '/api/gesture') {
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    if (body.type !== 'shake') return send(res, 400, { error: 'unknown gesture' });
    const lastAt = gestureTimes.get(body.token) || 0;
    if (Date.now() - lastAt < 900) return send(res, 429, { error: 'shake too frequent' });
    gestureTimes.set(body.token, Date.now());
    room.visualEvent = {
      id: crypto.randomBytes(4).toString('hex'),
      type: 'shake',
      intensity: clamp(body.intensity, 0, 1, 0.5),
      color: id.color,
      requesterName: identityDisplayName(id),
      at: Date.now(),
    };
    broadcast();
    return send(res, 200, { ok: true, visualEvent: room.visualEvent });
  }

  // admin: set the room's current show phase
  if (method === 'POST' && p === '/api/mode') {
    const body = await readBody(req);
    const requested = String(body.mode || '');
    if (!SHOW_MODES.has(requested)) return send(res, 400, { error: 'unknown mode' });
    room.mode = requested;
    savePersistentState();
    broadcast();
    return send(res, 200, { mode: room.mode });
  }

  // timer controls
  if (method === 'POST' && p === '/api/timer/start') {
    const body = await readBody(req);
    const seconds = Number(body.seconds ?? body.durationSeconds ?? 0);
    const minutes = Number(body.minutes ?? 0);
    const durationMs = Math.round((seconds || minutes * 60) * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 24 * 60 * 60 * 1000) {
      return send(res, 400, { error: 'duration must be between 1 second and 24 hours' });
    }
    return send(res, 200, { timer: startTimer({ durationMs, label: String(body.label || 'Sprint').slice(0, 40) }) });
  }

  if (method === 'POST' && p === '/api/timer/clear') {
    clearTimer();
    return send(res, 200, { timer: null });
  }

  // room announcement controls
  if (method === 'POST' && p === '/api/announce') {
    const body = await readBody(req);
    const seconds = Number(body.seconds ?? 12);
    const durationMs = Math.round(seconds * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 5 * 60 * 1000) {
      return send(res, 400, { error: 'announcement duration must be between 1 second and 5 minutes' });
    }
    const nextAnnouncement = showAnnouncement({
      title: body.title,
      message: body.message,
      detail: body.detail,
      color: body.color,
      durationMs,
    });
    return send(res, 200, { announcement: nextAnnouncement });
  }

  if (method === 'POST' && p === '/api/announce/clear') {
    clearAnnouncement();
    return send(res, 200, { announcement: null });
  }

  // host: begin and capture a consented spoken project/progress report
  if (method === 'POST' && p === '/api/spotlight/start') {
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 404, { error: 'unknown participant' });
    if (id.consentRecording !== true) {
      return send(res, 409, { error: 'participant has not consented to live transcription/display' });
    }
    const kind = body.kind === 'progress' ? 'progress' : 'introduction';
    room.spotlight = {
      id: crypto.randomBytes(5).toString('hex'),
      eventId: currentEventId(),
      active: true,
      participantToken: body.token,
      participantName: identityDisplayName(id),
      projectTitle: cleanText(id.projectTitle, 100),
      kind,
      transcript: '',
      isFinal: false,
      status: 'listening',
      insights: null,
      startedAt: Date.now(),
    };
    broadcast();
    return send(res, 200, { spotlight: hostSpotlight() });
  }

  if (method === 'POST' && p === '/api/spotlight/transcript') {
    const body = await readBody(req);
    if (!room.spotlight?.active) return send(res, 409, { error: 'no active spotlight' });
    room.spotlight = {
      ...room.spotlight,
      transcript: cleanText(body.transcript ?? body.text, 6000),
      isFinal: body.isFinal === true,
      status: body.isFinal === true ? 'captured' : 'listening',
    };
    broadcast();
    return send(res, 200, { spotlight: hostSpotlight() });
  }

  if (method === 'POST' && p === '/api/spotlight/insights') {
    if (!room.spotlight?.active) return send(res, 409, { error: 'no active spotlight' });
    const id = identities.get(room.spotlight.participantToken);
    if (id?.consentResearch !== true) {
      return send(res, 409, { error: 'participant has not consented to external research and analysis' });
    }
    try {
      const insights = await developSpotlightInsights();
      return send(res, 200, { insights, spotlight: hostSpotlight() });
    } catch (err) {
      if (room.spotlight) {
        room.spotlight = { ...room.spotlight, status: 'research-failed' };
        broadcast();
      }
      return send(res, 502, { error: err.message });
    }
  }

  if (method === 'POST' && p === '/api/spotlight/end') {
    archiveSpotlight();
    room.spotlight = null;
    broadcast();
    return send(res, 200, { spotlight: null });
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
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
    if (!body.videoId || !body.title) return send(res, 400, { error: 'missing videoId/title' });
    const entry = {
      id: crypto.randomBytes(4).toString('hex'),
      eventId: currentEventId(),
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
    if (!room.nowPlaying) playNext();
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
    if (!requireOpenEvent(res)) return;
    const body = await readBody(req);
    const id = identities.get(body.token);
    if (!id) return send(res, 401, { error: 'unknown token' });
    markAttendance(id);
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

// --- composition root: wire state.js's late-bound cross-module hooks ---
// state.js calls these indirectly to avoid a static require cycle with sse-hub/
// mpv (broadcast/playNext) and the event-session globals (still in this file).
// Wire them now that every dependency is defined, BEFORE any boot call that may
// reach through a hook (armTimerTimeout/playNext both broadcast).
state.hooks.broadcast = broadcast;
state.hooks.playNext = playNext;
state.hooks.currentEventId = currentEventId;
state.hooks.getEvent = () => event;
state.hooks.getEventsArchive = () => eventsArchive;

sortQueue();
armTimerTimeout();
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
