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
#                         TRUST BOUNDARY: this is an operator escape hatch (like
#                         systemd ExecStart=) — the string is run via `sh -c`, so
#                         only ever set it from the trusted, root/owner-only
#                         alert.local.env drop-in or the unit file, NEVER from
#                         any value an untrusted party can influence.
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
#   0  checked OK: under threshold; OR over-threshold and notify succeeded; OR
#      over-threshold but the notifier is merely UNCONFIGURED (expected on a
#      fresh install before the drop-in exists — we don't fail the unit for that,
#      but the journal records the warning).
#   1  a REAL fault that should be VISIBLE as a failed unit:
#        - df usage could not be parsed, OR
#        - over-threshold and the CONFIGURED notifier transport FAILED (bad
#          creds / network / HTTP error). A oneshot exiting non-zero does NOT
#          crash-loop the timer (it reschedules regardless), so this flags the
#          fault via `systemctl --user --failed` without any crash-loop risk.
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
# Production path calls df DIRECTLY with no eval and a quoted "$MOUNT" — there is
# no shell-injection surface on the deployed Pi. STAGE_DF_CMD is a TEST-ONLY
# seam: tests set it to an echo/cat-fixture to inject a known df table. It runs
# through eval (a test needs to express a pipeline) and is gated behind an
# explicit "is it set?" check so the deployed config never reaches eval. The env
# file that could set it (alert.local.env) is already trusted shell that holds
# the bot token, so this is not a new trust boundary — but keep STAGE_DF_CMD out
# of deployed config; it exists for the smoke harness only.
if [[ -n "${STAGE_DF_CMD:-}" ]]; then
  df_output="$(eval "${STAGE_DF_CMD}" 2>/dev/null || true)"
else
  df_output="$(df -P -- "${MOUNT}" 2>/dev/null || true)"
fi

# Parse the usage% from the last data row. `df -P` (POSIX) guarantees one
# logical line per filesystem, so the capacity column is the 5th field of the
# last non-header line. Strip the trailing '%'.
usage="$(printf '%s\n' "${df_output}" | awk 'NR>1 && NF>=5 { pct=$5; sub(/%$/,"",pct); val=pct } END { print val }')"

if ! [[ "${usage}" =~ ^[0-9]+$ ]]; then
  printf 'disk-alert: could not parse usage%% for %s from df output:\n%s\n' "${MOUNT}" "${df_output}" >&2
  exit 1
fi

# Inode exhaustion produces the same ENOSPC / crash-loop symptom as block
# exhaustion, so it is the SAME failure class — check it too. Best-effort and
# real-only: skipped under the STAGE_DF_CMD test seam (tests drive block usage),
# and silently ignored on filesystems that don't report inodes (df prints '-').
iuse=""
if [[ -z "${STAGE_DF_CMD:-}" ]]; then
  iuse="$(df -Pi -- "${MOUNT}" 2>/dev/null \
    | awk 'NR>1 && NF>=5 { pct=$5; sub(/%$/,"",pct); val=pct } END { print val }')"
  [[ "${iuse}" =~ ^[0-9]+$ ]] || iuse=""
fi

trigger=""
if (( usage >= THRESHOLD )); then
  trigger="blocks ${usage}%"
fi
if [[ -n "${iuse}" ]] && (( iuse >= THRESHOLD )); then
  trigger="${trigger:+${trigger}, }inodes ${iuse}%"
fi

if [[ -z "${trigger}" ]]; then
  printf 'disk-alert: %s at %s%% blocks%s (under %s%% threshold) — OK\n' \
    "${MOUNT}" "${usage}" "${iuse:+, ${iuse}% inodes}" "${THRESHOLD}"
  exit 0
fi

# --- over threshold: build the message and notify ---------------------------
host="$(hostname 2>/dev/null || echo unknown-host)"
# A fuller df line for context (human-readable sizes), best-effort.
detail="$(df -h -- "${MOUNT}" 2>/dev/null | awk 'NR>1 {print; exit}' || true)"
message="⚠️ Stage Pi disk alert: ${MOUNT} on ${host} over ${THRESHOLD}% (${trigger}).
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
    # UNCONFIGURED is distinct from a transport failure: return 2 so the caller
    # treats first-install/bootstrap leniently (no systemd failure) while a
    # configured-but-broken transport (below) returns 1 and DOES fail the unit.
    printf 'disk-alert: notifier not configured (set STAGE_ALERT_TG_TOKEN + STAGE_ALERT_TG_CHAT in %s, or STAGE_ALERT_CMD)\n' "${ALERT_ENV_FILE}" >&2
    return 2
  fi
  # SECRET HYGIENE: the bot token must NOT appear in curl's argv (visible in
  # `ps`/`/proc/<pid>/cmdline` to any local user). Pass the secret URL via a
  # curl config file fed on stdin (`-K -`) instead of as a positional arg.
  # --data-urlencode keeps the multi-line message + emoji intact; -f makes curl
  # exit non-zero on an HTTP error so we can detect a silent failure.
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "${token}" \
    | curl -fsS --max-time 15 -K - \
        -X POST \
        --data-urlencode "chat_id=${chat}" \
        --data-urlencode "text=${msg}" \
        --data-urlencode "disable_web_page_preview=true" \
        -o /dev/null
}

# Capture notify's exit code DIRECTLY (not via `if notify; then ... fi; rc=$?`,
# where `$?` after a false `if` with no `else` is the `fi`'s 0, not notify's
# code). `|| notify_rc=$?` keeps `set -e` from aborting on a non-zero return.
notify_rc=0
notify "${message}" || notify_rc=$?

if (( notify_rc == 0 )); then
  printf 'disk-alert: %s over threshold (%s) — notified.\n' "${MOUNT}" "${trigger}"
  exit 0
fi
# Two distinct failure modes, deliberately treated differently (this is the
# silent-failure fix from review):
#   rc == 2  → notifier UNCONFIGURED (no token/chat yet). This is the expected
#             first-install/bootstrap state, so exit 0 — we don't want a fresh
#             Pi to show a failed unit before the operator has dropped in the
#             secret. The journal still records the warning.
#   else     → notifier CONFIGURED but the transport FAILED (bad creds, network,
#             HTTP error). That is a real fault and must be VISIBLE, so exit
#             non-zero: the oneshot is marked `failed` (surfaced by
#             `systemctl --user --failed`) instead of decaying into silent
#             journal noise. NB: a oneshot exiting non-zero does NOT crash-loop
#             a *timer* — the timer reschedules regardless — so we keep the
#             crash-loop-avoidance guarantee while still flagging the fault.
if (( notify_rc == 2 )); then
  printf 'disk-alert: %s over threshold (%s) but notifier UNCONFIGURED — not notified (configure %s).\n' \
    "${MOUNT}" "${trigger}" "${ALERT_ENV_FILE}" >&2
  exit 0
fi

printf 'disk-alert: %s over threshold (%s) but NOTIFY TRANSPORT FAILED (rc=%s). Disk is still filling — check the Pi.\n' \
  "${MOUNT}" "${trigger}" "${notify_rc}" >&2
exit 1
