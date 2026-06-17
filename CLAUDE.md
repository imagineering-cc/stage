# Stage

> _"One little spark of inspiration is at the heart of all creation."_

**Stage** is **Dreamfinder's third surface** — its body in physical space.
The room itself, made aware. A Raspberry Pi running a tiny Node server lets
every meetup attendee scan a QR code, get a playful Dreamfinder handle
(Saffron Lark, Indigo Heron, Crimson Hare), search YouTube, queue tracks,
and watch the room's TV come alive with attribution as their music plays.

The three surfaces of Dreamfinder:

- **`dreamfinder/`** — *the brain*. Matrix PM bot. Coordinates the org over chat.
- **`embodied-dreamfinder/`** — *the face*. 3D avatar with realtime voice.
- **`stage/`** *(this project)* — *the body in physical space*. The room's
  awareness — its eyes, ears, voice, and heartbeat at meetups.

Dreamfinder is a golem functioning as a familiar in service of producing
egregores (see `../.claude/CLAUDE.md`). Stage is where the egregore
*becomes physical* — where the shared vision takes on light and sound and
shows the room what the room is doing.

## Status (last touched 2026-06-16)

**Shipped its first show live during an Imagineering build-and-share meetup,
2026-05-02 (sprint 4 of 4).** Strangers scanned QRs and queued tracks; music
played through the TV; the room page glowed with the requesters' assigned
colors. The audience was reportedly "super impressed." Nick rick-rolled himself
on the API as a final test. It was a hell of a session.

**Became an engine, 2026-06-16.** The single-file `server.js` (1147 lines, zero
tests) was dissolved into nine focused, independently-testable modules under a
zero-dep smoke harness, then the SSE payload that every surface already consumed
was formalized as an explicit, versioned, CI-enforced **engine wire contract**
([ENGINE.md](ENGINE.md)). The first proof followed immediately: a native **LG
webOS** room frontend (`webos/`) that shares no code with the kiosk and renders
the room purely by consuming `/api/events` over the network — verified rendering
live production state cross-origin. Stage is now a reusable show-control engine
with swappable frontends, not a Pi-bound app.

**What works today:**

- ✅ Phone scans one stable QR / opens `imagineering.cc/stage` → gets a private browser token; an entered GitHub handle becomes its visible identity
- ✅ Search YouTube via yt-dlp (instant, no API key)
- ✅ Tap result → queued; attendees can upvote, while equal-vote tracks rotate fairly between requesters
- ✅ mpv plays through TV via HDMI (audio-device pinned to `vc4hdmi0`)
- ✅ Admin app shows join QR, room phase controls, timer, history, queue, attendees, and skip
- ✅ Guests can complete a speech-guided project profile intake, opt into spotlight transcription/research, choose from animated visual previews, and fire a shake gesture burst
- ✅ Room page shows a generative Canvas background, QR, now-playing, phase label, split-flap clock, progress bar, and timer alarm
- ✅ Host spotlight captures consented spoken intros/progress reports; live words drift across the TV and archived reports persist
- ✅ Consented spotlight analysis searches opted-in public GitHub repositories plus arXiv/OpenAlex literature and presents questions/directions in a perspective crawl
- ✅ Live updates everywhere via Server-Sent Events (zero npm dependencies on the server)
- ✅ Modular engine: `config`/`names`/`ytSearch`/`state`/`sse-hub`/`mpv`/`event-session`/`research`/`routes`, with `server.js` a 54-line composition root (shared mutable state owned by `state.js`; cross-module cycles broken by a late-bound `state.hooks` registry)
- ✅ Zero-dep smoke harness (`test/smoke.js`, `node:test`) wired into CI — pins join-gating, event lifecycle, queue sort, vote toggle, spotlight eventId, and the engine wire contract
- ✅ Versioned engine wire contract ([ENGINE.md](ENGINE.md)): `statePayload` carries `ENGINE_PROTOCOL_VERSION`; read streams send `Access-Control-Allow-Origin: *` so off-origin frontends can consume them
- ✅ Native **LG webOS** room frontend (`webos/`) — a swappable frontend on the engine contract; verified rendering live state cross-origin (on-device LG TV install still pending hardware). Coequal with the Pi Chromium kiosk, not a replacement: both are independent SSE consumers, so run either or both per occasion (`systemctl --user stop/start stage-kiosk` toggles the kiosk). Both are *visual* only — audio always plays from the Pi's HDMI via `mpv` in `stage-server.service`. See [webos/README.md](webos/README.md).
- ✅ Identity/project profiles, reports, visuals, history, waiting queue/votes, room phase, and timer state survive Node restarts
- ✅ Systemd user services start the Stage server and TV kiosk at boot
- ✅ Pi reachable from the public Caddy host over Tailscale
- ✅ Linksys WRT1900ACS has OpenWrt installed for the guest-network/router role
- ✅ `https://imagineering.cc/stage` publicly proxies to the guest app on the Pi

