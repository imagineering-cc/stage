# Stage Delivery Plan

Updated: 2026-05-27

## Outcome

Stage should run a complete Imagineering meetup loop:

1. The host opens an event and attendees join from a QR code.
2. Attendees identify themselves, describe their projects, and opt into
   transcript/research features.
3. The room runs timed build sprints with music and participant-influenced
   visuals.
4. Participants enter a share queue and present through their own phones.
5. Spoken reports animate across the TV while Dreamfinder develops concise,
   source-backed questions and connections.
6. The event closes with an archived recap of projects, reports, questions,
   connections, and public links.

The next build should make this loop operable and controlled, rather than add
unconnected effects.

## Decisions

- **Participant client stays web-first.** The QR-to-browser path is essential
  for low-friction participation. Make it installable as a PWA if useful; do
  not require a native mobile app.
- **Visible identity and authorization stay separate.** A private random token
  authorizes actions. A supplied GitHub handle is a participant-asserted
  display label, not proof of account ownership.
- **Speech and audio recording are separate permissions.** Live
  transcription/display can be consented to without retaining raw audio.
  Any future audio recording must be explicit and optional.
- **Host remains in control.** The host opens/closes events, changes phases,
  admits presenters, and controls Dreamfinder interventions.
- **Dreamfinder should sharpen discussion, not dominate it.** Favor one good
  question and a small number of relevant connections over long generated
  commentary or exhaustive result feeds.

## Milestone 0: Live Baseline

Goal: confirm the currently shipped system works from real attendee devices
before changing its state model.

Work:

- Test `https://imagineering.cc/stage` from an ordinary mobile network.
- Confirm joining, GitHub display identity, profile save, voting, queueing,
  animated visual selection, and shake interaction.
- Confirm `dreamfinder.lan` remains usable on the OpenWrt fallback network.
- Run one host spotlight from consent through archived report.

Complete when:

- The current event flow is repeatable on at least one iPhone and one Android
  or desktop Chrome substitute, with known browser limitations documented.

## Milestone 1: Event Sessions And Host Gating

Goal: turn the permanently public room into a host-controlled event.

Work:

- Add a persisted event entity with identifier, title, dates, status and phase.
- Add host controls to create/open, close and archive an event.
- Require an open event for new joins and guest mutations.
- Associate participants, profiles, queue/history, visuals and reports with
  the active event.
- Expose a friendly closed-event state to public visitors.
- Add reset/archive behavior between meetups without destroying history.

Complete when:

- A public visitor cannot affect the room outside an open event.
- The host can open a fresh meetup, run it, close it and reopen archived output
  without editing files or restarting services.

## Milestone 2: Phone-Led Share Queue

Goal: let each participant present through their own phone instead of routing
all capture through the host browser.

Work:

- Add `Share project` and `Give progress update` actions in the guest app.
- Add a host-visible presentation queue with admit, skip, stop and finish
  controls.
- When admitted, allow only that participant's token to stream transcript
  updates for the active spotlight.
- Capture speech on the admitted participant's phone, display live text on
  their device and on the TV, and provide a correction/review step before
  research.
- Preserve explicit transcript/display and external-research consent checks.

Complete when:

- A participant can join the share queue, be admitted by the host, speak into
  their own phone, correct the transcript, and have the report archived.

## Milestone 3: Dreamfinder Facilitation

Goal: make the existing research/question capability a deliberate discussion
moment.

Work:

- After a finalized report, generate a concise interpretation, one primary
  question, up to two participant/project connections, and supporting links.
- Search consented public GitHub material and public research sources within
  predictable time limits.
- Add host controls to ask the proposed question aloud, request another
  question, dismiss output, or continue discussion without AI output.
- Keep citations visible on the host/room displays and distinguish
  evidence-template output from model-authored output.

Complete when:

- Dreamfinder can ask one relevant, host-approved question after a share and
  the room can inspect what evidence informed it.

## Milestone 4: Event Recap

Goal: leave useful material after the room session is over.

Work:

- Produce an event recap view containing participant/project labels, consented
  reports, questions, connections and submitted public links.
- Add export suitable for sharing after the meetup.
- Ensure withdrawn consent or removed reports do not remain in future exports.

Complete when:

- Closing an event creates a reviewable recap that the host can share without
  manually assembling notes.

## Milestone 5: Personal Visual Evolution

Goal: make visual participation expressive while avoiding a chaotic global
control surface.

Work:

- Give each participant a private visual workspace on their phone.
- Let a shake or deliberate submit action inject a bounded pulse/mutation into
  the room.
- Add a host feature action to display one participant's animation during a
  break or share.
- Optionally add room voting for featured visual themes.

Complete when:

- Participants can create distinct visual variations without everyone
  continuously overwriting the shared room background.

## Deferred

- Native attendee mobile app: revisit only for required background capture,
  notifications outside events, or hardware integration.
- Mandatory GitHub login: avoid participation friction; consider optional
  OAuth only for verified persistent profiles or trustworthy repository links.
- Raw audio recording: only add with a clear retention/use case and separate
  consent.
- Audio FFT-driven visuals: valuable polish after the meetup loop is reliable.
- Fully autonomous broad web/repository research: keep facilitation bounded and
  inspectable first.

## Immediate Build Slice

Implement Milestone 1 next:

1. Define the persisted event schema and migration for existing single-room
   state.
2. Add host event lifecycle endpoints and admin controls.
3. Scope join and guest mutation routes to the open event.
4. Render open/closed event status in guest and room surfaces.
5. Exercise open/run/close/archive behavior locally, then deploy to the Pi
   during an idle period.
