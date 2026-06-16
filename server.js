// Dreamfinder — meetup room stage
// Pi plays music; room/admin shows a stable join QR;
// attendees join, get a PWA-ish page, search YouTube, queue tracks;
// admin can run a visible timer and the room page alarms when it ends.
// Zero npm deps. SSE for live updates. The server is split into focused
// modules (config, state, sse-hub, mpv, ytSearch, research, event-session,
// routes); THIS file is just the composition root + boot orchestration.
const http = require('http');
const { PORT, AUDIO_ENABLED } = require('./config');

// state.js OWNS every shared mutable global and the persistence contract. Load
// it first so the containers are populated before anything reads them.
const state = require('./state');
const { queue, sortQueue, armTimerTimeout } = state;
const savedState = state.loadPersistentState();

// event-session.js owns the host-controlled event that gates participation.
// Hydrate it from the persisted blob (and run the predates-the-event migration)
// before wiring or boot.
const eventSession = require('./event-session');
eventSession.init(savedState);

const { broadcast } = require('./sse-hub');
const { startMpv, listenMpvEvents, playNext } = require('./mpv');
const { requestHandler } = require('./routes');

// --- composition root: wire state.js's late-bound cross-module hooks ---
// state.js calls these indirectly to avoid static require cycles with sse-hub/
// mpv (broadcast/playNext) and the event-session module (event accessors). Wire
// them now that every dependency is defined, BEFORE any boot call that may reach
// through a hook (armTimerTimeout/playNext both broadcast; save reads getEvent).
state.hooks.broadcast = broadcast;
state.hooks.playNext = playNext;
state.hooks.currentEventId = eventSession.currentEventId;
state.hooks.getEvent = eventSession.getEvent;
state.hooks.getEventsArchive = eventSession.getEventsArchive;
state.hooks.publicEvent = eventSession.publicEvent;

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

const server = http.createServer(requestHandler);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dreamfinder listening on http://0.0.0.0:${PORT}`);
});
