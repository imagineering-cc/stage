// --- event recap (M4) ---
// Closing an event should leave useful, shareable material without the host
// manually assembling notes. This module ASSEMBLES a structured recap from
// state that is ALREADY archived (reports[], playHistory[], identities, the
// event record) and RENDERS a self-contained HTML export. It owns no state and
// never mutates: it is a pure projection over the shared containers, like
// sse-hub's statePayload but for the host-only recap surface.
//
// ── THE CONSENT-INTEGRITY INVARIANT (trust boundary) ───────────────────────
// A recap MUST reflect CURRENT consent, not consent-at-capture. A participant
// who spoke under recording consent and later WITHDRAWS it must not have their
// spoken material reappear in a recap/export. Likewise a report the host has
// REMOVED must be absent. Concretely, for every report the recap would surface:
//
//   • the report must still be present in reports[] (a removed report is simply
//     not found by the eventId filter — nothing to do, it is gone); AND
//   • its participant identity must still exist AND still carry
//     consentRecording === true.
//
// If consent cannot be CONFIRMED (the identity was deleted, the token was never
// stamped on a pre-M4 report, or consentRecording is anything but true), the
// recap FAILS CLOSED: the report's spoken body (transcript, insights,
// facilitation, derived links) is dropped. We keep only a minimal, consent-free
// "a report existed" tombstone so the count stays honest without leaking words.
//
// This is enforced in ONE place — `consentedReport()` — so every surface the
// recap exposes (the JSON object AND the HTML export both call buildRecap) is
// traced back through the same single gate. There is no second path to the body.

const {
  reports,
  playHistory,
  identities,
  identityDisplayName,
  participantProfile,
  cleanText,
  normalizeGithubHandle,
} = require('./state');

// Resolve the LIVE identity behind an archived report and decide whether its
// spoken body may appear. Returns { id, consented } — consented is true ONLY
// when the identity still exists and still carries recording consent. A report
// with no participantToken (pre-M4 archive) cannot be confirmed → not consented.
function resolveReportConsent(report) {
  const token = typeof report.participantToken === 'string' ? report.participantToken : null;
  const id = token ? identities.get(token) : null;
  // consentRecording is the gate: the spotlight body is SPOKEN material, captured
  // under the recording-consent permission (the same flag /api/spotlight/start
  // and /api/share/request require). Re-read it LIVE so a later withdrawal wins.
  const consented = !!id && id.consentRecording === true;
  return { id, consented };
}

// Project ONE archived report into its recap shape, applying the consent gate.
// When consent is confirmed the full body is surfaced; otherwise a redacted
// tombstone that retains only the participant's PUBLIC display label (the room
// name, never spoken material) plus the report kind and timestamps, and drops
// the entire spoken body (transcript, insights, facilitation, derived links).
// So the recap can honestly say "a report was given and later made private"
// without leaking its content.
function consentedReport(report) {
  const { id, consented } = resolveReportConsent(report);
  // Prefer the LIVE display name (a handle change should reflect); fall back to
  // the snapshot stored on the report. Never leak a token.
  const participantName = id ? identityDisplayName(id) : cleanText(report.participantName, 60);
  const base = {
    id: report.id,
    kind: report.kind || 'introduction',
    participantName,
    startedAt: report.startedAt || null,
    endedAt: report.endedAt || null,
    consentWithdrawn: !consented,
  };
  if (!consented) {
    // FAIL CLOSED: no transcript, no insights, no facilitation, no links.
    return { ...base, redacted: true };
  }
  // Consented: surface the spoken material and any derived public links.
  const insights = report.insights && typeof report.insights === 'object' ? report.insights : null;
  return {
    ...base,
    redacted: false,
    projectTitle: cleanText(report.projectTitle, 100),
    transcript: cleanText(report.transcript, 6000),
    // Dreamfinder's frozen, asked facilitation candidate (question/connections),
    // or null. It only ever existed if it was actually asked (see archiveSpotlight).
    facilitation: report.facilitation || null,
    // Public links the room gathered for this report: the cited research sources.
    // These are public URLs (GitHub repos / arXiv / OpenAlex) the participant's
    // consented research surfaced; gated behind the same consent as the body.
    links: collectLinks(insights, id),
  };
}