**Current delivery roadmap:** see [PLAN.md](PLAN.md).

## The story (so future-you can recall it)

This started as "I have a Pi, a TV, and an idea about a music player with crazy
3D animations" and evolved live across one conversation into something much
bigger:

1. **The reframe** that defined the project: the TV isn't a screen, it's the
   room's heartbeat. A *Dreamfinder*-style instrument that scores the meetup —
   currently a jukebox, eventually a sprint timer + visualizer + show-control
   surface that orchestrates the whole event. The TV becomes the *stage* on
   which the room's collective work plays.
2. **Host-minted QR codes** as the identity model — Nick proposed this midway
   through, replacing my "self-minted cards" idea. Much better: the host's act
   of minting becomes a small ritual, no UX friction, no save-this-URL anxiety.
3. **Three surfaces, one event bus** — guest PWA, host admin, room TV — all
   subscribe to the same SSE stream `{nowPlaying, queue}`. Adding sprint mode
   later will be `{mode, nowPlaying, queue, sprintEndsAt}` — the data shape is
   stable.
4. **The network odyssey** ate ~75 minutes of sprint time. Venue WiFi had
   client isolation; the Pi's Linksys had no upstream; Mac had no Ethernet
   adapter; cell reception was bad. Eventually solved with a dual-homed Pi
   (venue WiFi for internet via Tailscale, Linksys ethernet for guest LAN
   reachability) — exactly the production architecture the meetup needs, just
   configured live mid-sprint. See [Network](#network-setup) below.
5. **The build itself was ~15 minutes once we stopped fighting networks.**
   Subagent built admin.html and room.html in parallel while I wrote
   server.js + index.html. Total fresh code: one server, three HTML pages, a
   vendored 20KB qrcode lib.
6. **The Rick Roll** — when the user reported "I queued another track but it
   didn't play," I queued `dQw4w9WgXcQ` via curl as a diagnostic. It played.
   Loud. The first track ever played on a Stage-powered system is officially
   _Never Gonna Give You Up_. Going on a t-shirt eventually.

The vibe of the build was excellent — playful, fast, recovered well from
mistakes. Nick pushed back on three of my bad calls and was right every time
(see "Don't be daft" / "no" / "calm down" moments — each was a needed
calibration). The collaboration was sharper for the friction.

## Architecture

```
                ┌──────────────────────┐
                │  Server-Sent Events  │  ← public guest state
                │  /api/events         │     playback + visuals only
                │  /api/show-events    │  ← private display/admin transcript stream
                └─────────┬────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   ┌────▼─────┐      ┌────▼─────┐      ┌────▼──────┐
   │ Guest    │      │  Admin   │      │   Room    │
   │ PWA      │      │ (/admin) │      │ (TV,      │
   │          │      │          │      │  Chromium │
   │ /stage   │      │ join QR  │      │  kiosk    │
   │ auto ID  │      │ timer    │      │  /room    │
	   │ visuals  │      │ spotlight│      │ transcript│
   └──────────┘      └──────────┘      └───────────┘
        │                 │                 ▲
        └────POST /api ───┘                 │
                  │                         │
            ┌─────▼─────────────────────────┴─────┐
            │   Node engine, zero npm deps        │
            │   server.js = 54-line comp. root    │
            │   ┌─────────────────────────────┐   │
	            │   │  state.js (room state nexus)│   │
	            │   │  + persistence + fair queue │   │
	            │   │  event-session.js (gating)  │   │
            │   │  research.js (GH/arXiv/etc) │   │
            │   │  mpv.js (JSON IPC)           │   │
            │   │  sse-hub.js (broadcast)      │   │
            │   │  ytSearch.js / names / config│   │
            │   │  routes.js (HTTP dispatch)   │   │
            │   └─────────────────────────────┘   │
            └─────────────────┬───────────────────┘
                              │
                       JSON IPC at
                  /tmp/dreamfinder-mpv.sock
                              │
                       ┌──────▼─────┐
                       │    mpv     │
                       │  --no-video │
                       │  audio→HDMI │
                       └────┬───────┘
                            │
                  ┌─────────▼─────────┐
                  │ TV speakers       │
                  │ (vc4hdmi0, ALSA)  │
                  └───────────────────┘
```

Architectural choices worth defending:

- **SSE over WebSocket** — the server has zero npm deps. SSE is just
  long-lived HTTP. Auto-reconnect is built into `EventSource`. We're
  fan-out-only (server→clients); no need for bidi.
- **Modular engine, zero deps** — nine focused modules carved from the original
  god file (under a smoke harness, one module per green commit). `state.js` owns
  every shared mutable global; `sse-hub`/`mpv`/`research`/`routes` reach
  `broadcast`/`playNext`/event-accessors through a late-bound `state.hooks`
  registry wired by `server.js`'s composition root, which breaks the require
  cycles without adding a dependency. See [ENGINE.md](ENGINE.md).
- **The SSE payload IS the engine's public API** — `{version, event, nowPlaying,
  queue, timer, mode, announcement, visuals, visualEvent, sprint, [spotlight]}`
  is a versioned, CORS-open, CI-enforced wire contract. `sprint` is the
  autonomous Dreamfinder-hosted sprint session (or null when idle; see
  ENGINE.md). Any number of frontends
  (guest PWA, admin, room TV, native webOS app) consume it and render N ways; no
  service-to-service plumbing. Adding a show = adding fields, not services.
- **Private speech stream** — `/api/events` is publicly proxied for guests, but
  transcripts, reports, research output, and host controls are available only
  on local/Tailscale `/api/show-events` and host routes.

## Network setup

> **Venue specifics (Pi Tailscale IP, WiFi SSIDs/passwords, exact LAN/DHCP
> addresses) live in `ops/network.local.md`, which is gitignored.** This public
> doc keeps only the reusable architecture and recipe.

The Pi (`raspberrypi`) is dual-homed:

- **`wlan0`**: connects to the venue WiFi (or your home WiFi). Provides
  internet for yt-dlp + Tailscale. Default route lives here.
- **`eth0`**: wired into the Linksys WRT1900ACS (LAN port). Pi gets a
  Linksys-subnet IP (e.g. `192.168.1.171`). Used only for guest reachability;
  never the default route.

The configuration that makes this work without breaking DNS or routing:

```bash
sudo nmcli con mod "Wired connection 1" \
  ipv4.never-default yes \
  ipv4.ignore-auto-dns yes \
  ipv4.route-metric 700
