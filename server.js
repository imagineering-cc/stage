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

// event-session.js owns the host-controlled event that gates participation.
// Hydrate it from the SAME state blob state.js already parsed (state.savedState)
// — not a second read — then run the predates-the-event migration before wiring
// or boot.
const eventSession = require('./event-session');
eventSession.init(state.savedState);

const { broadcast } = require('./sse-hub');
const { startMpv, listenMpvEvents, playNext } = require('./mpv');
// sprint.js owns the autonomous Dreamfinder-hosted sprint sequencer. It rides
// state.js's ONE timer via the late-bound onTimerEnded hook (wired below).
const sprint = require('./sprint');
// voice.js owns The Voice (Dreamfinder's spoken presence). Its ring projection
// (currentUtterances) and the barge-in trigger (performReaderVoice) are reached
// through state.hooks so reader-wire/routes/sse-hub never static-require it.
const voice = require('./voice');
const { requestHandler } = require('./routes');

// --- composition root: wire state.js's late-bound cross-module hooks ---
// state.js calls these indirectly to avoid static require cycles with sse-hub/
// mpv (broadcast/playNext) and the event-session module (event accessors). Wire
// them now that every dependency is defined, BEFORE any boot call that may reach
// through a hook (armTimerTimeout/playNext both broadcast; save reads getEvent).
// wireHooks() also flips state's hooksWired flag, so a save before this point
// fails loud instead of persisting event:null.
state.wireHooks({
  broadcast,
  playNext,
  currentEventId: eventSession.currentEventId,
  getEvent: eventSession.getEvent,
  getEventsArchive: eventSession.getEventsArchive,
  publicEvent: eventSession.publicEvent,
  // sprint subscribes to the timer-end event so a phase boundary autonomously
  // advances the session (duck/chime/announce/next). markTimerEnded() invokes it.
  onTimerEnded: sprint.onTimerEnded,
  // The Voice: sse-hub projects the ring onto the show stream; the spotlight-finish
  // handler fires performReaderVoice at barge-in to speak the Reader's finding.
  currentUtterances: voice.currentUtterances,
  performReaderVoice: voice.performReaderVoice,
});

sortQueue();
// armTimerTimeout() re-arms (or immediately fires) the persisted timer FIRST: if
// the persisted phase already ended while the Pi was down, markTimerEnded ->
// onTimerEnded fires here. sprint.onTimerEnded tolerates that pre-reconcile call
// (it only acts on a running phase); armSprintOnBoot() THEN reconciles the
// persisted session explicitly (resume running / hold paused / finish a partial
// wind-down). Order is deliberate — see sprint.js armSprintOnBoot.
armTimerTimeout();
sprint.armSprintOnBoot();
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