// Gather the public, shareable links for a consented report: the participant's
// asserted GitHub profile (if any) plus the cited research sources. Deduped by
// url, capped, each carrying a short label + kind for rendering.
function collectLinks(insights, id) {
  const out = [];
  const seen = new Set();
  const push = (url, label, kind) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label: cleanText(label, 120) || url, kind: kind || 'link' });
  };
  const handle = id ? normalizeGithubHandle(id.githubHandle) : '';
  if (handle) push(`https://github.com/${handle}`, `@${handle} on GitHub`, 'github-profile');
  const sources = insights && Array.isArray(insights.sources) ? insights.sources : [];
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    push(s.url, s.title, s.kind);
    if (out.length >= 12) break;
  }
  return out;
}

// Assemble the full recap object for an event record. `eventRecord` is the
// archived (or live) event { id, title, status, openedAt, closedAt, ... }.
// Pure: reads the shared containers, mutates nothing. The SINGLE assembler —
// both the JSON route and the HTML export call this, so they can never diverge
// and the consent gate is applied exactly once per surface.
function buildRecap(eventRecord) {
  const eventId = eventRecord.id;
  const eventReports = reports
    .filter(r => r && r.eventId === eventId)
    .map(consentedReport);
  const consentedCount = eventReports.filter(r => !r.redacted).length;
  const redactedCount = eventReports.length - consentedCount;

  // Play history for this event (public-projected already in playHistory[]).
  const history = playHistory.filter(e => e && e.eventId === eventId);
  // A compact play summary: total + the most-played titles, so the export does
  // not need to dump the whole list to be useful.
  const playCounts = new Map();
  for (const e of history) {
    const key = cleanText(e.title, 200) || '(untitled track)';
    playCounts.set(key, (playCounts.get(key) || 0) + 1);
  }
  const topTracks = Array.from(playCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([title, plays]) => ({ title, plays }));

  // Participants who attended this event (many-to-many via eventIds). Their
  // display label + project title is a PROFILE detail, not spoken material —
  // consentRecording does not gate it (the participant chose to show it on the
  // public room). Recording-consent only gates the SPOKEN report body above.
  const participants = Array.from(identities.values())
    .filter(id => Array.isArray(id.eventIds) && id.eventIds.includes(eventId))
    .map(id => {
      const profile = participantProfile(id);
      return {
        name: profile.name,
        projectTitle: profile.projectTitle,
        projectDescription: profile.projectDescription,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    event: {
      id: eventRecord.id,
      title: cleanText(eventRecord.title, 100) || 'Imagineering Meetup',
      status: eventRecord.status || 'closed',
      openedAt: eventRecord.openedAt || null,
      closedAt: eventRecord.closedAt || null,
    },
    participants,
    reports: eventReports,
    summary: {
      participantCount: participants.length,
      reportCount: eventReports.length,
      consentedReportCount: consentedCount,
      redactedReportCount: redactedCount,
      trackPlayCount: history.length,
    },
    plays: { total: history.length, topTracks },
    generatedAt: Date.now(),
  };
}

// --- HTML export ----------------------------------------------------------
// A self-contained, dependency-free HTML page. Progressive disclosure: a
// headline summary first, then details behind <details> sections. No external
// assets, no script — it opens in any browser and prints/shares cleanly. No
// em-dashes in human-facing prose (hyphens/commas per house style).

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try { return new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return new Date(ms).toISOString(); }
}

function kindLabel(kind) {
  return kind === 'progress' ? 'Progress update' : kind === 'introduction' ? 'Introduction' : 'Share';
}

function renderLinks(links) {
  if (!Array.isArray(links) || !links.length) return '';
  const items = links
    .map(l => `<li><a href="${esc(l.url)}" rel="noreferrer noopener" target="_blank">${esc(l.label)}</a> <span class="kind">${esc(l.kind)}</span></li>`)
    .join('');
  return `<details><summary>Links (${links.length})</summary><ul class="links">${items}</ul></details>`;
}

function renderReport(r) {
  if (r.redacted) {
    return `<article class="report redacted">
      <h3>${esc(r.participantName)} <span class="kind">${esc(kindLabel(r.kind))}</span></h3>
      <p class="note">This report was made private after the event. Its contents are not included.</p>
    </article>`;
  }
  const fac = r.facilitation;
  const question = fac && fac.kind === 'grounded' && fac.primaryQuestion
    ? `<details open><summary>Dreamfinder's question</summary>
         <blockquote>${esc(fac.primaryQuestion)}</blockquote>
         ${fac.interpretation ? `<p class="interp">${esc(fac.interpretation)}</p>` : ''}
         ${Array.isArray(fac.connections) && fac.connections.length
            ? `<ul class="connections">${fac.connections.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
       </details>`
    : (fac && fac.kind === 'quip' && fac.quip
        ? `<p class="quip">${esc(fac.quip)}</p>` : '');
  return `<article class="report">
    <h3>${esc(r.participantName)} <span class="kind">${esc(kindLabel(r.kind))}</span></h3>
    ${r.projectTitle ? `<p class="project">${esc(r.projectTitle)}</p>` : ''}
    ${r.transcript ? `<details><summary>Spoken report</summary><p class="transcript">${esc(r.transcript)}</p></details>` : ''}
    ${question}
    ${renderLinks(r.links)}
  </article>`;
}

function renderRecapHtml(recap) {
  const e = recap.event;
  const s = recap.summary;
  const participantsList = recap.participants.length
    ? `<ul class="participants">${recap.participants
        .map(p => `<li><strong>${esc(p.name)}</strong>${p.projectTitle ? ` - ${esc(p.projectTitle)}` : ''}</li>`)
        .join('')}</ul>`
    : '<p class="note">No participants recorded.</p>';
  const reportsHtml = recap.reports.length
    ? recap.reports.map(renderReport).join('\n')
    : '<p class="note">No reports were given.</p>';
  const tracksHtml = recap.plays.topTracks.length
    ? `<ol class="tracks">${recap.plays.topTracks
        .map(t => `<li>${esc(t.title)} <span class="kind">${t.plays}x</span></li>`).join('')}</ol>`
    : '<p class="note">No tracks were played.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recap - ${esc(e.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; color: #1c2530; background: #f7f8fb; }
  @media (prefers-color-scheme: dark) { body { color: #e8ecf2; background: #11151c; } }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.25rem; margin: 2rem 0 .5rem; border-bottom: 1px solid #8884; padding-bottom: .3rem; }
  h3 { font-size: 1.05rem; margin: 0 0 .25rem; }
  .sub { color: #6b7785; margin: 0 0 1.5rem; }
  .summary { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; padding: 1rem 1.25rem; border-radius: .75rem;
             background: #ffffff; box-shadow: 0 1px 3px #0002; margin-bottom: .5rem; }
  @media (prefers-color-scheme: dark) { .summary { background: #1a212c; } }
  .summary div { min-width: 6rem; }
  .summary .n { display: block; font-size: 1.6rem; font-weight: 700; }
  .summary .l { color: #6b7785; font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
  article.report { padding: 1rem 1.25rem; border-radius: .75rem; background: #fff; box-shadow: 0 1px 3px #0002; margin: .75rem 0; }
  @media (prefers-color-scheme: dark) { article.report { background: #1a212c; } }
  article.report.redacted { opacity: .72; }
  .kind { font-size: .78rem; color: #6b7785; font-weight: 500; }
  .project { font-weight: 600; margin: .1rem 0 .5rem; }
  .transcript { white-space: pre-wrap; }
  blockquote { margin: .4rem 0; padding: .4rem .9rem; border-left: 3px solid #6aa; background: #6aa1; border-radius: .25rem; }
  .interp { color: #6b7785; font-style: italic; }
  .quip { font-style: italic; color: #6b7785; }
  details { margin: .5rem 0; }
  summary { cursor: pointer; font-weight: 600; }
  ul.links, ul.connections, ul.participants, ol.tracks { margin: .4rem 0; padding-left: 1.25rem; }
  .note { color: #6b7785; }
  footer { margin-top: 3rem; color: #6b7785; font-size: .82rem; }
  a { color: #2a7; }
</style>
</head>
<body>
<h1>${esc(e.title)}</h1>
<p class="sub">${e.openedAt ? `Opened ${esc(fmtDate(e.openedAt))}` : ''}${e.closedAt ? ` &bull; Closed ${esc(fmtDate(e.closedAt))}` : ''}</p>

<section class="summary">
  <div><span class="n">${s.participantCount}</span><span class="l">Participants</span></div>
  <div><span class="n">${s.consentedReportCount}</span><span class="l">Reports</span></div>
  <div><span class="n">${s.trackPlayCount}</span><span class="l">Tracks played</span></div>
  ${s.redactedReportCount ? `<div><span class="n">${s.redactedReportCount}</span><span class="l">Made private</span></div>` : ''}
</section>

<h2>Participants</h2>
${participantsList}

<h2>Reports and questions</h2>
${reportsHtml}

<h2>Music</h2>
${tracksHtml}

<footer>Generated by Stage (Dreamfinder) on ${esc(fmtDate(recap.generatedAt))}. Reports appear only with the participant's current recording consent.</footer>
</body>
</html>`;
}

module.exports = {
  buildRecap,
  renderRecapHtml,
  // exported for unit reuse / testing of the consent gate in isolation
  consentedReport,
  resolveReportConsent,
};