```

Both flags are necessary. `never-default` keeps the default route on WiFi
(critical because the Linksys may have no upstream). `ignore-auto-dns`
prevents the Linksys's broken DNS server from poisoning resolv.conf —
without this flag yt-dlp will silently fail with "Failed to resolve
www.youtube.com." Tailscale's MagicDNS (`100.100.100.100`) ends up as
the resolver, which is great.

**Guest phones** use the stable public join URL
`https://imagineering.cc/stage`. The intended public Caddy route proxies the
guest page and guest APIs to the Pi over Tailscale so attendees do not need to
join the Linksys WiFi. The OpenWrt LAN remains useful as a local fallback:
`dreamfinder.lan` resolves to the Pi's guest-LAN IP.

The Linksys WRT1900ACS has since been flashed to OpenWrt for the router/AP
role. Guest and upstream WiFi credentials are in `ops/network.local.md`.

Current state: the OpenWrt guest AP is running and has upstream internet
through the room WiFi via OpenWrt `wwan`. Observed guest-network DHCP behavior,
the guest subnet, and the Pi's static lease are recorded in
`ops/network.local.md`. In summary: guests join the OpenWrt AP, get a
`192.168.1.0/24` address, and reach the Pi at `dreamfinder.lan`.

Verified from the Pi over Tailscale on 2026-05-23 (concrete addresses in
`ops/network.local.md`):

