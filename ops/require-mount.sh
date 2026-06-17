#!/usr/bin/env bash
#
# require-mount.sh — assert that one or more directories are real mountpoints
# before a writer service is allowed to start.
#
# WHY THIS EXISTS
#   The Stage Pi once filled its root filesystem because a writer (a Docker
#   media stack) was pointed at directories that were SUPPOSED to be external
#   mounts but weren't mounted at boot. With nothing mounted there, every write
#   landed on the small root SD card instead of the external disk, filling `/`
#   to 0 bytes and crash-looping CD.
#
#   The fix for that whole class of bug is a precondition: a writer must REFUSE
#   to start unless its target is actually a mountpoint. This script is the
#   reusable, ready-to-wire artifact for that. The downstream stack is gone, so
#   nothing wires it today — it is preventive scaffolding for the next writer.
#
# USAGE
#   require-mount.sh DIR [DIR ...]
#     Exits 0 only if EVERY DIR is a mounted mountpoint. Exits non-zero (and
#     names the offender on stderr) if any DIR is missing or not a mountpoint.
#
# WIRING IT (two complementary patterns — use BOTH where you can)
#   (a) Per-service precondition, no fstab assumptions:
#         [Service]
#         ExecStartPre=/home/nick/stage/ops/require-mount.sh /mnt/media
#       systemd refuses to run ExecStart if ExecStartPre exits non-zero, so the
#       writer never starts against an unmounted target.
#
#   (b) Declarative dependency when the mount IS in fstab / is a .mount unit:
#         [Unit]
#         RequiresMountsFor=/mnt/media
#       This orders the service after the mount AND fails the service if the
#       mount can't be established. Prefer this when the mount is managed by
#       systemd; pair it with (a) as defence in depth (RequiresMountsFor trusts
#       that fstab is correct; require-mount.sh checks the live kernel state).
#
# ZERO RUNTIME DEPENDENCIES — bash + util-linux `mountpoint`, present on the Pi.
#
# EXIT CODES
#   0  all directories are mountpoints
#   1  at least one directory is missing or not a mountpoint
#   2  no directory argument given (misuse)

set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  printf 'require-mount: usage: %s DIR [DIR ...]\n' "${0##*/}" >&2
  exit 2
fi

if ! command -v mountpoint >/dev/null 2>&1; then
  printf 'require-mount: mountpoint command not found (install util-linux)\n' >&2
  exit 1
fi

failed=0
for dir in "$@"; do
  if [[ ! -d "${dir}" ]]; then
    printf 'require-mount: %s does not exist or is not a directory\n' "${dir}" >&2
    failed=1
    continue
  fi
  if ! mountpoint -q -- "${dir}"; then
    printf 'require-mount: %s is NOT a mountpoint — refusing to start (writes would land on root fs)\n' "${dir}" >&2
    failed=1
    continue
  fi
  printf 'require-mount: %s is mounted — OK\n' "${dir}"
done

exit "${failed}"
