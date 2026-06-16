# Stage Room — webOS TV app

A native **LG webOS** room display for Stage. It is a *swappable frontend* that
stands entirely on the engine's wire contract ([../ENGINE.md](../ENGINE.md)):
it opens the `/api/events` SSE stream, reads the versioned `statePayload`, and
renders the room on the TV. It shares no code with the Pi's Chromium-kiosk
`public/room.html` — it's a second, independent consumer of the same engine.

**Why this exists:** today the room TV is a Chromium kiosk the Pi drives
(`stage-kiosk.service`). This app makes the **TV a thin client to the engine
over the network**, so the Pi is the engine, not a display driver — the first
proof that the formalized engine contract supports a genuinely new frontend.

## Files

| File | What |
|---|---|
| `appinfo.json` | webOS app manifest (id, version, type, main page, icons) |
| `index.html` | the whole app — self-contained TV room view + SSE client |
| `icon.png` / `largeIcon.png` | launcher icons (80×80 / 130×130) — **TODO: replace placeholders with Dreamfinder art** |

## Pointing it at an engine

Engine base URL resolution (first match wins):

1. `?engine=<url>` query param — e.g. open `index.html?engine=http://dreamfinder.lan:3000` in any browser to test against the Pi
2. `localStorage['stage.engine']` (set once by the query param above; persists)
3. Default: `https://imagineering.cc` (the public Caddy proxy — works anywhere)

For a venue LAN, point it at the Pi directly (`http://dreamfinder.lan:3000` or
the Pi's LAN IP). A packaged webOS app is **not** an https origin, so a plaintext
`http://<pi>:3000` engine is fine (no mixed-content block). Over the public proxy,
use `https`.

## Develop / package / install

Requires the [webOS TV CLI](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)
(`ares-*`). The app is a plain web app — no build step.

```bash
# from this directory:
ares-package .                              # -> cc.imagineering.stage.room_0.1.0_all.ipk
ares-setup-device                           # one-time: register your TV (Developer Mode on)
ares-install --device <tv> cc.imagineering.stage.room_0.1.0_all.ipk
ares-launch  --device <tv> cc.imagineering.stage.room
# live-debug the running app:
ares-inspect --device <tv> --app cc.imagineering.stage.room --open
```

To set the engine URL on the TV build, either bake it into
`ENGINE_BASE_DEFAULT` in `index.html` before packaging, or launch with a
parameter the app reads (the `?engine=` query path).

## Verification status

- ✅ **Renders the live engine state as a web app** — verified by loading
  `index.html?engine=http://<pi>:3000` against the running Pi engine and
  confirming now-playing / queue / phase / timer render and update over SSE,
  and that the protocol `version` is read.
- ⏳ **On-device (real LG TV) install + remote-control behaviour** — NOT yet
  verified; needs a webOS TV in Developer Mode + the `ares-*` CLI (hardware not
  on hand). This is the open gate before calling the webOS surface "done".

## Alternative: hosted web app

If you'd rather not maintain a separate TV view, webOS also supports a
*hosted web app* whose `main` is a remote URL — point it at the engine's
`/room` and reuse `public/room.html`. That's simpler but ships the
kiosk-oriented page (mouse-built, Pi-driven look) rather than this
TV-/remote-aware one. This app is the packaged route precisely to demonstrate
the engine contract carrying an independent frontend.