- The Pi is reachable on its Tailscale IP, its room-WiFi IP, and its guest-LAN
  IP (`/24` on `eth0`)
- OpenWrt LAN is `192.168.1.1/24`; DHCP start `100`, limit `150`, lease `12h`
- OpenWrt `wwan` is uplinked via the room WiFi
- Stage server responds locally on the Pi at `http://127.0.0.1:3000/`
- Live Caddy route:
  `/stage`, `/api/join`, `/api/whoami`, `/api/profile`, `/api/search`,
  `/api/queue`, `/api/upvote`, `/api/votes`, `/api/visuals`,
  `/api/gesture`, and `/api/events` → the Pi over Tailscale;
  admin/timer/announce endpoints stay off the public route
- Verified from the public internet on 2026-05-25:
  `GET /stage`, `/api/join`, `/api/whoami`, `/api/events`, and `/api/search`
  work; `/admin`, `/api/mint`, `/api/skip`, `/api/timer/start`, and
  `/api/announce` return `404`
- Public `/api/mode` and `/api/history` also return `404`; host-only controls
  remain available through Tailscale/LAN access
- Public `/api/profile`, `/api/visuals`, and `/api/gesture` now proxy to the
  Pi (invalid-token probes return `401`); private `/api/show-events`,
  `/api/reports`, and `/api/spotlight/*` return `404` publicly
