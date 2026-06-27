// Zero-dependency unit suite for the Reader→Voice wire (Two Minds, Slice 4).
//
// The seam under test: when a spotlight FINISHES (barge-in), the Reader's finding
// on room.spotlight.read is performed in-character by The Voice (voice.js speak),
// the resulting utterance lands on the ephemeral room.voice ring, and that ring
// rides the PRIVATE show stream only — never the public payload.
//
// Node built-ins ONLY (node:test, node:assert). DELIBERATELY no STAGE_OPENAI_API_KEY
// here: with no key, voice.js runs in TEMPLATE mode (callOpenAI returns null before
// any network), so every assertion is deterministic and the suite never touches the
// network. The verified surface is the WIRE + the trust-boundary routing, not the
// live model (that path is graceful-by-design and proven in voice.test.js).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.STAGE_STATE_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'reader-voice-test-')), 'state.json');
process.env.STAGE_NO_AUDIO = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const voice = require('../voice');
const state = require('../state');
const { statePayload } = require('../sse-hub');
const { room } = state;

// Clean ephemeral voice store + deterministic hooks before each test. room.voice
// is never persisted, so resetting it to null forces a clean lazy re-init.
function reset(eventId = 'evt-1') {
  room.voice = null;
  room.spotlight = null;
  state.hooks.currentEventId = () => eventId;
  state.hooks.broadcast = () => {};
  state.hooks.currentUtterances = voice.currentUtterances;
}

test('voicePayloadForRead routes the Reader finding into the FENCED excerpt slot, never trusted context', () => {
  const read = { status: 'ready', finding: 'The retry loop quietly swallows the 429.', repo: 'widgets', confidence: 'medium' };
  const p = voice.voicePayloadForRead(read, { participantName: 'Indigo Heron', projectTitle: 'Widgets' });
  // The repo-derived finding is the UNTRUSTED excerpt — it must reach the model
  // only inside the nonce fence, so it belongs in findings[].excerpt.
  assert.equal(p.findings.length, 1);
  assert.equal(p.findings[0].excerpt, read.finding);
  assert.equal(p.findings[0].sourceKind, 'repo-read');
  // The trust-boundary invariant: the finding text must NOT leak into the trusted
  // context region (which is interpolated OUTSIDE the fence).
  assert.ok(!JSON.stringify(p.context).includes('retry loop'),
    'finding text must never appear in the trusted context region');
  assert.equal(p.context.participantName, 'Indigo Heron');
  assert.equal(p.context.projectTitle, 'Widgets');
});

test('voicePayloadForRead flags a low-confidence finding as a reach (PERSONA hedge)', () => {
  const read = { status: 'ready', finding: 'Maybe a race here.', repo: 'r', confidence: 'low' };
  const p = voice.voicePayloadForRead(read, {});
  assert.equal(p.confidence, 'reach');
});

test('performReaderVoice stays SILENT unless the read is ready with a finding', async () => {
  reset();
  const silent = [null, { status: 'reading' }, { status: 'none', reason: 'no-repo' }, { status: 'ready' /* no finding */ }];
  for (const read of silent) {
    const u = await voice.performReaderVoice(read, {});
    assert.equal(u, null, `expected silence for read=${JSON.stringify(read)}`);
  }
  assert.equal(voice.currentUtterances().length, 0, 'no utterance produced from a non-ready read');
});

test('performReaderVoice speaks a facilitation utterance on a ready finding (template mode)', async () => {
  reset();
  const read = { status: 'ready', finding: 'Two modules race on the same socket.', repo: 'r', confidence: 'medium' };
  const u = await voice.performReaderVoice(read, { participantName: 'Saffron Lark' });
  assert.ok(u, 'an utterance is produced at barge-in');
  assert.equal(u.kind, 'facilitation');
  // No key → template fallback; the room is never blank by error.
  assert.equal(u.authoredBy, 'voice-template');
  assert.equal(voice.currentUtterances()[0].id, u.id, 'the utterance landed on the ring');
});

test('the Voice rides the SHOW stream only — never the public payload', async () => {
  reset();
  const read = { status: 'ready', finding: 'A subtle off-by-one in the ring buffer.', repo: 'r' };
  await voice.performReaderVoice(read, {});
  const show = statePayload({ includeSpotlight: true });
  const pub = statePayload();
  assert.ok(Array.isArray(show.voice) && show.voice.length === 1, 'voice present on the show stream');
  assert.equal(pub.voice, undefined, 'voice NEVER on the public stream (privacy boundary)');
});
