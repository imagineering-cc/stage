// --- SSE (Server-Sent Events) Hub ---
// Owns the room's outbound event projection: `statePayload` builds the snapshot
// every surface (guest/admin/TV) renders, and `broadcast` fans it out to all
// connected `sseClients`.
//
// Dependency direction is one-way: sse-hub requires state, never the reverse.
// state.js reaches back here only through its late-bound `hooks.broadcast`
// (wired by the composition root in server.js), so there is no static require
// cycle. The event-session projection (`publicEvent`) still lives in server.js
// pending a later carve, so it too is reached through `state.hooks.publicEvent`.

const { ENGINE_PROTOCOL_VERSION } = require('./config');
const state = require('./state');
// sprint requires {state, config, mpv} — NOT sse-hub — so there is no cycle:
// sprint->state, sse-hub->{state,sprint}, with no back-edge into sse-hub.
const sprint = require('./sprint');
const {
  room,
  sseClients,
  publicTrack,
  publicQueue,
  currentTimer,
  currentAnnouncement,
  currentVisualEvent,
  hostSpotlight,
  shareQueueProjection,
} = state;

// The snapshot every surface renders. Reads reassigned scalars off the `room`
// holder so importers never see a stale binding; the public*/current* accessors
// come straight from state.js. `includeSpotlight` adds the private host
// transcript for the local /api/show-events stream only.
function statePayload({ includeSpotlight = false } = {}) {
  const payload = {
    // Engine wire-protocol version (see config.js + ENGINE.md). First field so
    // a frontend can read it off the very first SSE frame before parsing the rest.
    version: ENGINE_PROTOCOL_VERSION,
    event: state.hooks.publicEvent(),
    nowPlaying: publicTrack(room.nowPlaying),
    queue: publicQueue(),
    timer: currentTimer(),
    mode: room.mode,
    announcement: currentAnnouncement(),
    visuals: room.visuals,
    visualEvent: currentVisualEvent(),
    // Autonomous sprint session projection, or null when idle. On BOTH streams:
    // phase/progress is shown on the TV, not private. Additive — version stays 1.
    sprint: sprint.sprintProjection(),
    // Phone-led presentation queue (M2). Present on BOTH streams; the PUBLIC
    // projection NEVER carries the presenter token (mirrors the spotlight split).
    // [] when empty so consumers can .map/.length unconditionally. Additive.
    shareQueue: shareQueueProjection(false),
  };
  if (includeSpotlight) {
    payload.spotlight = hostSpotlight();
    // SHOW stream: re-add the presenter token so the admin can drive admit/skip/
    // finish. This is the ONLY place token reaches the wire, and /api/show-events
    // is never public-proxied.
    payload.shareQueue = shareQueueProjection(true);
    // The Voice's utterance ring (Two Minds, Slice 4). SHOW-stream ONLY — the
    // performed line is derived from a participant's repo, so it stays off the
    // public payload (the same privacy boundary as spotlight/transcript) until a
    // deliberate clean-`text` promotion. [] when idle so consumers can .map.
    payload.voice = state.hooks.currentUtterances();
  }
  return payload;
}

// Fan-out to every connected client. Public clients get the spotlight-free
// payload; show clients (admin/TV on the local stream) get the full one.
function broadcast() {
  const publicPayload = JSON.stringify(statePayload());
  const showPayload = JSON.stringify(statePayload({ includeSpotlight: true }));
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${client.includeSpotlight ? showPayload : publicPayload}\n\n`);
    } catch(e) {}
  }
}

module.exports = { broadcast, statePayload };