- **M2 DEPLOYMENT (pending on the public Caddy host):** the phone-led share
  queue adds FOUR public guest routes that must be ADDED to the Caddy allow-list
  so a guest's own phone can drive its presentation:
  `/api/share/request`, `/api/share/withdraw`, `/api/spotlight/transcript`, and
  `/api/spotlight/correct`. The host controls `/api/share/admit`·`/skip`·`/stop`·
  `/finish` are DELIBERATELY left OFF the allow-list — that omission IS the
  host-only boundary (identical to `/api/skip`, `/api/timer/*`). Note this opens
  `/api/spotlight/transcript`+`/correct` publicly for the first time; both are
  per-token gated in-app (only the admitted presenter's token is accepted), so
  the trust boundary is enforced TWICE: at the proxy (reachability) and in-app
  (token gate). The token-bearing `shareQueue` lives only on `/api/show-events`,
  which stays off the public route.
- Generative room and mobile-control pages were rendered from the deployed
  build with Playwright at TV and phone viewports; both produced nonblank
  captures, and the Pi can reach OpenAlex scholarly search
- Split-flap timer/progress data path verified with a temporary timer over SSE,
  then cleared; kiosk runs with Chromium autoplay allowed for alarm audio
- `stage-server.service` and `stage-kiosk.service` are enabled and active as
  systemd user services; lingering is enabled for boot startup

**Admin and dev access** is via Tailscale (`ssh nick@<pi-tailscale-ip>`; the
admin page works at `http://<pi-tailscale-ip>:3000/admin` from any machine on
the tailnet). The concrete address is in `ops/network.local.md`.

## Files

```
stage/
├── server.js          # 54-line composition root: wire hooks, boot mpv, listen
├── config.js          # env-derived constants + ENGINE_PROTOCOL_VERSION
├── state.js           # mutable-state nexus: room state, persistence, fair queue
├── event-session.js   # host-controlled event lifecycle that gates participation
├── sse-hub.js         # statePayload (the wire contract) + broadcast fan-out
├── mpv.js             # mpv JSON-IPC + playNext
├── research.js        # consented GitHub/arXiv/OpenAlex + spotlight facilitation
├── sprint.js          # autonomous Dreamfinder-hosted sprint sequencer (rides the one timer)
├── ytSearch.js        # yt-dlp child for YouTube search
├── names.js           # Dreamfinder handle generator
├── routes.js          # HTTP dispatch + helpers + open-event guard
├── ENGINE.md          # the engine wire-protocol contract (frontends code to this)
├── test/
│   └── smoke.js       # zero-dep behaviour + contract smoke suite (CI-enforced)
├── public/
│   ├── index.html     # Guest PWA — project consent, visuals/shake, queue/vote
│   ├── admin.html     # Host tool — QR, mode, timer, spotlight, reports, queue
│   ├── room.html      # TV (Chromium kiosk) — Canvas visuals, clock, playback
│   └── qrcode.min.js  # Vendored qrcode-generator (20KB, no CDN dep)
├── webos/             # native LG webOS room frontend (swappable, on ENGINE.md)
│   ├── appinfo.json   # webOS app manifest
│   ├── index.html     # self-contained TV room view + SSE client
│   └── README.md      # package/install (ares-*) + engine-URL config
├── ops/               # Systemd user units, Pi installer, provisioner
├── PLAN.md            # Product milestones and immediate implementation slice
└── CLAUDE.md          # This file
```

## API contract

| Method | Path                | Purpose                                       |
|--------|---------------------|-----------------------------------------------|
| GET    | `/`                 | Guest PWA                                     |
| GET    | `/stage`            | Canonical guest PWA join path                 |
| GET    | `/admin`            | Host admin app                                |
| GET    | `/room`             | Room/TV display                               |
| GET    | `/static/<file>`    | Serve from `public/`                          |
| GET    | `/api/config`       | Host-only configured join URL                 |
| GET    | `/api/whoami?t=…`   | Guest identity and the guest's project profile |
| POST   | `/api/join`         | Guest self-join; returns `{token, name, color}` |
| POST   | `/api/profile`      | Guest project details and recording/research consent |
| POST   | `/api/visuals`      | Guest updates generative theme/energy/complexity |
| POST   | `/api/gesture`      | Guest phone shake sends a transient visual burst |
| POST   | `/api/mint`         | Legacy/manual identity mint                   |
| GET    | `/api/search?q=…`   | yt-dlp top-5 YouTube results                  |
| POST   | `/api/queue`        | Body `{token, videoId, title, thumbnail}` → adds to queue |
| GET    | `/api/votes?t=…`    | Current token's upvoted and owned queued track IDs |
| POST   | `/api/upvote`       | Body `{token, trackId}` → toggles one upvote  |
| POST   | `/api/skip`         | Stop current track, advance queue             |
| GET    | `/api/history`      | Host-only recent played tracks                |
| GET    | `/api/reports`      | Host-only archived spotlight reports/results  |
| GET    | `/api/event`        | Host-only current event + archive list        |
| POST   | `/api/event/open`   | Host opens a fresh event `{title}`; 409 if already open |
| POST   | `/api/event/close`  | Host closes + archives the open event; 409 if none |
| GET    | `/api/event/archive`| Host-only past events; `?id=` returns that event's reports/history/attendees |
| POST   | `/api/mode`         | Host-only room phase selection                |
| POST   | `/api/spotlight/start` | Host begins a consented intro/progress turn |
| POST   | `/api/spotlight/transcript` | Admitted presenter streams speech text (per-token gated) |
| POST   | `/api/spotlight/correct` | Admitted presenter submits final edited transcript (per-token gated) |
| POST   | `/api/spotlight/insights` | Host runs consented GitHub/arXiv/OpenAlex analysis |
| POST   | `/api/spotlight/end` | Host archives and clears the spotlight        |
| POST   | `/api/spotlight/facilitation/dismiss` | Host veto: dismiss Dreamfinder's question (host-only) |
| POST   | `/api/spotlight/facilitation/another` | Host veto: request another question; cursor++ free, re-search rate-limited (host-only) |
| POST   | `/api/share/request` | Guest requests to present `{token, kind}`; requires recording consent |
| POST   | `/api/share/withdraw` | Guest leaves the presentation queue `{token}` |
| POST   | `/api/share/admit`  | Host admits a presenter `{token}` → starts their spotlight (host-only) |
| POST   | `/api/share/skip`   | Host removes a queued/live presenter `{token}` (host-only)  |
| POST   | `/api/share/stop`   | Host stops the live presenter, no archive (host-only)      |
| POST   | `/api/share/finish` | Host finishes the live presenter: research + archive (host-only) |
| POST   | `/api/timer/start`  | Body `{minutes}` or `{seconds}` → starts timer |
| POST   | `/api/timer/clear`  | Clears active/ended timer                     |
| GET    | `/api/sprint`       | Host-only current sprint session + full plan  |
| POST   | `/api/sprint/start` | Host starts a sprint `{plan?, durations?, windDownMs?}`; 409 if running |
| POST   | `/api/sprint/pause` | Host pauses the running phase (banks remaining time) |
| POST   | `/api/sprint/resume`| Host resumes a paused phase                   |
| POST   | `/api/sprint/skip`  | Host advances now (runs the wind-down ceremony early) |
| POST   | `/api/sprint/extend`| Host adds time to the running phase `{minutes\|seconds}` |
| POST   | `/api/sprint/stop`  | Host ends the session; room returns to free-jukebox |
| GET    | `/api/events`       | Public SSE playback/visual state; no transcript |
| GET    | `/api/show-events`  | Private room/admin SSE including spotlight text/results |

Persistent state is stored atomically in `stage-state.json` on the Pi. It
retains identities and consented profiles, archived reports/results, visuals,
recent play history, waiting queue/votes, timer, and room phase across service
restarts. A live interim transcript is intentionally not persisted until the
host ends the spotlight. The actively playing track is not resumed after a
restart; the next retained queued track starts instead.

Guest identity has two layers: a private random token authorizes actions, while
the visible participant label changes to `@github-handle` after a participant
supplies a syntactically valid handle, falling back to the generated
Dreamfinder name. The handle is participant-asserted, not proof of GitHub
account ownership.

The join QR destination defaults to `https://imagineering.cc/stage` and can
be overridden for another venue using the `STAGE_JOIN_URL` environment
variable on `stage-server.service`.

Evidence search runs without secrets against public GitHub repositories
provided by consenting participants plus arXiv and OpenAlex. Optional
Dreamfinder-authored questions/directions use the OpenAI Responses API only
when `STAGE_OPENAI_API_KEY` is installed in a private systemd drop-in; configure
`STAGE_OPENAI_MODEL` and `STAGE_GITHUB_TOKEN` there as needed. Without a model
key, the room labels the analysis as source-backed facilitation rather than
claiming generated commentary.

## Running it on the Pi

The deployed copy lives at `~/stage/` on the Pi.

```bash
ssh nick@<pi-tailscale-ip>   # address in ops/network.local.md
cd ~/stage
./ops/install-user-services.sh
```

The installer owns `stage-server.service` and `stage-kiosk.service` in the
user systemd manager. Check them with:

```bash
systemctl --user status stage-server.service stage-kiosk.service
journalctl --user -u stage-server.service -u stage-kiosk.service -f
```

The kiosk launcher includes `--autoplay-policy=no-user-gesture-required` so
timer alarm audio can play without a click. The kiosk unit waits for both the
Wayland socket and `/room` before opening Chromium.

The Pi has `mpv`, `node` (v20), `npm`, and `yt-dlp` (via pip
`--break-system-packages`). All installed via apt + pip during the meetup
session.

## Pending

The current plan is captured in [PLAN.md](PLAN.md). The next implementation
slice is host-controlled event sessions and public interaction gating, after a
real-phone smoke test of the deployed guest flow.

## The vision (north star)

Stage is not a music player with extras. It is a **show-control system
whose first show is a music jukebox**. Other shows it should run, in roughly
the order they should ship:

- **Sprint mode** — score the meetup's three 25-min sprints with phase-aware
  music + visuals + a buzzer that's actually a graceful musical wind-down.
- **Welcome / cool-down modes** — ambient music + introductory visuals when
  people arrive; reflective music when winding down.
- **"What we built" share-phase capture** — guests submit links/screenshots
  from their phones during share, displayed on the TV.
- **Cross-meetup persistence** — Indigo Heron is *Indigo Heron* every time.
  The room remembers. Maybe people accumulate small visual badges based on
  what they've queued historically.
- **Audio-reactive shader visualizer** — the "breathing" pulse becomes real
  FFT-driven motion layered into the interactive Canvas show.

The *Dreamfinder* family naming convention should be preserved — every show
the system runs has a name evocative of the room's life. Tonight's
jukebox is the first; future modules might be `sprint`, `welcome`,
`reflect`, `share`, etc. — each a different *show* the Stage runs.

## Wins from session 1

- Built spine end-to-end on real hardware, in real time, in front of real humans
- Host-mints-QR identity model emerged from collaboration and worked beautifully
- Three-surface architecture clean enough to grow without refactoring
- Network architecture (dual-homed Pi + venue-independent Linksys plan) battle-tested
- The Rick Roll (genuinely one of the funniest moments of the build)
- Saffron Lark, Saffron Fox, the whole Dreamfinder palette springing to life on
  guests' phones
