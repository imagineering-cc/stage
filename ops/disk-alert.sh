#!/usr/bin/env bash
#
# disk-alert.sh — warn Nick when the Pi's SD card is filling up.
#
# WHY THIS EXISTS
#   The Stage appliance once filled its root filesystem to 100% / 0 bytes free
#   because a now-decommissioned Docker media stack wrote to mountpoints that
#   were never mounted, so the writes landed on the root fs instead of an
#   external disk. A full root fs crash-looped the GitHub Actions runner and
#   blocked CD. The downstream stack is gone, but the FAILURE CLASS — silently
#   running out of disk — remains. This is the cheap early-warning guard.
#
# WHAT IT DOES
#   Reads `df` usage% for the root filesystem (default `/`) and, when usage is
#   at or above a threshold (default 85%), sends a single notification through a
#   pluggable notifier. The default notifier is a Telegram Bot API curl; the
#   transport is whatever the gitignored drop-in configures (see below).
#
# ZERO RUNTIME DEPENDENCIES
#   bash + coreutils (df, awk) + curl only — all present on the Pi. No node,
#   no npm, no extra packages.
#
# CONFIG (env, overridable in a gitignored systemd drop-in or alert.local.env)
#   STAGE_DISK_MOUNT      Mountpoint to check.            Default: /
#   STAGE_DISK_THRESHOLD  Trigger at >= this usage %.     Default: 85
#   STAGE_ALERT_TG_TOKEN  Telegram bot token.             (no default; required for the default notifier)
#   STAGE_ALERT_TG_CHAT   Telegram chat id.               (no default; required for the default notifier)
#   STAGE_ALERT_CMD       Override the notifier entirely. A shell command run with
#                         the alert message on stdin AND as "$1". If set, it
#                         REPLACES the Telegram default (lets you plug ntfy,
#                         signal-cli, a webhook, etc. without editing this file).
#   STAGE_ALERT_ENV_FILE  Path to the secrets drop-in.    Default: <script dir>/alert.local.env
#   STAGE_DF_CMD          TEST HOOK ONLY. Command that emits a df-style table so
#                         tests can inject a fake usage line without a real disk.
#                         Default: df -P -- <mount>
#
# SECRET PLACEMENT — NEVER COMMITTED
#   Copy ops/alert.local.env.example to ops/alert.local.env and fill in the
#   Telegram bot token + chat id. `*.local.env` / alert.local.env are gitignored.
#   Do NOT put the token on the command line or in a tracked unit file.
#
# EXIT CODES
#   0  checked OK (under threshold, OR over-threshold and notify succeeded)
#   0  is also returned when over-threshold; a notifier failure is logged to
#      stderr but does NOT crash the timer (we never want the monitor itself to
#      become the thing that crash-loops). Notifier failures are loud on stderr
#      and land in the journal.
#   1  usage could not be determined (df parse failure) — a real fault worth a
#      non-zero exit so the systemd unit records a failure.
#   2  misconfiguration (bad threshold).

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# --- load the gitignored secrets drop-in if present -------------------------
ALERT_ENV_FILE="${STAGE_ALERT_ENV_FILE:-${SCRIPT_DIR}/alert.local.env}"
if [[ -f "${ALERT_ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "${ALERT_ENV_FILE}"
  set +a
fi

MOUNT="${STAGE_DISK_MOUNT:-/}"
THRESHOLD="${STAGE_DISK_THRESHOLD:-85}"

if ! [[ "${THRESHOLD}" =~ ^[0-9]+$ ]] || (( THRESHOLD < 1 || THRESHOLD > 100 )); then
  printf 'disk-alert: invalid STAGE_DISK_THRESHOLD=%s (want integer 1-100)\n' "${THRESHOLD}" >&2
  exit 2
fi

# --- read disk usage --------------------------------------------------------
# STAGE_DF_CMD is a test seam: tests set it to `cat fixture` or an echo to
# inject a known df table. In production it is the real df call.
df_output="$(eval "${STAGE_DF_CMD:-df -P -- '${MOUNT}'}" 2>/dev/null || true)"

# Parse the usage% from the last data row. `df -P` (POSIX) guarantees one
# logical line per filesystem, so the capacity column is the 5th field of the
# last non-header line. Strip the trailing '%'.
usage="$(printf '%s\n' "${df_output}" | awk 'NR>1 && NF>=5 { pct=$5; sub(/%$/,"",pct); val=pct } END { print val }')"

if ! [[ "${usage}" =~ ^[0-9]+$ ]]; then
  printf 'disk-alert: could not parse usage%% for %s from df output:\n%s\n' "${MOUNT}" "${df_output}" >&2
  exit 1
fi

if (( usage < THRESHOLD )); then
  printf 'disk-alert: %s at %s%% (under %s%% threshold) — OK\n' "${MOUNT}" "${usage}" "${THRESHOLD}"
  exit 0
fi

# --- over threshold: build the message and notify ---------------------------
host="$(hostname 2>/dev/null || echo unknown-host)"
# A fuller df line for context (human-readable sizes), best-effort.
detail="$(df -h -- "${MOUNT}" 2>/dev/null | awk 'NR>1 {print; exit}' || true)"
message="⚠️ Stage Pi disk alert: ${MOUNT} on ${host} is ${usage}% full (threshold ${THRESHOLD}%).
${detail}
A full root fs will crash-loop the CD runner. SSH in and free space."

notify() {
  local msg="$1"

  # Custom notifier override wins — replaces Telegram entirely.
  if [[ -n "${STAGE_ALERT_CMD:-}" ]]; then
    printf '%s' "${msg}" | STAGE_ALERT_MESSAGE="${msg}" sh -c "${STAGE_ALERT_CMD}" _ "${msg}"
    return $?
  fi

  # Default notifier: Telegram Bot API via curl.
  local token="${STAGE_ALERT_TG_TOKEN:-}"
  local chat="${STAGE_ALERT_TG_CHAT:-}"
  if [[ -z "${token}" || -z "${chat}" ]]; then
    printf 'disk-alert: notifier not configured (set STAGE_ALERT_TG_TOKEN + STAGE_ALERT_TG_CHAT in %s, or STAGE_ALERT_CMD)\n' "${ALERT_ENV_FILE}" >&2
    return 3
  fi
  # --data-urlencode keeps the multi-line message + emoji intact; -f makes curl
  # exit non-zero on an HTTP error so we can detect a silent failure.
  curl -fsS --max-time 15 \
    -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=${msg}" \
    --data-urlencode "disable_web_page_preview=true" \
    -o /dev/null
}

if notify "${message}"; then
  printf 'disk-alert: %s at %s%% — notified.\n' "${MOUNT}" "${usage}"
else
  rc=$?
  # Loud on stderr (journal-visible) but do NOT crash the timer: a flaky network
  # or unconfigured notifier must not turn the monitor into a crash-loop.
  printf 'disk-alert: %s at %s%% but NOTIFY FAILED (rc=%s). Disk is still filling — check the Pi.\n' "${MOUNT}" "${usage}" "${rc}" >&2
fi

exit 0
