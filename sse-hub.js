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
const {
  room,
  sseClients,
  publicTrack,
  publicQueue,
  currentTimer,
  currentAnnouncement,
  currentVisualEvent,
  hostSpotlight,
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
  };
  if (includeSpotlight) payload.spotlight = hostSpotlight();
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
