// --- consented spotlight research and facilitation ---
// Owns the spotlight insight pipeline: term extraction, public-source research
// (GitHub repos of consenting participants + arXiv + OpenAlex), an evidence-based
// facilitation template, an optional OpenAI-authored riff, and the two lifecycle
// functions that drive a live spotlight (`developSpotlightInsights`) and archive
// it (`archiveSpotlight`).
//
// Shared-state discipline (carried over from the single-file version, semantics
// identical): the spotlight is a REASSIGNED SCALAR held on the `room` holder.
// `developSpotlightInsights` captures `room.spotlight.id` as `spotlightId` BEFORE
// each await, re-reads `room.spotlight` fresh AFTER each await, and throws if the
// id changed — that concurrent-cancellation guard only works because every access
// goes through `room.spotlight` (a stale captured local would defeat it). Every
// reassignment is a field write `room.spotlight = {...}`. `archiveSpotlight`
// unshifts into the shared `reports` array IN PLACE and calls savePersistentState.
//
// `currentEventId` lives in server.js (event-session lifecycle), so it is reached
// through the late-bound `state.hooks.currentEventId` indirection rather than a
// static require (which would be a cycle). `broadcast` comes from sse-hub. The six
// internal pure helpers (sourceWords, overlapScore, xmlDecode, tagContent,
// openAlexAbstract, cleanMarkup) stay module-private.

const {
  GITHUB_TOKEN,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  REPORT_LIMIT,
} = require('./config');

const state = require('./state');
const {
  room,
  identities,
  reports,
  identityDisplayName,
  participantProfile,
  cleanText,
  normalizeGithubHandle,
  savePersistentState,
} = state;

const { broadcast } = require('./sse-hub');

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
    eventId: room.spotlight.eventId || state.hooks.currentEventId(),
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

module.exports = {
  developSpotlightInsights,
  archiveSpotlight,
  fetchRemote,
  researchTerms,
  githubResearch,
  arxivResearch,
  openAlexResearch,
  evidenceBasedInsights,
  modelInsights,
};
