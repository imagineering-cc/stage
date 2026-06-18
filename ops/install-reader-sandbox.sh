#!/usr/bin/env bash
#
# install-reader-sandbox.sh — lay down The Reader's OS-confinement cage (Slice 8).
#
# This is the PREREQUISITE to pointing reader.js at untrusted attendee repos:
# it creates the unprivileged `stage-reader` system user, the root-owned wrapper
# (`/usr/local/sbin/stage-reader-run`), the NOPASSWD sudoers drop-in, the scratch
# dir tree with the right ownership/modes, stage-reader's OWN claude config dir,
# and loads the nftables egress filter.
#
# RUN BY NICK, AS A REGULAR USER. It uses `sudo` for each privileged step; it does
# NOT run the whole thing as root (the deploy paths and ownership are keyed to
# `nick`). It is idempotent: re-running converges state, never duplicates.
#
# Every privileged action is a discrete, visible `sudo` line — read them. The
# matching docs (ops/reader-sandbox.md) lists the exact same commands so you can
# run them by hand instead if you prefer.
#
set -euo pipefail

# ── deploy-relative paths ─────────────────────────────────────────────────────
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="$(id -un)"

SCRATCH_ROOT='/var/lib/stage-reader'
READER_USER='stage-reader'
READER_HOME="${SCRATCH_ROOT}/home"
READER_CONFIG="${SCRATCH_ROOT}/claude-config"
READER_RUNTMP="${SCRATCH_ROOT}/run-tmp"
READER_CLONES="${SCRATCH_ROOT}/clones"

WRAPPER_SRC="${SCRIPT_DIR}/stage-reader-run"
WRAPPER_DST='/usr/local/sbin/stage-reader-run'
SUDOERS_DST='/etc/sudoers.d/stage-reader'
NFT_SRC="${SCRIPT_DIR}/stage-reader-nftables.conf"

say() { printf '\n=== %s ===\n' "$1"; }

if [[ "${EUID}" -eq 0 ]]; then
  printf 'Run this as your normal user (nick), not root; it sudo-escalates per step.\n' >&2
  exit 1
fi

for tool in useradd setfacl install visudo nft realpath; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'Missing required tool: %s. On RPi OS: sudo apt-get install -y acl nftables passwd sudo\n' "$tool" >&2
    exit 1
  }
done

[[ -f "${WRAPPER_SRC}" ]] || { printf 'Missing %s\n' "${WRAPPER_SRC}" >&2; exit 1; }
[[ -f "${NFT_SRC}" ]] || { printf 'Missing %s\n' "${NFT_SRC}" >&2; exit 1; }

# ── 1. the stage-reader system user (no login, no home of its own) ────────────
say "1. system user ${READER_USER}"
if id -u "${READER_USER}" >/dev/null 2>&1; then
  printf 'user %s already exists; leaving as-is\n' "${READER_USER}"
else
  printf 'creating system user %s (no shell, no login)\n' "${READER_USER}"
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin "${READER_USER}"
fi

# ── 2. scratch tree with the right ownership/modes ────────────────────────────
# The scratch ROOT and clones dir: nick OWNS them (reader.js, running as nick,
# clones into clones/). stage-reader needs to READ a clone (and the cage mounts
# it ReadOnly anyway). We use group `stage-reader` + a default ACL so each new
# clone dir nick creates is group-readable by stage-reader WITHOUT nick having to
# chmod each run. clone dirs: nick:stage-reader, 0750 (+ default ACL).
say "2. scratch tree ${SCRATCH_ROOT}"
sudo install -d -o "${RUN_USER}" -g "${READER_USER}" -m 0750 "${SCRATCH_ROOT}"
sudo install -d -o "${RUN_USER}" -g "${READER_USER}" -m 0750 "${READER_CLONES}"
# Default ACL on clones/: every clone dir nick mkdirs inherits g:stage-reader:rx,
# so stage-reader can traverse+read it; nick keeps rwx. (rwx default for nick via
# owner; the model only ever READS, and the cage enforces ReadOnlyPaths too.)
sudo setfacl -d -m u:"${RUN_USER}":rwx -m g:"${READER_USER}":rx -m o::--- "${READER_CLONES}"
sudo setfacl    -m u:"${RUN_USER}":rwx -m g:"${READER_USER}":rx -m o::--- "${READER_CLONES}"

# stage-reader's OWN home + claude-config + run-tmp: OWNED BY stage-reader, 0700
# (nick must NOT be able to read stage-reader's OAuth token, and vice-versa).
say "2b. stage-reader private home/config/run-tmp"
sudo install -d -o "${READER_USER}" -g "${READER_USER}" -m 0700 "${READER_HOME}"
sudo install -d -o "${READER_USER}" -g "${READER_USER}" -m 0700 "${READER_CONFIG}"
sudo install -d -o "${READER_USER}" -g "${READER_USER}" -m 0700 "${READER_RUNTMP}"

