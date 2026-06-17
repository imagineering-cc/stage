# Stage Engine — wire-protocol contract

> The seam between Stage's **headless show-control engine** and its **frontends**.
> Guest PWA, host admin, the Chromium-kiosk room TV — and any future native app
> (an LG **webOS** TV app is the next planned consumer) — all render the same
> engine state. This document is the contract they code against.

Stage is not a music player with extras; it is a **show-control engine whose
first show is a music jukebox**. The engine (`server.js` composition root +
`state.js`, `sse-hub.js`, `mpv.js`, `research.js`, `event-session.js`,
`ytSearch.js`) owns all state and behaviour. Frontends are pure projections of
the engine's broadcast, plus action calls back to it. The engine has exactly two
public surfaces: a **read stream** (Server-Sent Events) and a **write API**
(JSON over HTTP). This file specifies both.

## Versioning

Every payload carries a top-level integer `version` =
`ENGINE_PROTOCOL_VERSION` (`config.js`). Current: **1**.

- **Additive** changes (new field) do **not** bump the version — frontends must
  ignore unknown fields.
- **Breaking** changes (a field removed/renamed, or its meaning changed) bump
  the version.
- Frontends should **warn, not hard-fail**, on a higher version than they know,
  so an upgraded engine degrades gracefully on an un-updated client (e.g. a TV
  that hasn't been re-flashed). Read `version` off the **first** SSE frame.

## Read surface — Server-Sent Events

Two streams. Both emit `text/event-stream`; each message is a single
`data: <json>\n\n` line whose JSON is a **full state snapshot** (not a diff).
`EventSource` reconnects automatically; on (re)connect the engine immediately
writes the current snapshot, so a frontend never needs to poll.

> Parsing note: the payload is the text **after** the `data: ` prefix. Strip it
> before `JSON.parse`. The first frame on connect is the current state.

| Stream | Path | Exposure | Includes `spotlight`? |
|---|---|---|---|
| **Public** | `GET /api/events` | proxied to the public internet | **no** (privacy) |
| **Show** | `GET /api/show-events` | local / Tailscale only — never public-proxied | **yes** (host transcript) |

The only difference between the two is the private `spotlight` field. Everything
else is identical.

Any number of frontends may attach at once — `broadcast()` fans state out to
every connected client. The Pi Chromium kiosk and the native webOS app are
coequal consumers, not alternatives: run either, or both simultaneously. (Audio
is not a frontend concern — `mpv` runs in the engine, so room sound always comes
from the Pi's HDMI regardless of which display is showing.)

Both streams send `Access-Control-Allow-Origin: *`, so an **off-origin** frontend
(a native webOS TV app, a separate dashboard) can open them directly — the engine
serves public, read-only state here, so wildcard CORS is intentional. The
same-origin served PWA is unaffected. (Cross-origin **writes** — guest action
POSTs from a native app — are not yet CORS-enabled; that needs preflight handling
and is a future step, tracked when a native *guest* frontend is built. The room
*display* only reads, so the streams are enough.)

### Payload schema

```jsonc
{
  "version": 1,                  // engine protocol version (integer)
  "event":      Event | null,    // null when no event is open → room is "closed"
  "nowPlaying": Track | null,    // currently playing track, or null
  "queue":      [ Track ],       // upcoming tracks, vote-ranked + fair-rotated
  "timer":      Timer | null,    // sprint/visible timer, or null
  "mode":       string,          // show phase — one of SHOW_MODES (see below)
  "announcement": Announcement | null,
  "visuals":    Visuals,         // generative-background controls (always present)
  "visualEvent": VisualEvent | null, // transient gesture burst (~5s), or null
  "sprint":     Sprint | null,       // autonomous sprint session, or null when idle
  "shareQueue": [ ShareEntry ],      // phone-led presentation queue; [] when empty
  "spotlight":  Spotlight | null     // SHOW STREAM ONLY — omitted on /api/events
}
```

**Event**
```jsonc
{ "id": string, "title": string,
  "status": "open" | "closed",   // the only two states (closed set)
  "phase": string,               // mirror of `mode` — the live show phase
  "openedAt": number|null, "closedAt": number|null }  // epoch ms
```
`event === null` is the canonical "room is closed" signal: a frontend should
render the friendly closed state and expect every guest write to be gated (see
below). `phase` duplicates top-level `mode` for convenience; `mode` is the
single source of truth.

**Track** (public projection — the requester's private token is never sent)
```jsonc
{ "id": string, "eventId": string,
  "requesterName": string,       // GitHub @handle if asserted, else Dreamfinder name
  "color": string,               // "hsl(...)" assigned to the requester
  "videoId": string, "title": string, "thumbnail": string,
  "addedAt": number, "votes": number }  // votes = upvote count
```

**Timer**
```jsonc
{ "id": string, "label": string, "durationMs": number,
  "startedAt": number, "endsAt": number,
  "status": "running" | "ended" }
```

**Announcement**
```jsonc
{ "id": string, "title": string, "message": string, "detail": string,
  "color": string, "createdAt": number, "expiresAt": number }
```

**Visuals** (generative room background; guests evolve it)
```jsonc
{ "theme": string,        // one of VISUAL_THEMES (see below)
  "energy": number,       // 0..1
  "complexity": number,   // 0..1
  "hue": number,          // 0..360
  "editedBy": string, "editedAt": number|null }
```

**VisualEvent** (a short-lived phone-shake burst; auto-clears after ~5s)
```jsonc
{ "id": string, "type": "shake", "intensity": number, // 0..1
  "color": string, "requesterName": string, "at": number }
```

**Sprint** (autonomous Dreamfinder-hosted sprint session; on BOTH streams)
```jsonc
{ "status": "running" | "winding-down" | "paused" | "done",
  "phaseIndex": number,            // 0-based index into the session plan
  "totalPhases": number,
  "currentPhase": { "label": string, "mode": string,   // mode ∈ SHOW_MODES
                    "durationMs": number, "progress": number }, // progress 0..1
  "nextPhase": { "label": string, "mode": string } | null }     // null on last phase
```
`sprint === null` means no session is running. Sprint mode is **Dreamfinder
hosting the meetup**: when a phase's timer ends the engine autonomously ducks
the music, lands a soft chime, announces the next phase in the Dreamfinder
voice, and advances. `currentPhase.mode` drives the same `mode`/`timer`/
`visuals` fields a frontend already renders, so a sprint needs no new rendering
primitives — show `phaseIndex+1 of totalPhases` + the label, and the existing
clock/progress/visuals react on their own. The wind-down is visible as an amber
`announcement`. Host controls are private (`/api/sprint/*`, below); the
projection itself is public so guests see the room's structure.

**Spotlight** (SHOW STREAM ONLY — consented live spoken intro/progress)
```jsonc
{ "id": string, "eventId": string|null, "active": boolean,
  "participantName": string, "projectTitle": string,
  "kind": "introduction" | "progress",
  "transcript": string, "isFinal": boolean,
  "status": "listening" | "captured" | "research-failed" | string,
  "insights": object|null, "startedAt": number }
```
The participant's private token (`participantToken`) is present on the **show**
stream's spotlight for host controls but is never on the public stream.

**ShareEntry** (phone-led presentation queue; added protocol v1, additive)
```jsonc
// PUBLIC (on /api/events) — NEVER carries a token:
{ "id": string,            // opaque per-request id (how a guest finds ITS OWN row)
  "name": string,          // display label, snapshotted at request time
  "color": string,
  "kind": "share" | "progress",
  "projectTitle": string,
  "requestedAt": number,   // epoch ms
  "status": "requested" | "admitted" | "correcting" }
// SHOW (on /api/show-events) — the public fields PLUS:
//   "token": string        // the presenter's private auth token (host controls)
```
`shareQueue` is present on **both** streams (`[]` when empty). Terminal entries
(`finished`/`withdrawn`/`skipped`/`stopped`) are **pruned** and never appear on
the wire — the archived report lives in `/api/reports`. The **public** projection
**never** includes `token`; a guest locates its own entry by the opaque `id`
returned from `POST /api/share/request`, reads that row's `status`, and computes
its queue position (index among `requested` entries). At most ONE entry is ever
`admitted`/`correcting` (the single-active-presenter invariant); that entry's
`participantToken` is the spotlight gate (see below).

This field is **additive**: a frontend that does not understand `shareQueue`
ignores it; `ENGINE_PROTOCOL_VERSION` remains **1**.

### Closed sets

- `mode` / `event.phase` ∈ `welcome`, `free-jukebox`, `sprint-build`,
  `sprint-share`, `sprint-break`, `cool-down` (`SHOW_MODES`).
- `visuals.theme` ∈ `aurora`, `nebula`, `prism`, `embers`, `ocean`
  (`VISUAL_THEMES`).
- `event.status` ∈ `open`, `closed` (`EVENT_STATUS`).

## Write surface — JSON over HTTP

### Identity model

A guest has two layers: a **private random token** that authorises actions, and
a **visible label**. `POST /api/join` (only while an event is open) returns
`{ token, name, color }`; the token is the guest's secret. The visible label is
the generated Dreamfinder name (e.g. *Saffron Lark*) until the guest asserts a
GitHub handle via `/api/profile`, after which it shows `@handle`. The handle is
**participant-asserted, not verified** ownership.

### Guest actions (public — proxied)

All guest writes are **gated by an open event**: with `event === null` they
return **HTTP 403** `{ "error": "...", "eventClosed": true }`. Frontends should
treat `eventClosed: true` as "render the closed room", not as a hard error.

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/api/join` | — | mint identity → `{token,name,color}` (gated) |
| GET | `/api/whoami?t=token` | — | identity + project profile |
| POST | `/api/profile` | `{token, projectTitle, projectDescription, githubHandle, consentRecording, consentResearch}` | opt-in project profile (gated) |
| GET | `/api/search?q=` | — | yt-dlp top-5 YouTube results |
| POST | `/api/queue` | `{token, videoId, title, thumbnail}` | queue a track (gated) |
| GET | `/api/votes?t=token` | — | this token's upvoted + owned track ids |
| POST | `/api/upvote` | `{token, trackId}` | toggle one upvote (gated) |
| POST | `/api/visuals` | `{token, theme?, energy?, complexity?, hue?}` | evolve the generative background (gated) |
| POST | `/api/gesture` | `{token, type:"shake", intensity}` | transient visual burst (gated, rate-limited) |
| POST | `/api/share/request` | `{token, kind:"share"\|"progress"}` | request to present from your phone (gated; **requires `consentRecording`** → 409 if not). Returns `{id, status}` — the opaque `id` is how you find your own row |
| POST | `/api/share/withdraw` | `{token}` | leave the presentation queue (any non-terminal state) |
| POST | `/api/spotlight/transcript` | `{token, transcript, isFinal}` | stream live speech text **as the admitted presenter** — see the gate below |
| POST | `/api/spotlight/correct` | `{token, transcript}` | submit your final, edited transcript (the correction step) — same gate |
| GET | `/api/config` | — | configured join URL |
| GET | `/api/events` | — | the public SSE stream (above) |

#### The admitted-presenter gate (trust boundary)

`POST /api/spotlight/transcript` and `POST /api/spotlight/correct` are public guest
routes, but the `{token}` in the body is **not trusted as authorization**. Both
re-derive, on every request, the single source of truth `room.spotlight.participantToken`
(set by the host's `admit`, cleared by every terminal transition) and reject all
of these server-side:

| Condition | Status |
|---|---|
| missing / non-string / never-minted token | **401** |
| no live spotlight (none admitted, or already finished/stopped) | **409** |
| spotlight belongs to a different / closed event | **409** |
| a live spotlight but **not this token's turn** (a non-admitted or stale token) | **403** |

`correct` additionally flips the caller's queue entry to `correcting`, which is a
**hard precondition** for the host's `finish` — research/archive cannot run before
the presenter has confirmed their transcript.

### Host / admin actions (private — local/Tailscale only, never public-proxied)

`/admin` UI, `/api/event/open`·`/close`·`/archive`, `/api/mint`, `/api/mode`,
`/api/skip`, `/api/timer/start`·`/clear`, `/api/announce`·`/announce/clear`,
`/api/sprint/start`·`/pause`·`/resume`·`/skip`·`/extend`·`/stop` and
`GET /api/sprint`, `/api/spotlight/start`·`/insights`·`/end`,
`/api/share/admit`·`/skip`·`/stop`·`/finish` (the phone-led queue's host
controls — `admit` starts the presenter's spotlight, `finish` runs research+archives,
both **off the public proxy** like every other host control),
`/api/history`, `/api/reports`, `/api/attendees`, and `/api/show-events`. These
return **404** on the public proxy by design (like `/api/timer/*`). See
[CLAUDE.md](CLAUDE.md) for the full route table and the network/proxy split.

### State integrity — the guarded-mutation boundary

Every route that mutates **persisted, request-driven** room state **inline** does
so inside `state.commit(mutator)`, which **validates the proposed result before it
can persist or broadcast**. (Routes that delegate to a self-persisting helper —
`startTimer`/`clearTimer`, the `sprint.*` controls, event `open`/`close` — are the
carve-out below; they build state valid-by-construction and persist through
`savePersistentState`'s degrade-not-crash net.)

```
snapshot persisted state → run mutator (in place) → validateStateShape(result)
  valid   → persist the validated snapshot, return; the route then broadcasts
  invalid → roll the snapshot back, throw → route returns 4xx, broadcasts nothing
```

So a request that would produce a state the persistence gate rejects leaves
`room` **and** disk exactly as they were, and **no client ever sees it** — the
broadcast happens only after `commit()` returns. This closes the memory/disk
divergence that validating only at the persistence boundary leaves open (mutate →
broadcast bad state → save skipped → disk keeps last-good → a reboot time-travels).
`/api/mode` is the canonical example: it has no pre-check, so a bad mode flows
*through* the rollback and comes back `400` with state untouched.

Two deliberate carve-outs, by design rather than omission:
- **Event lifecycle** (`/api/event/open`·`/close`) owns `event`/`eventsArchive`
  (a different module) and is a host-only atomic transition with its own save —
  outside the guarded-mutation scope.
- **Ephemeral state** (`nowPlaying`, `announcement`, `visualEvent`, `spotlight`)
  is never persisted, so it cannot cause the divergence and is not snapshot/rolled
  back. Internal valid-by-construction writers (`createIdentity`, `recordPlay`,
  `startTimer`, sprint advances) persist through `savePersistentState`'s
  degrade-not-crash net, which remains the last line of defence.

This is a **server-internal invariant**, not a wire change: the protocol version
is unaffected. Frontends need do nothing — they simply never receive invalid state.

## Writing a new frontend

1. Open an `EventSource` to `/api/events` (public) or `/api/show-events` (local).
2. On each message, `JSON.parse` the text after `data: ` and render the snapshot
   wholesale — it is always complete, never a delta.
3. Read `version` from the first frame; warn (don't fail) on an unknown-higher one.
4. For interaction, `POST /api/join` to get a token, then call the guest action
   endpoints. Handle `403 {eventClosed:true}` as the closed-room state.

That is the entire contract. The engine can grow new shows (sprint, welcome,
reflect, share) by adding fields to this payload and rendering them N ways — the
`{version, event, nowPlaying, queue, timer, mode, sprint, ...}` shape is the
stable seam.
