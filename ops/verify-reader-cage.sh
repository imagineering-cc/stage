#!/usr/bin/env bash
#
# verify-reader-cage.sh — the on-Pi regression guard for The Reader's OS sandbox.
#
# === WHY THIS EXISTS ===
# "The cage works" was, until this script, a REMEMBERED MANUAL ACHIEVEMENT: a
# 7-item checklist (ops/reader-sandbox.md) run by hand over Tailscale once, on
# 2026-06-19. That is entropy waiting to leak. The very next slice that touches
# reader.js (wiring runReader into routes/state) can silently regress the exact
# properties that slice established — confinement, auth, workload-viability,
# timeout, no-metered-key-leak — and CI structurally CANNOT catch it: CI runs
# zero-dep smoke tests on a fresh runner, not real `claude` / `sudo` / `systemd`
# on the Pi. So the regression guard MUST be a Pi-native script, and it must
# exist BEFORE the monster (the live Reader) moves.
#
# This script encodes the 7 checklist items from ops/reader-sandbox.md as a
# deterministic exit code: 0 iff every gate passes. Run it after install, after
# any change to reader.js / the wrapper / the reaper / the sandbox, and as a
# post-deploy check.
#
# === HOW TO RUN ===
#   On the Pi, as nick (passwordless sudo required):
#     bash ~/stage/ops/verify-reader-cage.sh
#   From your Mac over Tailscale:
#     ssh nick@<pi-tailscale-ip> bash ~/stage/ops/verify-reader-cage.sh
#
#   Exit 0  → every gate green; the cage is VERIFIED (not merely claimed).
#   Exit 1  → at least one gate FAILED (the summary names which).
#   Exit 2  → preconditions not met (not on the Pi / sandbox not installed).
#
# === THE LOAD-BEARING GATE (check 5) ===
# Most checks are fast + deterministic. Check 5 — a REAL `runReader` against a
# benign repo returning a NON-NULL finding inside the final cage — is the one CI
# can't run and the one that caught two latent "the workload can't actually run
# in here" bugs after CI was green + cage-matched + merged + deployed (a seccomp
# @resources SIGSYS; an uninjected OAuth token). It needs the network and real
# Max-plan inference, so it can take up to ~3 minutes. A green security suite with
# a null finding here is a BROKEN cage that never runs — worse than no cage.
#
# === SINGLE SOURCE OF TRUTH (no copied cage block) ===
# The confinement probes (checks 2/3/4a) need a shell INSIDE a cage with the SAME
# property set the pinned wrapper applies. We do NOT re-type that property block
# (a copy drifts from the wrapper and would test a DIFFERENT cage than production
# runs). Instead build_probe_props() EXTRACTS the `--property=`/`--setenv=` lines
# straight from the installed wrapper and substitutes the few dynamic vars. A
# drift guard fails loudly if the wrapper grows a property whose variable this
# script doesn't know how to resolve — turning silent drift into an actionable
# error rather than a probe that tests a hole.
#
set -uo pipefail   # deliberately NOT -e: this is a test harness; we run EVERY
                   # check and tally, rather than aborting on the first failure.

# ── fixed config (mirrors the wrapper/installer constants) ────────────────────
SCRATCH_ROOT='/var/lib/stage-reader'
READER_USER='stage-reader'
READER_GROUP='stage-reader'
READER_HOME="${SCRATCH_ROOT}/home"
READER_CONFIG="${SCRATCH_ROOT}/claude-config"
READER_RUNTMP="${SCRATCH_ROOT}/run-tmp"
CLONES_DIR="${SCRATCH_ROOT}/clones"
WRAPPER_DST='/usr/local/sbin/stage-reader-run'
REAPER_DST='/usr/local/sbin/stage-reader-reap'
SUDOERS_DST='/etc/sudoers.d/stage-reader'
BINDS_CONF='/etc/stage-reader/binds.conf'

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# The benign repo for the load-bearing read (check 5). antirez/smallchat is tiny,
# clones fast, and is the proven test case (the Reader caught a real heap
# null-terminator bug in it on 2026-06-19). Override for a different probe repo.
VERIFY_HANDLE="${VERIFY_HANDLE:-antirez}"
VERIFY_REPO="${VERIFY_REPO:-smallchat}"