# ── 3. the root-owned wrapper (NOT writable by nick) ──────────────────────────
say "3. wrapper ${WRAPPER_DST}"
sudo install -o root -g root -m 0755 "${WRAPPER_SRC}" "${WRAPPER_DST}"
printf 'installed %s (root:root 0755 — nick cannot edit it)\n' "${WRAPPER_DST}"

# ── 4. the NOPASSWD sudoers drop-in (validated with visudo -c) ────────────────
# nick may run ONLY the wrapper as root, NOPASSWD. The wrapper's arg-validation
# is the real gate (see its header). We write to a temp file, validate with
# `visudo -c`, and ONLY install if valid — a malformed sudoers file can lock out
# sudo entirely, so we never install an unchecked one.
say "4. sudoers drop-in ${SUDOERS_DST}"
SUDOERS_TMP="$(mktemp)"
trap 'rm -f "${SUDOERS_TMP}"' EXIT
cat >"${SUDOERS_TMP}" <<EOF
# Installed by ops/install-reader-sandbox.sh — The Reader OS sandbox (Slice 8).
# nick may run ONLY the stage-reader wrapper as root, without a password, so the
# stage-server (running as nick) can drop privilege to stage-reader for a read.
# The wrapper validates its arguments; THAT is the trust boundary, not this glob.
${RUN_USER} ALL=(root) NOPASSWD: ${WRAPPER_DST} *
EOF
sudo install -o root -g root -m 0440 "${SUDOERS_TMP}" "${SUDOERS_DST}"
if ! sudo visudo -cf "${SUDOERS_DST}"; then
  printf 'sudoers drop-in failed validation; REMOVING it to avoid locking sudo\n' >&2
  sudo rm -f "${SUDOERS_DST}"
  exit 1
fi
printf 'installed + visudo-validated %s\n' "${SUDOERS_DST}"

# ── 5. stage-reader's claude OAuth token ──────────────────────────────────────
# stage-reader runs claude on the Max-plan OAuth path with its OWN config dir and
# OWN token, SEPARATE from nick's. We do NOT mint it here (that needs an
# interactive `claude setup-token`). We place a template + lock perms; the doc
# tells you to drop the real token in as stage-reader.
say "5. stage-reader claude token (manual mint — see note)"
READER_TOKEN_FILE="${READER_CONFIG}/.reader-oauth.env"
if sudo test -f "${READER_TOKEN_FILE}"; then
  printf '%s already exists; leaving the token in place\n' "${READER_TOKEN_FILE}"
else
  sudo install -o "${READER_USER}" -g "${READER_USER}" -m 0600 /dev/null "${READER_TOKEN_FILE}"
  printf 'CLAUDE_CODE_OAUTH_TOKEN=\n' | sudo tee "${READER_TOKEN_FILE}" >/dev/null
  sudo chown "${READER_USER}:${READER_USER}" "${READER_TOKEN_FILE}"
  sudo chmod 0600 "${READER_TOKEN_FILE}"
  cat <<EOF
NOTE: minted an EMPTY token file at ${READER_TOKEN_FILE} (owner stage-reader, 0600).
      Mint stage-reader's OWN token and write it there, e.g.:
        sudo -u ${READER_USER} env HOME=${READER_HOME} CLAUDE_CONFIG_DIR=${READER_CONFIG} \\
          ${WRAPPER_DST##*/}-setup   # OR run 'claude setup-token' as stage-reader
      See ops/reader-sandbox.md for the exact token-mint recipe.
EOF
fi

# ── 6. nftables egress filter ─────────────────────────────────────────────────
say "6. nftables egress filter (table inet stage_reader)"
sudo nft -f "${NFT_SRC}"
printf 'loaded; inspect with: sudo nft list table inet stage_reader\n'
# Persistence note (not auto-enabled — depends on your host's nftables setup):
cat <<EOF
To persist across reboot, add this line to /etc/nftables.conf (inside no table):
  include "${NFT_SRC}"
and ensure nftables.service is enabled: sudo systemctl enable nftables
(Skipped here so we never clobber an existing /etc/nftables.conf.)
EOF

# ── 7. final summary ──────────────────────────────────────────────────────────
say "done"
cat <<EOF
The Reader OS sandbox is installed. Before production untrusted-repo reads:
  1. Mint stage-reader's claude OAuth token (step 5 note above).
  2. Set STAGE_READER_SANDBOX=1 in the stage-server systemd drop-in.
  3. Run the on-Pi verification checklist in ops/reader-sandbox.md.
EOF
