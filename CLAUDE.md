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

## Status (last touched 2026-05-02 evening / 2026-05-03 wee hours)

**Shipped its first show live during an Imagineering build-and-share meetup,
2026-05-02 (sprint 4 of 4).** Strangers scanned QRs and queued tracks; music
played through the TV; the room page glowed with the requesters' assigned
colors. The audience was reportedly "super impressed." Nick rick-rolled himself
on the API as a final test. It was a hell of a session.

**What works today:**

- ✅ Phone scans QR → gets Dreamfinder identity (Adjective Animal name + deterministic hue)
- ✅ Search YouTube via yt-dlp (instant, no API key)
- ✅ Tap result → queued (FIFO)
- ✅ mpv plays through TV via HDMI (audio-device pinned to `vc4hdmi1`)
- ✅ Admin app mints QRs, shows queue, skips current track
- ✅ Room page on TV shows now-playing huge with requester nickname in their color, queue ribbon at bottom
- ✅ Live updates everywhere via Server-Sent Events (zero npm dependencies on the server)
- ✅ Pi auto-reachable from anywhere via Tailscale

**Known half-done / next-session work:** see [Pending](#pending) below. The
big one is OpenWrt on the Linksys — flash was mid-flight when the session
ended.

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
                │  Server-Sent Events  │  ← single source of truth
                │  /api/events         │     {nowPlaying, queue}
                └─────────┬────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   ┌────▼─────┐      ┌────▼─────┐      ┌────▼──────┐
   │ Guest    │      │  Admin   │      │   Room    │
   │ PWA (/)  │      │ (/admin) │      │ (TV,      │
   │          │      │          │      │  Chromium │
   │ scan QR  │      │ mint QRs │      │  kiosk    │
   │ search   │      │ skip     │      │  /static/ │
   │ queue    │      │ see all  │      │   room    │
   └──────────┘      └──────────┘      └───────────┘
        │                 │                 ▲
        └────POST /api ───┘                 │
                  │                         │
            ┌─────▼─────────────────────────┴─────┐
            │      Node server (server.js)        │
            │   single file, zero npm deps        │
            │   ┌─────────────────────────────┐   │
            │   │  identityStore (in-memory)  │   │
            │   │  queueManager (FIFO)         │   │
            │   │  ytSearch (yt-dlp child)     │   │
            │   │  mpvController (JSON IPC)    │   │
            │   │  sseHub (broadcast)          │   │
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
                  │ (vc4hdmi1, ALSA)  │
                  └───────────────────┘
```

Three architectural choices worth defending:

- **SSE over WebSocket** — the server has zero npm deps. SSE is just
  long-lived HTTP. Auto-reconnect is built into `EventSource`. We're
  fan-out-only (server→clients); no need for bidi.
- **Single-file server** — ~250 lines, easy to read end-to-end. Ages well for
  a project with this scope.
- **Three surfaces, one bus** — adding sprint mode means changing the
  `{mode, nowPlaying, queue}` shape and rendering it three different ways. No
  service-to-service plumbing.

## Network setup

The Pi (`raspberrypi`, Tailscale `<pi-tailscale-ip>`) is dual-homed:

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

**Guest phones** join the Linksys WiFi. The QR codes encode `http://192.168.1.171:3000/?t=<token>` — the Pi's eth0 IP. This **must be updated** when
the Pi gets a different ethernet IP (different DHCP lease, different
Linksys config). It's hardcoded in `public/admin.html` as `LAN_URL`.

**Admin and dev access** is via Tailscale: `ssh nick@<pi-tailscale-ip>`. Admin
page works at `http://<pi-tailscale-ip>:3000/admin` from Mac on any network.

## Files

```
stage/
├── server.js          # Single-file Node server (~250 lines)
├── public/
│   ├── index.html     # Guest PWA — scan QR → search → queue
│   ├── admin.html     # Host tool — mint QRs, see queue, skip
│   ├── room.html      # TV display — fullscreen, requester-color glow
│   └── qrcode.min.js  # Vendored qrcode-generator (20KB, no CDN dep)
└── CLAUDE.md          # This file
```

## API contract

| Method | Path                | Purpose                                       |
|--------|---------------------|-----------------------------------------------|
| GET    | `/`                 | Guest PWA (reads `?t=<token>` from URL)       |
| GET    | `/admin`            | Host admin app                                |
| GET    | `/static/<file>`    | Serve from `public/`                          |
| GET    | `/api/whoami?t=…`   | `{name, color}` for a token                   |
| POST   | `/api/mint`         | Returns `{token, name, color}` for new attendee |
| GET    | `/api/search?q=…`   | yt-dlp top-5 YouTube results                  |
| POST   | `/api/queue`        | Body `{token, videoId, title, thumbnail}` → adds to queue |
| POST   | `/api/skip`         | Stop current track, advance queue             |
| GET    | `/api/events`       | SSE stream of `{nowPlaying, queue}`           |

State is **in-memory**. A server restart loses identities, queue,
and now-playing. Persistence is a future task (SQLite would suffice).

## Running it on the Pi

The deployed copy lives at `~/dreamfinder/` on the Pi (named `dreamfinder`
historically; that directory is the running instance — leave it for now or
rename to `stage` next session).

```bash
ssh nick@<pi-tailscale-ip>
cd ~/dreamfinder
nohup node server.js > server.log 2>&1 &
```

Check it's listening: `ss -tlnp | grep :3000` should show node on `0.0.0.0:3000`.

The Chromium kiosk for the TV is launched separately:

```bash
~/dreamfinder/launch-kiosk.sh   # writes chromium.log
```

Currently launched ad-hoc via `nohup setsid bash launch-kiosk.sh ...`. Should
become a systemd user service so it survives reboots — that's a future task.

The Pi has `mpv`, `node` (v20), `npm`, and `yt-dlp` (via pip
`--break-system-packages`). All installed via apt + pip during the meetup
session.

## Pending

In rough priority order:

1. **OpenWrt flash on the WRT1900ACS** (mid-flight when session ended). The
   factory image is at `~/Downloads/openwrt/openwrt-25.12.2-wrt1900acs-factory.img`
   on Nick's Mac (SHA256 verified against the official sums). The plan is in
   the conversation transcript: flash via stock UI → SSH from Pi to OpenWrt
   at `192.168.1.1` (since Mac has no ethernet) → configure routed-client
   WISP mode + AP for guests + dnsmasq for `dreamfinder.local`. The dual
   firmware partition makes failed flashes auto-recover after 3 power cycles
   — fearless to attempt.
2. **Add `/room` route to server.js** — currently the kiosk loads
   `/static/room.html`. Trivial fix; just adds an alias. Server restart
   interrupts mpv though, so do it during a downtime.
3. **Move project on Pi from `~/dreamfinder/` to `~/stage/`** to match the
   org-side rename. Update launcher script paths.
4. **systemd user service** for the server + the Chromium kiosk so they
   survive reboots and Nick doesn't have to ssh in every time.
5. **Persistence** — SQLite store for identities (so attendees can keep their
   handle across meetups) and play history (so we know what was played and
   can build a "play it again" feature).
6. **Sprint mode** (the *real* Stage feature, ref: captured task #1
   "Design jukebox-as-meetup-instrument: sprint mode + Dreamfinder framing"):
   - state machine: `free-jukebox` → `sprint-build` → `sprint-share` → `sprint-break`
   - admin controls to start/configure sprints
   - room visualizer reflects phase + time-remaining
   - musical wind-down at sprint end (volume curve + closing chord)
   - maybe themed playlist behavior per phase (focus during build, etc.)
7. **Audio FFT loopback + WebGL shader visualizer** on the room page. The
   "breathing" CSS keyframe pulse on the now-playing card is a placeholder
   meant to be wired to bass amplitude. Need to set up a PipeWire null-sink,
   tap PCM, FFT server-side, broadcast bins via WS or SSE.
8. **Round-robin + upvote queue** to replace FIFO (currently `if (!nowPlaying)
   playNext()` and `queue.push`). The design is in captured task #1: round-robin
   between requesters as the floor, upvotes promote across slots (Nick chose
   "popular tracks can jump the queue").
9. **Move CDN-loaded fonts/icons to vendored or system-stack only** if anything
   creeps in. Tonight already vendored qrcode lib — venue WiFi blocks
   jsdelivr in some cases, so vendor everything.
10. **Mode-aware QR generation** — the `LAN_URL` in admin.html is hardcoded.
    Should be derived dynamically from the request, OR settable via admin UI.

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
  FFT-driven motion, raymarched fragment shaders, the visual signature of
  the room.

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
