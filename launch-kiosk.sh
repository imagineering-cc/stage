#!/usr/bin/env bash
# Stage TV kiosk launcher — opens the room display fullscreen in Chromium on
# the Pi's Wayland session. The systemd unit (stage-kiosk.service) waits for the
# Wayland socket and /room before running this; here we just exec Chromium.
set -euo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

URL="http://127.0.0.1:3000/room"
PROFILE="$HOME/.config/stage-kiosk-chromium"

exec /usr/bin/chromium \
  --kiosk "$URL" \
  --ozone-platform=wayland \
  --enable-features=UseOzonePlatform \
  --autoplay-policy=no-user-gesture-required \
  --user-data-dir="$PROFILE" \
  --password-store=basic \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --no-first-run \
  --start-fullscreen
