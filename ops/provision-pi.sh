#!/usr/bin/env bash
# Provision a bare Raspberry Pi with everything Stage execs at runtime.
#
# This is the layer BELOW ops/install-user-services.sh. That installer
# deliberately asserts node/curl/systemctl already exist and refuses to run
# otherwise — it never installs system packages. This script fills exactly that
# gap: it turns a fresh Raspberry Pi OS image into one where the Stage server
# and TV kiosk have every binary they spawn.
#
#   server.js  spawns:  node (itself), yt-dlp, mpv
#   launch-kiosk.sh exec's:  /usr/bin/chromium (on Wayland)
#   the CI deploy + installer need:  git, curl, systemctl
#
# It does NOT clone the repo or install the systemd units — the CI deploy job
# checks out ~/stage in place, and install-user-services.sh owns the units.
# After this script succeeds, the documented bring-up is:
#
#   1. (one-time) register the GitHub self-hosted runner, or `git clone` the
#      repo into ~/stage by hand for an offline appliance.
#   2. ./ops/install-user-services.sh --enable-linger
#
# Idempotent: every install step checks for the target first, so re-running is
# cheap and safe. Honest: every install is followed by a verification that the
# binary actually landed, because "apt said ok" is not the same as "it's there"
# (verify before asserting).
set -euo pipefail

NODE_MAJOR=20
ASSUME_YES=false

usage() {
  cat <<EOF
Usage: $0 [--yes]

Install Stage's runtime system dependencies on a fresh Raspberry Pi OS host:
node ${NODE_MAJOR}.x, npm, mpv, yt-dlp, chromium, git, curl. Idempotent — skips
anything already present and verifies each install.

  --yes   Pass -y to apt and assume non-interactive (use in scripts/CI).

Run as the deploy user (e.g. nick), NOT as root; the script calls sudo only for
the package operations that need it.
EOF
}

case "${1:-}" in
  "") ;;
  --yes|-y) ASSUME_YES=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if [[ "${EUID}" -eq 0 ]]; then
  printf 'Run this as your deploy user, not root; it uses sudo where needed.\n' >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  printf 'This provisioner targets Debian/Raspberry Pi OS (apt-get not found).\n' >&2
  exit 1
fi

APT_YES=()
if [[ "${ASSUME_YES}" == true ]]; then
  APT_YES=(-y)
  export DEBIAN_FRONTEND=noninteractive
fi

log() { printf '\n=== %s ===\n' "$1"; }

# Resolve the user-facing major version of an installed node, or 0 if absent.
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0
}

log "Refreshing apt package lists"
sudo apt-get update "${APT_YES[@]}"

# --- Core tooling the installer + CI deploy depend on -----------------------
log "Installing base tooling (curl, git, ca-certificates, python3-pip)"
sudo apt-get install "${APT_YES[@]}" --no-install-recommends \
  curl git ca-certificates python3-pip

# --- Node ${NODE_MAJOR}.x ---------------------------------------------------
# Raspberry Pi OS (Bookworm) ships node 18 in apt; Stage was built and runs on
# v20. Use NodeSource to guarantee the major, but only if we don't already have
# a node >= NODE_MAJOR (re-runs and hand-installed nvm setups are left alone).
current_node="$(node_major)"
if (( current_node >= NODE_MAJOR )); then
  printf 'node v%s already present (>= %s); leaving it.\n' "${current_node}" "${NODE_MAJOR}"
else
  log "Installing Node ${NODE_MAJOR}.x via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install "${APT_YES[@]}" nodejs
fi

# --- mpv (audio playback, spawned by server.js) -----------------------------
if command -v mpv >/dev/null 2>&1; then
  printf 'mpv already present.\n'
else
  log "Installing mpv"
  sudo apt-get install "${APT_YES[@]}" --no-install-recommends mpv
fi

# --- chromium (TV kiosk) ----------------------------------------------------
# launch-kiosk.sh exec's /usr/bin/chromium specifically. Raspberry Pi OS has
# shipped this binary under both the `chromium` and `chromium-browser` package
# names across releases, so try them in order and verify the BINARY THE KIOSK
# NEEDS rather than trusting a package name.
if [[ -x /usr/bin/chromium ]]; then
  printf '/usr/bin/chromium already present.\n'
else
  log "Installing Chromium"
  installed_chromium=false
  for pkg in chromium chromium-browser; do
    if sudo apt-get install "${APT_YES[@]}" --no-install-recommends "${pkg}" 2>/dev/null; then
      installed_chromium=true
      break
    fi
    printf 'apt package "%s" not installable here; trying next candidate.\n' "${pkg}" >&2
  done
  if [[ "${installed_chromium}" != true ]]; then
    printf 'Could not install a chromium package via apt.\n' >&2
    exit 1
  fi
fi

# --- yt-dlp (YouTube search/extract, spawned by server.js) ------------------
# pip --break-system-packages per the host convention (Bookworm is PEP 668
# externally-managed). yt-dlp moves fast, so a self-updating pip install beats
# the stale apt package.
if command -v yt-dlp >/dev/null 2>&1; then
  printf 'yt-dlp already present; consider "yt-dlp -U" if extraction breaks.\n'
else
  log "Installing yt-dlp via pip (--break-system-packages)"
  sudo pip3 install --break-system-packages --upgrade yt-dlp
fi

# --- Verify everything the runtime actually execs ---------------------------
# apt/pip exit 0 is necessary but not sufficient — confirm each path resolves.
log "Verifying installed runtime"
verify_failed=false
check_bin() {
  local name="$1"
  if command -v "$1" >/dev/null 2>&1; then
    printf '  ok   %-10s %s\n' "$name" "$(command -v "$name")"
  else
    printf '  MISS %-10s not found on PATH\n' "$name" >&2
    verify_failed=true
  fi
}
check_bin node
check_bin npm
check_bin mpv
check_bin yt-dlp
check_bin git
check_bin curl
# The kiosk needs this exact path, not just "some chromium on PATH".
if [[ -x /usr/bin/chromium ]]; then
  printf '  ok   %-10s /usr/bin/chromium\n' chromium
else
  alt="$(command -v chromium-browser 2>/dev/null || true)"
  if [[ -n "${alt}" ]]; then
    printf '  WARN %-10s found %s but launch-kiosk.sh execs /usr/bin/chromium.\n' chromium "${alt}" >&2
    printf '       Symlink it:  sudo ln -s %s /usr/bin/chromium\n' "${alt}" >&2
  else
    printf '  MISS %-10s /usr/bin/chromium not found\n' chromium >&2
  fi
  verify_failed=true
fi

node_after="$(node_major)"
if (( node_after < NODE_MAJOR )); then
  printf '  WARN node is v%s but Stage targets v%s+.\n' "${node_after}" "${NODE_MAJOR}" >&2
  verify_failed=true
fi

if [[ "${verify_failed}" == true ]]; then
  printf '\nProvisioning finished with warnings — resolve the items above before deploying.\n' >&2
  exit 1
fi

cat <<EOF

All runtime dependencies present. Next steps:

  1. Get the code into ~/stage — either register the GitHub self-hosted runner
     (CI deploy checks it out on push to main) or, for an offline appliance:
         git clone https://github.com/imagineering-cc/stage.git ~/stage
  2. Install and start the services:
         ~/stage/ops/install-user-services.sh --enable-linger

Optional private config (facilitation, custom join URL) goes in a systemd
drop-in or ops/network.local.md — see ops/network.local.md.example.
EOF
