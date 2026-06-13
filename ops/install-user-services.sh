#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="/home/nick/stage"
RUN_USER="$(id -un)"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user"
ENABLE_LINGER=false

usage() {
  cat <<EOF
Usage: $0 [--enable-linger]

Install and start the Stage server and kiosk as systemd user services.

  --enable-linger  Run sudo loginctl enable-linger ${RUN_USER} so the
                   services start at boot without an interactive login.
EOF
}

case "${1:-}" in
  "")
    ;;
  --enable-linger)
    ENABLE_LINGER=true
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [[ "${EUID}" -eq 0 || "${RUN_USER}" != "nick" ]]; then
  printf 'Run this installer as nick, not root; the units target %s.\n' "${DEPLOY_DIR}" >&2
  exit 1
fi

if [[ ! -f "${DEPLOY_DIR}/server.js" ]]; then
  printf 'Missing %s/server.js; deploy Stage before installing services.\n' "${DEPLOY_DIR}" >&2
  exit 1
fi

if [[ ! -x "${DEPLOY_DIR}/launch-kiosk.sh" ]]; then
  printf 'Missing executable %s/launch-kiosk.sh; deploy the kiosk launcher first.\n' "${DEPLOY_DIR}" >&2
  exit 1
fi

for dependency in /usr/bin/node /usr/bin/curl /usr/bin/systemctl; do
  if [[ ! -x "${dependency}" ]]; then
    printf 'Required executable not found: %s\n' "${dependency}" >&2
    exit 1
  fi
done

linger_status="$(loginctl show-user "${RUN_USER}" --property=Linger --value 2>/dev/null || true)"
if [[ "${ENABLE_LINGER}" == true && "${linger_status}" != "yes" ]]; then
  printf 'Enabling systemd lingering for %s (sudo may prompt)...\n' "${RUN_USER}"
  sudo loginctl enable-linger "${RUN_USER}"
  linger_status="$(loginctl show-user "${RUN_USER}" --property=Linger --value 2>/dev/null || true)"
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  printf 'The systemd user manager is unavailable. Log in as %s or enable lingering, then retry.\n' "${RUN_USER}" >&2
  exit 1
fi

mkdir -p "${UNIT_DIR}"
backup_suffix="$(date +%Y%m%d-%H%M%S)"
for unit in stage-server.service stage-kiosk.service; do
  source_unit="${SCRIPT_DIR}/${unit}"
  installed_unit="${UNIT_DIR}/${unit}"
  if [[ -f "${installed_unit}" ]] && ! cmp -s "${source_unit}" "${installed_unit}"; then
    backup_unit="${installed_unit}.bak-${backup_suffix}"
    cp -p "${installed_unit}" "${backup_unit}"
    printf 'Backed up existing %s to %s\n' "${unit}" "${backup_unit}"
  fi
  install -m 0644 "${source_unit}" "${installed_unit}"
done

systemctl --user daemon-reload
systemctl --user reenable stage-server.service stage-kiosk.service
systemctl --user restart stage-server.service

server_ready=false
for _ in {1..10}; do
  if /usr/bin/curl -fs --max-time 2 -o /dev/null http://127.0.0.1:3000/room; then
    server_ready=true
    break
  fi
  sleep 1
done

if [[ "${server_ready}" != true ]]; then
  printf 'stage-server did not serve /room after startup. Inspect: journalctl --user -u stage-server.service -n 50\n' >&2
  exit 1
fi

# This does not block installation while a boot-time Wayland session is still starting.
systemctl --user restart --no-block stage-kiosk.service

printf 'Installed and started stage-server.service and stage-kiosk.service.\n'
if [[ "${linger_status}" != "yes" ]]; then
  cat <<EOF
Automatic startup before login still requires lingering. Run:
  sudo loginctl enable-linger ${RUN_USER}
or rerun this installer with --enable-linger.
EOF
else
  printf 'Lingering is enabled; the user services can start during boot.\n'
fi
cat <<EOF
The kiosk waits for /run/user/$(id -u)/wayland-0 and the room endpoint before opening Chromium.
Logs:
  journalctl --user -u stage-server.service -u stage-kiosk.service -f
EOF