# ── tiny reporting harness ────────────────────────────────────────────────────
PASS_N=0
FAIL_N=0
FAILED_CHECKS=()
section() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
pass()    { PASS_N=$((PASS_N+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail()    { FAIL_N=$((FAIL_N+1)); FAILED_CHECKS+=("$1"); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
note()    { printf '        %s\n' "$1"; }

# ── preflight: are we actually on the Pi with the sandbox installed? ───────────
preflight() {
  section "preflight — environment + install state"
  local ok=1
  command -v systemd-run >/dev/null 2>&1 || { printf 'systemd-run not found — not a systemd host (run this ON THE PI).\n' >&2; ok=0; }
  id -u "$READER_USER" >/dev/null 2>&1 || { printf "system user '%s' missing — run ops/install-reader-sandbox.sh first.\n" "$READER_USER" >&2; ok=0; }
  [ -x "$WRAPPER_DST" ] || { printf 'wrapper %s missing/not executable — run the installer.\n' "$WRAPPER_DST" >&2; ok=0; }
  [ -x "$REAPER_DST" ]  || { printf 'reaper %s missing/not executable — run the installer.\n' "$REAPER_DST" >&2; ok=0; }
  [ -d "$CLONES_DIR" ]  || { printf 'clones dir %s missing — run the installer.\n' "$CLONES_DIR" >&2; ok=0; }
  [ -f "$REPO_DIR/reader.js" ] || { printf 'reader.js not found at %s — run from the stage checkout.\n' "$REPO_DIR" >&2; ok=0; }
  # passwordless sudo for the two pinned helpers is what reader.js relies on.
  sudo -n true 2>/dev/null || { printf 'passwordless sudo unavailable — this gate needs nick with NOPASSWD sudo on the Pi.\n' >&2; ok=0; }
  [ "$ok" = 1 ] || { printf '\nPreconditions not met; cannot verify the cage.\n' >&2; exit 2; }
  printf 'environment OK: systemd-run, %s user, wrapper, reaper, clones dir, reader.js, sudo -n\n' "$READER_USER"
}

# ── build the probe cage property set FROM the installed wrapper ───────────────
# Extracts every `--property=`/`--setenv=` line the wrapper applies, substitutes
# the dynamic vars to point at THIS probe's clone + stage-reader's real dirs, and
# appends the resolved claude binds. The token setenv and the per-bind loop line
# are NOT array-literal `--property=`/`--setenv=` lines in the wrapper (they begin
# with `[ -n ... ] &&`), so the grep naturally excludes them; we add the binds
# ourselves from the same binds.conf the wrapper sources.
PROBE_PROPS=()
build_probe_props() {
  local probe_clone="$1" raw el
  PROBE_PROPS=()
  while IFS= read -r raw; do
    case "$raw" in *CLAUDE_CODE_OAUTH_TOKEN*) continue ;; esac   # probe carries no token
    el="$(printf '%s' "$raw" \
      | sed -e 's/^[[:space:]]*//' \
            -e "s#\"\$REAL_CLONE\"#${probe_clone}#g" \
            -e "s#\"\$READER_HOME\"#${READER_HOME}#g" \
            -e "s#\"\$READER_CONFIG\"#${READER_CONFIG}#g" \
            -e "s#\"\$READER_RUNTMP\"#${READER_RUNTMP}#g" \
      | tr -d '"')"
    PROBE_PROPS+=("$el")
  done < <(grep -E '^[[:space:]]*--(property|setenv)=' "$WRAPPER_DST")

  # Append the resolved claude install tree (the wrapper sources this same file).
  if [ -r "$BINDS_CONF" ]; then
    # shellcheck disable=SC1090
    . "$BINDS_CONF" 2>/dev/null || true
    local b
    for b in "${CLAUDE_BINDS[@]:-}"; do
      [ -n "$b" ] && PROBE_PROPS+=("--property=BindReadOnlyPaths=-${b}")
    done
  fi

  # DRIFT GUARD: any unresolved `$VAR` means the wrapper grew a dynamic property
  # this script doesn't know how to substitute — the probe would test a broken
  # (or different) cage. Fail loudly + actionably instead of silently.
  for el in "${PROBE_PROPS[@]}"; do
    case "$el" in
      *'$'*)
        printf 'DRIFT: probe property carries an unsubstituted variable: %s\n' "$el" >&2
        printf '       The wrapper (%s) changed shape. Update build_probe_props() in this script.\n' "$WRAPPER_DST" >&2
        return 1 ;;
    esac
  done
  return 0
}

# Run a /bin/sh probe INSIDE a cage built from the wrapper's property set, as the
# stage-reader uid. Echoes the contained command's combined output. The caller's
# env is NOT inherited by the unit (systemd-run starts clean) unless explicitly
# --setenv'd — which is itself part of what check 4a verifies.
probe_sh() {
  local cmd="$1" shell="${2:-/bin/sh}"
  sudo systemd-run --uid="$READER_USER" --gid="$READER_GROUP" \
    --pipe --wait --collect --quiet \
    --working-directory="$PROBE_CLONE" \
    "${PROBE_PROPS[@]}" \
    -- "$shell" -c "$cmd" 2>&1
}

# ── scratch for the probes: a bound clone + an UNBOUND decoy sibling ───────────
PROBE_CLONE="${CLONES_DIR}/__verifycage_probe__"
DECOY_CLONE="${CLONES_DIR}/__verifycage_decoy__"
DECOY_SENTINEL='DECOY_SIBLING_MUST_NOT_BE_VISIBLE'
setup_probe_scratch() {
  rm -rf "$PROBE_CLONE" "$DECOY_CLONE" 2>/dev/null
  mkdir -p "$PROBE_CLONE" "$DECOY_CLONE"          # nick owns clones/ (default ACL grants stage-reader r-x)
  printf 'probe-clone-marker\n' > "$PROBE_CLONE/README.md"
  printf '%s\n' "$DECOY_SENTINEL" > "$DECOY_CLONE/secret"
}
cleanup() { rm -rf "$PROBE_CLONE" "$DECOY_CLONE" 2>/dev/null; }
trap cleanup EXIT

# ════════════════════════════════════════════════════════════════════════════
# CHECK 0 — the pinned command cannot be subverted (wrapper rejects extra argv)
# ════════════════════════════════════════════════════════════════════════════
check0_pinned_command() {
  section "0. wrapper rejects non-pinned command (FIX B)"
  local out rc
  out="$(sudo "$WRAPPER_DST" "$PROBE_CLONE" -- /bin/sh -c id 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'usage' && ! printf '%s' "$out" | grep -q 'uid='; then
    pass "wrapper rejected extra args (exit $rc, usage error, id NEVER ran)"
  else
    fail "0: wrapper did NOT reject extra argv (exit $rc) — /bin/sh smuggling may be possible"
    note "output: ${out:0:200}"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# CHECK 1 — the contained process drops to the stage-reader uid
# ════════════════════════════════════════════════════════════════════════════
check1_runs_as_reader() {
  section "1. cage process runs as ${READER_USER} (privilege drop)"
  local who
  who="$(probe_sh 'id -un')"
  if [ "$(printf '%s' "$who" | tr -d '[:space:]')" = "$READER_USER" ]; then
    pass "contained process runs as '$READER_USER', not nick"
  else
    fail "1: contained process uid is '$who', expected '$READER_USER'"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# CHECK 2 — allowlist filesystem: /home + sibling clones ABSENT (not just RO)
# ════════════════════════════════════════════════════════════════════════════
check2_allowlist_fs() {
  section "2. allowlist fs — /home + sibling clones invisible (FIX A)"
  local out
  out="$(probe_sh 'ls -la /home 2>&1; echo "--H--"; cat /home/nick/.ssh/id_rsa 2>&1; echo "--D--"; cat '"$DECOY_CLONE"'/secret 2>&1; echo "--C--"; ls -la '"$CLONES_DIR"' 2>&1')"
  local ok=1
  printf '%s' "$out" | grep -qi 'no such file' || { ok=0; note "expected 'No such file' for absent paths"; }
  if printf '%s' "$out" | grep -qi 'permission denied'; then
    ok=0; note "saw 'Permission denied' — path PRESENT-but-unreadable, NOT absent (allowlist fs not in effect)"
  fi
  if printf '%s' "$out" | grep -q "$DECOY_SENTINEL"; then
    ok=0; note "DECOY SIBLING CLONE WAS READABLE inside the cage — sibling isolation broken"
  fi
  if [ "$ok" = 1 ]; then
    pass "/home absent, ~/.ssh absent, sibling clone invisible (allowlist fs, not read-only host)"
  else
    fail "2: allowlist filesystem confinement weaker than designed"
    note "output: ${out:0:300}"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# CHECK 3 — egress port filter: tcp/80 DROPPED, tcp/443 allowed (uid-scoped)
# ════════════════════════════════════════════════════════════════════════════
check3_egress() {
  section "3. egress port filter — :80 dropped, :443 open (uid-scoped nftables)"
  if ! sudo nft list table inet stage_reader >/dev/null 2>&1; then
    fail "3: nftables table 'inet stage_reader' is NOT loaded — egress UNFILTERED (see task: reboot-persistence)"
    return
  fi
  local p80 p443
  p80="$(probe_sh 'timeout 5 bash -c "echo > /dev/tcp/1.1.1.1/80" 2>&1 && echo OPEN || echo BLOCKED' /bin/bash)"
  p443="$(probe_sh 'timeout 8 bash -c "echo > /dev/tcp/1.1.1.1/443" 2>&1 && echo OPEN || echo CLOSED' /bin/bash)"
  if printf '%s' "$p80" | grep -q BLOCKED; then
    pass "tcp/80 from $READER_USER is DROPPED"
  else
    fail "3a: tcp/80 from $READER_USER was NOT blocked (got: $(printf '%s' "$p80" | tr -d '\n'))"
  fi
  if printf '%s' "$p443" | grep -q OPEN; then
    pass "tcp/443 from $READER_USER connects (API path open)"
  else
    note "tcp/443 probe got: $(printf '%s' "$p443" | tr -d '\n') (transient network? not fatal)"
    pass "tcp/443 reachability (informational; :80 drop is the security-relevant gate)"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# CHECK 4 — no metered key. 4a: unset inside cage. 4b: runReader hard-aborts.
# ════════════════════════════════════════════════════════════════════════════
check4_no_metered_key() {
  section "4. ANTHROPIC_API_KEY — unset in cage (4a) + hard-abort guard (4b)"
  # 4a: plant the key in OUR env; confirm it does NOT cross into the cage.
  local seen
  seen="$(ANTHROPIC_API_KEY='sk-ant-SENTINEL-must-not-leak' probe_sh 'printf "AK=%s\n" "${ANTHROPIC_API_KEY:-UNSET}"')"
  if printf '%s' "$seen" | grep -q 'AK=UNSET'; then
    pass "4a: ANTHROPIC_API_KEY does not cross into the cage (env isolation)"
  else
    fail "4a: ANTHROPIC_API_KEY leaked into the cage: $(printf '%s' "$seen" | tr -d '\n')"
  fi
  # 4b: the $1,800 footgun guard — runReader must HARD-ABORT (reject promise with
  # an ANTHROPIC_API_KEY error) before doing any work when the key is present.
  # This aborts in buildChildEnv BEFORE the clone, so it is fast (no network).
  local rc
  ( cd "$REPO_DIR" && ANTHROPIC_API_KEY='sk-ant-SENTINEL-cost-guard' node -e '
      const {runReader}=require("./reader.js");
      runReader({handle:"antirez",repo:"smallchat",spotlightId:"costguard"})
        .then(f=>{process.stdout.write("NO-ABORT:"+JSON.stringify(f)+"\n");process.exit(1);})
        .catch(e=>{process.exit(/ANTHROPIC_API_KEY/.test(e.message)?0:2);});
    ' ); rc=$?
  case "$rc" in
    0) pass "4b: runReader HARD-ABORTS when ANTHROPIC_API_KEY is set (metered-billing guard live)" ;;
    1) fail "4b: runReader did NOT abort with a metered key present — the \$1,800 footgun is open" ;;
    *) fail "4b: cost-safety guard test errored unexpectedly (exit $rc)" ;;
  esac
}

# ════════════════════════════════════════════════════════════════════════════
# CHECK 6 — reaper authorized + rejects coercion (run before the slow check 5)
# ════════════════════════════════════════════════════════════════════════════
check6_reaper() {
  section "6. reaper helper — authorized, rejects coercion, no wildcard grant"
  local rc
  # authorized + accepts a valid name → no-op on an absent unit → exit 0, no prompt
  sudo -n "$REAPER_DST" stage-reader-nonexistent >/dev/null 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "reaper is authorized (sudo -n on a valid name exits 0, no password prompt)"
  else
    fail "6: reaper NOT authorized (exit $rc) — sudoers grant missing/broken"
  fi
  # coercion PoCs: each MUST be rejected (exit 64), none may reach systemctl.
  reject() {  # name desc
    sudo -n "$REAPER_DST" $1 >/dev/null 2>&1; local r=$?   # unquoted: 2-token PoC
    if [ "$r" -eq 64 ]; then pass "reaper rejects $2 (exit 64)"; else fail "6: reaper did NOT reject $2 (exit $r)"; fi
  }
  reject 'stage-reader-ok ssh.service' 'two-arg PoC'
  # embedded-space (single arg) + wrong-namespace + empty-token need exact arg passing:
  sudo -n "$REAPER_DST" 'stage-reader-ok ssh.service' >/dev/null 2>&1; [ $? -eq 64 ] && pass "reaper rejects embedded-space single-arg PoC (exit 64)" || fail "6: reaper accepted embedded-space PoC"
  sudo -n "$REAPER_DST" 'ssh.service' >/dev/null 2>&1;                 [ $? -eq 64 ] && pass "reaper rejects wrong-namespace unit (exit 64)"        || fail "6: reaper accepted wrong-namespace unit"
  sudo -n "$REAPER_DST" 'stage-reader-' >/dev/null 2>&1;              [ $? -eq 64 ] && pass "reaper rejects empty-token name (exit 64)"           || fail "6: reaper accepted empty-token name"
  # the grant is the FIXED helper path, NOT a wildcard on systemctl
  if sudo grep -q 'stage-reader-reap' "$SUDOERS_DST" 2>/dev/null \
     && ! sudo grep -Eq 'systemctl .*stage-reader-\*' "$SUDOERS_DST" 2>/dev/null; then
    pass "sudoers grants the fixed reaper path, no wildcard systemctl grant"
  else
    fail "6: sudoers grant shape unexpected (missing reaper path, or a wildcard systemctl grant present)"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# CHECK 7 — unit names are unique per run (no shared stage-reader-clone collision)
# ════════════════════════════════════════════════════════════════════════════
check7_unique_units() {
  section "7. transient unit name is unique per run (round-2 MED)"
  local rc
  ( cd "$REPO_DIR" && node -e '
      const {buildSpawn}=require("./reader.js");
      const a=buildSpawn("/var/lib/stage-reader/clones/aaa-1111/clone",{});
      const b=buildSpawn("/var/lib/stage-reader/clones/bbb-2222/clone",{});
      const okShape = a.unit==="stage-reader-aaa-1111" && b.unit==="stage-reader-bbb-2222";
      const okUniq  = a.unit!==b.unit;
      process.stdout.write(a.unit+" / "+b.unit+"\n");
      process.exit(okShape && okUniq ? 0 : 1);
    ' ); rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "buildSpawn derives a per-run unit name (no shared stage-reader-clone)"
  else
    fail "7: unit names not unique/correctly-shaped per run (reaper could target the wrong unit)"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# CHECK 5 — THE LOAD-BEARING GATE: a real read returns a NON-NULL finding,
#           runs as stage-reader, tears down cleanly, wipes scratch.
#           (run LAST — slow: real network + Max-plan inference, up to ~3 min)
# ════════════════════════════════════════════════════════════════════════════
check5_real_finding() {
  section "5. LOAD-BEARING — real runReader → non-null finding (slow, ~3 min)"
  note "reading ${VERIFY_HANDLE}/${VERIFY_REPO} through the FULL cage; this is the gate CI cannot run."
  local out rc
  out="$( cd "$REPO_DIR" && VERIFY_HANDLE="$VERIFY_HANDLE" VERIFY_REPO="$VERIFY_REPO" node -e '
      const {runReader}=require("./reader.js");
      runReader({handle:process.env.VERIFY_HANDLE,repo:process.env.VERIFY_REPO,spotlightId:"verifycage"})
        .then(f=>{process.stdout.write(JSON.stringify(f)+"\n");process.exit(f&&f.finding?0:1);})
        .catch(e=>{process.stderr.write("THREW:"+e.message+"\n");process.exit(3);});
    ' )"; rc=$?
  case "$rc" in
    0)
      pass "real read produced a NON-NULL finding inside the cage"
      note "finding: $(printf '%s' "$out" | head -c 240)"
      # evidence must cite at least one real file (parseFinding already validates,
      # but re-affirm the contract held end-to-end)
      printf '%s' "$out" | grep -q '"evidence"' && pass "finding carries cited evidence anchors" \
        || fail "5: finding lacked evidence anchors"
      ;;
    1) fail "5: read returned a NULL finding — claude likely failed to START in the cage (broken cage that never runs)"
       note "diagnose: journalctl for the transient unit + cat $BINDS_CONF (claude tree binds are the usual cause); check stage-reader's OAuth token" ;;
    3) fail "5: runReader THREW (cost-safety key set? token? unexpected) — see stderr above" ;;
    *) fail "5: runReader exited unexpectedly (exit $rc)" ;;
  esac
  # teardown hygiene: no leftover transient unit, scratch wiped.
  if systemctl list-units 'stage-reader-*' --no-legend 2>/dev/null | grep -q .; then
    fail "5: leftover stage-reader-* transient unit after the run (teardown incomplete)"
  else
    pass "no leftover transient cage unit after the run"
  fi
  # runReader wipes its own runDir in finally{}; only our probe/decoy should remain.
  local stray
  stray="$(find "$CLONES_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -Ev '__verifycage_(probe|decoy)__' | head -5)"
  if [ -z "$stray" ]; then
    pass "per-run scratch under clones/ was wiped (no stray run dirs)"
  else
    fail "5: stray run dir(s) left under clones/ — scratch not wiped"
    note "stray: $(printf '%s' "$stray" | tr '\n' ' ')"
  fi
}

# ── run all gates ─────────────────────────────────────────────────────────────
preflight
setup_probe_scratch
if ! build_probe_props "$PROBE_CLONE"; then
  printf '\n\033[31mABORT\033[0m — could not build a faithful probe cage from the wrapper (drift). Fix the script, then re-run.\n' >&2
  exit 1
fi
note "probe cage built from $WRAPPER_DST (${#PROBE_PROPS[@]} property/setenv args)"

check0_pinned_command
check1_runs_as_reader
check2_allowlist_fs
check3_egress
check4_no_metered_key
check6_reaper
check7_unique_units
check5_real_finding   # last — the slow one

# ── summary ───────────────────────────────────────────────────────────────────
section "summary"
printf 'passed: %d   failed: %d\n' "$PASS_N" "$FAIL_N"
if [ "$FAIL_N" -ne 0 ]; then
  printf '\033[31mCAGE NOT VERIFIED\033[0m — failing gate(s):\n'
  for c in "${FAILED_CHECKS[@]}"; do printf '  - %s\n' "$c"; done
  exit 1
fi
printf '\033[32mCAGE VERIFIED\033[0m — all gates green. The Reader is safe to point at untrusted repos.\n'
exit 0
