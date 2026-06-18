# The Reader OS Sandbox (Slice 8)

> **The cage that must exist before the monster.** This is the OS-level
> confinement that lets `reader.js` (The Reader) point at **untrusted,
> attacker-controllable attendee repositories** in production. The cage is
> **ON BY DEFAULT** (fail-safe); it just needs to be *installed*
> (`ops/install-reader-sandbox.sh`). The only way to the unconfined path is to
> set `STAGE_READER_UNSAFE_DIRECT=1` explicitly (the CI/dev opt-out) — never set
> it in production. See the constraint banner in `reader.js`.

## Threat model

The Reader spawns an **agentic LLM** (`claude`) with READ access over input that
an attacker fully controls: a participant asserts *any* GitHub handle/repo, and
the repo content is whatever that account published — README, source, configs,
all of it. Two distinct threats stack:

1. **Prompt injection → bad finding text.** A hostile README can try to make the
   model *say* something wrong. Mitigated in `reader.js` already: read-only tools
   (`--allowedTools Read,Grep,Glob`), a defensively-parsed output contract, and
   every cited path validated to exist inside the clone. The model can only
   *speak*, never *act*. **This sandbox does not change that layer.**

2. **`claude`-CLI / runtime compromise → host RCE.** The real reason this slice
   exists. `reader.js` restricts the model's *tools*, but in the (opt-out) direct
   mode the `claude` **process still runs as `nick`** with nick's full filesystem
   and network access. A zero-day in the CLI, node, or a transitive dep —
   triggered by reading crafted bytes — would execute **as nick**: read `~/.ssh`,
   `ops/*.local.env` (OAuth tokens, OpenAI/GitHub keys), `stage-state.json`,
   exfiltrate over any port. A zero-click RCE on the host. **This sandbox
   contains threat 2** by running the process as an unprivileged user inside a
   tight systemd cage (allowlist filesystem + seccomp + no caps) backstopped by a
   UID-scoped egress **port** filter.

## The invariant this enforces

> A `claude` process reading an attacker-controllable clone runs as the
> unprivileged **`stage-reader`** system user such that it:
> 1. **CANNOT read anything except its clone dir + its own claude-config/home/
>    run-tmp + the handful of read-only runtime essentials** (the claude/node
>    binaries, shared libs, CA certs, `/etc/resolv.conf`). This is an ALLOWLIST
>    filesystem (`TemporaryFileSystem=/:ro` + `BindReadOnlyPaths=` the essentials
>    + `BindPaths=` the writable trio), NOT merely a read-only host — `/home/nick`,
>    sibling clones, and the rest of `/etc`/`/var` are *absent* inside the cage,
>    not just unwritable. (cage-match FIX A: `ProtectSystem=strict` alone would
>    leave world-readable `/etc`/`/usr` and sibling clones *readable*.)
> 2. **CANNOT** gain privileges (`NoNewPrivileges=yes` + empty capability set + a
>    seccomp syscall filter + `SystemCallArchitectures=native`);
> 3. has network egress restricted to **tcp/443 + DNS only** — a UID-scoped
>    **port** filter, NOT an Anthropic-only allowlist. 443-to-anywhere and DNS are
>    open; the claim is "no plaintext/arbitrary-port exfil", not "can only reach
>    api.anthropic.com" (see the honest caveat under Egress filter below). It has
>    no Bash/WebFetch tool anyway — this is defense-in-depth against a claude-CLI
>    compromise;
> 4. the stage-server (running as `nick`) keeps doing **all** git/clone/network;
>    `claude` does neither. The raw repo bytes reach **only** the contained
>    reader.
>
> The COMMAND is **pinned** in the root wrapper (cage-match FIX B): nick's grant
> is "run THE reader operation", not "run anything as stage-reader". The wrapper
> hardcodes the `claude` binary + read-only flags and accepts ONLY a clone dir;
> the trusted prompt arrives on **stdin**, never as argv that could smuggle a flag.

## The mechanism

The stage-server runs under nick's **user** systemd and cannot spawn a process
as another uid with confinement without privilege. So:

```
reader.js (as nick)
  │  git clone  (as nick — all network is nick's)
  │  spawn: sudo -n /usr/local/sbin/stage-reader-run <cloneDir>   (prompt on stdin)
  ▼
sudo (NOPASSWD, two pinned helper paths: stage-reader-run + stage-reader-reap)
  ▼
/usr/local/sbin/stage-reader-run   (root-owned 0755, NOT writable by nick)
  │  validates cloneDir is under /var/lib/stage-reader/clones (realpath, no ../symlink)
  │  PINS: claude -p --input-format text --output-format json
  │        --allowedTools Read,Grep,Glob
  │        --disallowedTools Write,Edit,Bash,WebFetch,WebSearch --permission-mode dontAsk
  │  exec systemd-run --uid=stage-reader --gid=stage-reader --wait --pipe --collect
  │                   --working-directory=<cloneDir>  <allowlist-fs + confinement set>
  ▼
transient systemd unit "stage-reader-<clone>"   ← THE CAGE
  └── claude  (as stage-reader; allowlist fs; no caps; seccomp; egress 443+53 only)
       └── reads the trusted hunt prompt from STDIN (piped through sudo→systemd-run)
```

### Why a root wrapper + NOPASSWD sudoers, and why the COMMAND is pinned

- A **user-systemd** service can't change uid or drop into another user's
  cgroup — those need root. The stage-server is nick's user process.
- `systemd-run` **as root** can `--uid=stage-reader` *and* apply the full
  `systemd.exec` confinement property set in one shot. That's the cleanest cage
  primitive already on the Pi (no firejail/bubblewrap dependency).
- The sudoers glob is `nick ALL=(root) NOPASSWD: /usr/local/sbin/stage-reader-run *`.
  The `*` is broad — sudoers globbing **cannot** express "a path under
  `/var/lib/stage-reader/clones` with no `..`/symlink escape". **cage-match FIX
  B:** the earlier wrapper passed *arbitrary argv after `--`* verbatim to
  systemd-run, so any code running as nick could
  `sudo stage-reader-run <validclone> -- /bin/sh -c '...'` and run **anything** as
  stage-reader inside the cage — reading stage-reader's OAuth token and
  exfiltrating over the allowed 443. Caging the *where* (cwd) without caging the
  *what* was the hole. Now the wrapper **hardcodes** the command + flags and
  accepts **exactly one** argument (the clone dir); the trusted prompt arrives on
  **stdin**, never as argv. So the grant is genuinely "run THE reader operation",
  and the trust boundary is the wrapper's *clone-dir validation* (defence in depth
  on top of the pinned command). The wrapper is root-owned and not writable by
  nick, so nick cannot weaken the gate he is trusted to invoke.

### Filesystem ownership + the TOCTOU window (cage-match FIX D)

- `/var/lib/stage-reader` and `/var/lib/stage-reader/clones`: owned
  **`nick:stage-reader`, mode 0750**, with a **default ACL**
  `g:stage-reader:r-x` on `clones/` so every per-run clone dir nick creates is
  automatically group-traversable/readable by stage-reader — no per-run `chmod`.
  nick writes (clones into) it; stage-reader only reads; the cage additionally
  bind-mounts the clone **read-only**, so even the contained process can't write
  it.
- `/var/lib/stage-reader/{home,claude-config,run-tmp}`: owned
  **`stage-reader:stage-reader`, mode 0700** — stage-reader's private HOME, its
  OWN claude config + OAuth token (mode 0600, **separate** from nick's), and a
  writable scratch (`TMPDIR`). nick cannot read stage-reader's token; the cage's
  writable bind set is exactly these three and nothing else.
- **The wrapper validates the clone dir is under `/var/lib/stage-reader/clones`
  specifically** (narrowed from the whole scratch root — FIX D), so a validated
  path can never resolve to a reserved control dir, and the race surface is the
  single `clones/` tree.
- **Residual TOCTOU window (named, not fully closed):** the wrapper
  `realpath`-validates the clone dir, then `systemd-run` resolves
  `--working-directory`/the bind mount a moment later. A writer with access to
  `clones/` could in principle rename/replace the dir in that window. It is
  *narrowed* (only nick and stage-reader can write under `clones/` — mode 0750,
  and nick is the only non-cage writer), but not eliminated by this slice. The
  clone is created by nick (reader.js) immediately before the call and wiped
  immediately after, so the window is sub-second and the only actor who could
  race it is nick himself (or a compromise already running as nick — which the
  cage is downstream of). A full close would require passing an O_PATH fd through
  to systemd-run, which `systemd-run` does not currently expose. Documented here
  rather than silently absorbed.

### The allowlist filesystem + confinement property set (the cage)

Applied by the wrapper via `systemd-run --property=`. The **filesystem** is an
ALLOWLIST (cage-match FIX A), not a read-only host:

| Property | Effect |
|---|---|
| `TemporaryFileSystem=/:ro` | a fresh **empty** read-only root — the entire host filesystem is GONE inside the cage; only what we bind back exists |
| `BindReadOnlyPaths=<cloneDir>` | the repo bytes, read-only. The clone's **parent** (`clones/`) is NOT bound, so **sibling runs are absent by construction** |
| `BindReadOnlyPaths=/usr/bin /bin /usr/lib /lib …, certs, /etc/resolv.conf` | the read-only runtime essentials claude/node need to start + resolve DNS (node is `/usr/bin/node`, under `/usr/bin`) |
| `BindReadOnlyPaths=<resolved claude tree>` | the REAL claude install (round-2 HIGH 2 — see below): the shim path, the `readlink -f` target, its install dir, and `~/.local/share/claude` (the `versions/<ver>/` tree). **Not** just the shim file. |
| `BindPaths=<home> <config> <run-tmp>` | the ONLY writable paths (stage-reader's own dirs) |
| `PrivateTmp=yes`, `PrivateDevices=yes` | private `/tmp`; a minimal `/dev` |

> **round-2 HIGH 2 — bind the REAL claude tree, not the shim.** A native claude
> install is a **shim**: `~/.local/bin/claude` is a *symlink* into
> `~/.local/share/claude/versions/<ver>/…`. With `TemporaryFileSystem=/:ro`,
> binding only the shim file leaves the version tree unmounted, so `claude` execs
> the shim and **fails to load** — and the reader would silently return null
> findings forever (a broken cage that never runs is worse than no cage). So
> `install-reader-sandbox.sh` resolves `readlink -f "$(command -v claude)"`,
> computes the install root, and writes the bind set to a **root-owned**
> `/etc/stage-reader/binds.conf` (`CLAUDE_BIN=…` + `CLAUDE_BINDS=(…)`). The
> wrapper *sources* that file and binds each entry read-only. (The wrapper also
> has a self-resolving fallback if the config is absent.) **The on-Pi checklist's
> "real read → non-null finding" step is the gate that proves claude actually
> starts inside the cage** — do not trust the cage until it passes.

So `/home/nick`, `ops/*.local.env`, `stage-state.json`, other users' files, and
sibling clones are **not mounted** — they don't exist in the cage, not merely
"read-only". (The previous `ProtectSystem=strict` + `ReadOnlyPaths=<clone>` left
world-readable `/etc`/`/usr` and sibling clones *readable* — that was the FIX A
gap.) Layered on top, the standard `systemd.exec(5)` hardening:

| Property | Effect |
|---|---|
| `NoNewPrivileges=yes` | no setuid/fscaps privilege escalation, ever |
| `SystemCallFilter=@system-service` + `~@privileged @mount @debug @reboot @swap @obsolete @resources` | seccomp allowlist of ordinary service syscalls, minus the dangerous classes |
| `SystemCallArchitectures=native` | block non-native syscall ABIs (defeats a 32-bit-ABI bypass) |
| `CapabilityBoundingSet=` / `AmbientCapabilities=` (empty) | no capabilities at all |
| `ProtectProc=invisible` + `ProcSubset=pid` | can't see other processes in `/proc` |
| `ProtectKernelTunables/Modules/Logs=yes`, `ProtectClock=yes`, `ProtectControlGroups=yes`, `ProtectHostname=yes` | kernel/host state read-only or hidden |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` | only IP + unix sockets (no raw/packet/netlink) |
| `RestrictNamespaces=yes`, `RestrictRealtime=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `RemoveIPC=yes` | shut common escape/privilege primitives |
| `UMask=0077` | anything it does write is private |

> Note: with `TemporaryFileSystem=/:ro` we do NOT also set `ProtectSystem`/
> `ProtectHome`/`ReadOnlyPaths` — the empty tmpfs root already masks everything;
> those directives would be redundant or conflict with the explicit binds.

**`MemoryDenyWriteExecute` is DELIBERATELY OMITTED.** node (and therefore
`claude`) JITs — W^X memory would `SIGSEGV` the runtime and break every run. The
seccomp filter + capability drop + allowlist-fs confinement carry the
containment without it. (Stated as a named, accepted tradeoff: a JIT-based RCE
that lives entirely in already-mapped RWX pages is not blocked by the seccomp
classes we drop, but it still cannot escalate privilege, read `/home/nick`, or
egress over any port but 443/53.)

### Egress filter (`ops/stage-reader-nftables.conf`) — what it IS and ISN'T

An additive nftables table `inet stage_reader` that matches **by UID**
(`meta skuid stage-reader`) and allows only `tcp/443` + `udp,tcp/53` +
established/related + loopback, dropping (rate-limited-logged) everything else.
Because it's scoped to the stage-reader UID, the **stage-server's own** clone
traffic (git/HTTPS), yt-dlp, OpenAlex, and Tailscale — all running as `nick` —
are **completely unaffected**.

> **Honest scope (cage-match):** this is a **port** filter, **not** an
> Anthropic-only exfiltration boundary. `tcp/443`-to-**anywhere** and DNS are
> open, so a compromised claude that could open a socket (it has no Bash/WebFetch
> tool, so it can't easily) could still reach an arbitrary HTTPS host or tunnel
> over DNS. The claim it backs is narrow and true: **"no plaintext/arbitrary-port
> egress from the stage-reader UID"** — defence-in-depth against a CLI compromise,
> not a guarantee that bytes can only reach `api.anthropic.com`. Pinning egress to
> Anthropic's IPs would need an ipset/SNI filter and is out of scope for this
> slice (named, not silently absorbed).

### Kill-path propagation (timeout → contained child) — FIX C

`reader.js`'s wall-clock guard does `child.kill('SIGTERM')` then `SIGKILL`. In
sandbox mode `child` is `sudo -n`, not `claude`. The primary chain:

```
Node child.kill('SIGTERM')
  → sudo forwards SIGTERM to its child            (sudo ≥ 1.8.15)
  → the wrapper has exec'd into `systemd-run --wait`, which on SIGTERM STOPS the
    transient unit
  → systemd sends SIGTERM to claude in the unit's cgroup, then SIGKILL after the
    unit's TimeoutStopSec=5 (KillMode=mixed) — a hard, cgroup-scoped kill of the
    whole contained tree
```

**cage-match FIX C — don't depend on the signal chain alone.** If sudo
signal-forwarding or `systemd-run --wait` behaves differently on the Pi, the
contained claude could survive the Node timeout. So in sandbox mode reader.js
ALSO fires a **best-effort** teardown of the deterministic transient unit — a
direct, cgroup-scoped kill that does not rely on the signal reaching the
workload. It's best-effort (errors swallowed: the unit may already be gone, or
the dev box may lack the privilege) and the unit name is deterministic
(`stage-reader-<run-token>`). Node's `SIGKILL` to `sudo` is the last-resort
reaper of the sudo/systemd-run layer; a stray transient unit is `--collect`-cleaned
regardless.

> **round-3 HIGH — the reaper is a validating helper, not a wildcard grant.** The
> round-2 draft authorized the reaper with a WILDCARD sudoers grant on the general
> `systemctl` tool — `nick ALL=(root) NOPASSWD: <systemctl> stop stage-reader-*,
> <systemctl> kill stage-reader-*`. Wildcard grants on a general tool are a
> footgun (sudo's `*` spans spaces and arg boundaries; reasoning about what it
> admits is fragile). That grant is **gone**. reader.js now calls a single-purpose
> root-owned helper instead: `sudo -n /usr/local/sbin/stage-reader-reap <unit>`.
> The helper (`ops/stage-reader-reap`, root:root 0755) accepts EXACTLY one
> argument, validates it against `^stage-reader-[A-Za-z0-9:_.-]+$` (the wrapper's
> own unit charset, non-empty token), then runs `systemctl stop|kill` on that one
> unit itself. The sudoers grant is now just `nick ALL=(root) NOPASSWD:
> /usr/local/sbin/stage-reader-reap *` — a BOUNDED program by fixed path. Even if
> the `*` admits odd argv, the worst the helper does is reject it; it has no path
> to any other unit. (The `stage-reader-*` namespace is the reader-created proof:
> the only units in it are this project's transient cage units, and creating a
> system unit with that name already needs root.) The reaper still genuinely
> tears the cage unit down on timeout.
>
> **Unique unit name (round-2 MED):** the unit is
> `stage-reader-<run-token>` where `<run-token>` is the per-run
> `<spotlightId|random>-<hex>` (derived from the **run dir**, the parent of
> `clone`). The earlier `basename(clone)` was always `"clone"` → every run
> collided on `stage-reader-clone`, so the reaper could target the wrong run's
> unit and stale units piled up. reader.js (`basename(dirname(cloneDir))`) and the
> wrapper (`basename "$(dirname REAL_CLONE)"`, sanitised to the unit charset)
> compute the **same** name, verified byte-for-byte by a unit test.
>
> **round-4 review (Carnot) — three hardenings on the round-3 fix:**
> - **binds.conf integrity guard.** The wrapper sources `/etc/stage-reader/binds.conf`
>   AS ROOT, which makes it root *code* behind the NOPASSWD grant. The wrapper now
>   VERIFIES it before sourcing (`binds_conf_trusted`): not a symlink, a regular
>   file, owned by uid 0, not group/other-writable, and its parent dir likewise.
>   Any failure (incl. a `stat` that can't read it) is **fail-closed** — the file
>   is ignored and the self-contained fallback resolution runs (sourcing nothing).
> - **Nearest-parent versions dir.** Both the installer and the wrapper fallback now
>   pick the versions dir by walking UP from the resolved binary to the ancestor
>   whose parent is named `versions`, NOT the first `/versions/` substring (which
>   `${x%%/versions/*}` would mis-pick for a path containing `versions` twice,
>   binding an over-broad subtree). `claude_version_dir` is identical in both files.
> - **Hard kill + reserved namespace.** `stage-reader-reap` passes
>   `--signal=SIGKILL` to `systemctl kill` (its default is SIGTERM) so the
>   last-resort teardown is genuinely hard. And `stage-reader-*` is a **reserved**
>   systemd unit namespace — never create non-reader system units with that prefix.

---

## Install — the EXACT ordered sudo commands

The installer `ops/install-reader-sandbox.sh` does all of this idempotently and
shows every privileged step. **Run it as `nick` (not root); it sudo-escalates
per step:**

```bash
cd ~/stage
./ops/install-reader-sandbox.sh
```

If you prefer to run each privileged step by hand instead, these are the exact
commands the installer issues (in order):

```bash
# 0. prerequisites (RPi OS Bookworm)
sudo apt-get update && sudo apt-get install -y acl nftables

# 1. the unprivileged system user (no login, no home)
sudo useradd --system --no-create-home --shell /usr/sbin/nologin stage-reader

# 2. scratch tree: nick owns, stage-reader group can read; default ACL on clones/
sudo install -d -o nick -g stage-reader -m 0750 /var/lib/stage-reader
sudo install -d -o nick -g stage-reader -m 0750 /var/lib/stage-reader/clones
sudo setfacl -d -m u:nick:rwx -m g:stage-reader:rx -m o::--- /var/lib/stage-reader/clones
sudo setfacl    -m u:nick:rwx -m g:stage-reader:rx -m o::--- /var/lib/stage-reader/clones

# 2b. stage-reader's PRIVATE home / config / run-tmp (nick cannot read these)
sudo install -d -o stage-reader -g stage-reader -m 0700 /var/lib/stage-reader/home
sudo install -d -o stage-reader -g stage-reader -m 0700 /var/lib/stage-reader/claude-config
sudo install -d -o stage-reader -g stage-reader -m 0700 /var/lib/stage-reader/run-tmp

# 3. resolve the REAL claude tree → /etc/stage-reader/binds.conf (round-2 HIGH 2)
#    claude is a SHIM (~/.local/bin/claude → ~/.local/share/claude/versions/<ver>/);
#    bind the resolved tree, not just the shim, or claude won't load in the cage.
#    round-3 MED: bind ONLY the versions/<ver>/ subtree, NOT the whole
#    ~/.local/share/claude tree (the caged claude can Read/Grep whatever is bound).
#    round-4 (Carnot): use the NEAREST-parent versions dir (walk up from the
#    binary to the ancestor whose parent is named "versions"), NOT the first
#    /versions/ occurrence — a path with `versions` twice would bind too broadly.
LINK="$(command -v claude)"; REAL="$(readlink -f "$LINK")"
VER="$(d="$(dirname "$REAL")"; while [ "$d" != / ] && [ -n "$d" ] && [ "$(basename "$(dirname "$d")")" != versions ]; do d="$(dirname "$d")"; done; { [ "$d" = / ] || [ -z "$d" ]; } && dirname "$REAL" || printf '%s' "$d")"
sudo install -d -o root -g root -m 0755 /etc/stage-reader
printf 'CLAUDE_BIN=%q\nCLAUDE_BINDS=( %q %q %q %q )\n' \
  "$LINK" "$LINK" "$REAL" "$(dirname "$REAL")" "$VER" \
  | sudo tee /etc/stage-reader/binds.conf >/dev/null
sudo chmod 0644 /etc/stage-reader/binds.conf

# 3b. the root-owned wrapper (NOT writable by nick)
sudo install -o root -g root -m 0755 ~/stage/ops/stage-reader-run /usr/local/sbin/stage-reader-run

# 3c. the root-owned kill-path reaper helper (round-3 HIGH; NOT writable by nick)
sudo install -o root -g root -m 0755 ~/stage/ops/stage-reader-reap /usr/local/sbin/stage-reader-reap

# 4. the NOPASSWD sudoers drop-in — VALIDATE BEFORE INSTALL (FIX E). TWO grants,
#    each a PINNED helper path (round-3 HIGH): the wrapper, AND the validating
#    kill-path reaper. No wildcard on a general tool — the reaper helper validates
#    its own unit-name argument and runs `systemctl stop|kill` internally.
TMP="$(mktemp)"; sudo chown root:root "$TMP"; sudo chmod 0440 "$TMP"
{ printf 'nick ALL=(root) NOPASSWD: /usr/local/sbin/stage-reader-run *\n'
  printf 'nick ALL=(root) NOPASSWD: /usr/local/sbin/stage-reader-reap *\n'
} | sudo tee "$TMP" >/dev/null
sudo visudo -cf "$TMP"                            # MUST print "parsed OK" — abort if not
sudo install -o root -g root -m 0440 "$TMP" /etc/sudoers.d/stage-reader
sudo visudo -c                                    # re-validate the whole tree
rm -f "$TMP"

# 5. mint stage-reader's OWN claude OAuth token (Max-plan path, SEPARATE from nick's)
#    Run claude setup-token AS stage-reader, writing to its own config dir:
sudo -u stage-reader env HOME=/var/lib/stage-reader/home \
  CLAUDE_CONFIG_DIR=/var/lib/stage-reader/claude-config \
  ~/.local/bin/claude setup-token
#    (Follow the prompt; the token is stored under the stage-reader config dir.
#     Confirm it is 0600 and owned by stage-reader.)

# 6. load the egress filter
sudo nft -f ~/stage/ops/stage-reader-nftables.conf
sudo nft list table inet stage_reader            # eyeball the rules

# 6b. (optional) persist nftables across reboot — only if you manage /etc/nftables.conf:
#   add  include "/home/nick/stage/ops/stage-reader-nftables.conf"  to /etc/nftables.conf
#   sudo systemctl enable nftables

# 7. restart the stage-server. The cage is ON BY DEFAULT (fail-safe, FIX F) —
#    there is NO env var to set for production. Just restart so the next read
#    uses the freshly-installed cage:
systemctl --user restart stage-server.service
#    (Do NOT set STAGE_READER_UNSAFE_DIRECT=1 in production — that is the CI/dev
#    opt-OUT to the unconfined direct spawn.)
```

> The token in step 5: **do NOT** set `ANTHROPIC_API_KEY` anywhere the
> stage-server or stage-reader can see it. `reader.js` hard-aborts the run if it
> detects one (the ~$1,800 metered-billing footgun) — that guard is
> mode-independent and survives in sandbox mode.

## On-Pi verification checklist (the REAL gate — CI cannot do any of this)

Run after install, pointing at a **benign** trusted repo first. Until every box
is checked on the Pi, the OS confinement is **claimed, not verified**.

> **The wrapper is PINNED (FIX B): it runs ONLY `claude` and accepts ONLY a clone
> dir — it can no longer run `/bin/sh` for an ad-hoc probe.** So the confinement
> checks below use an **ad-hoc throwaway `systemd-run`** (run by Nick as root)
> carrying the SAME cage knobs as the wrapper, to probe what the cage allows.
> Copy the cage's property block from `ops/stage-reader-run` into a
> `PROBE=(systemd-run --uid=stage-reader --gid=stage-reader --pipe --wait --collect --quiet <…the same --property/--setenv lines… > /dev/null` `)` helper, then run:

0. **The pinned command cannot be subverted.** Confirm the wrapper rejects any
   attempt to run something other than the pinned `claude`:
   ```bash
   sudo /usr/local/sbin/stage-reader-run /var/lib/stage-reader/clones/X -- /bin/sh -c id
   # EXPECT: non-zero exit, "usage: stage-reader-run <cloneDir> (prompt on stdin; NO other args)"
   #         — the extra args are rejected; /bin/sh is NEVER run.
   ```
1. **Process runs as `stage-reader`.** Kick a real read, and while it runs:
   ```bash
   ps -o user,pid,cmd -C claude        # USER column must be 'stage-reader', NOT 'nick'
   systemctl list-units 'stage-reader-*'   # the transient cage unit is present
   ```
2. **Cannot read `/home/nick` (allowlist fs).** With the ad-hoc `$PROBE` helper:
   ```bash
   "${PROBE[@]}" -- /bin/sh -c 'cat /home/nick/.ssh/id_* 2>&1; ls -la /home 2>&1; cat /home/nick/stage/ops/reader.local.env 2>&1'
   # EXPECT: "No such file or directory" — /home is NOT mounted in the cage
   # (TemporaryFileSystem=/:ro + selective binds → /home/nick does not exist).
   ```
   Also confirm a SIBLING clone is invisible (FIX A):
   ```bash
   "${PROBE[@]}" -- /bin/sh -c 'ls -la /var/lib/stage-reader/clones 2>&1'
   # EXPECT: "No such file or directory" — clones/ is not bound; only THIS run's
   # clone (bound at its own path) exists.
   ```
3. **Egress to a non-443 port is dropped.**
   ```bash
   "${PROBE[@]}" -- /bin/sh -c 'timeout 5 bash -c "echo > /dev/tcp/1.1.1.1/80" 2>&1 && echo OPEN || echo BLOCKED'
   # EXPECT: BLOCKED (port 80 not allowed). Then repeat with /443 → should connect.
   sudo nft list table inet stage_reader    # the drop counter / log confirms it
   ```
4. **`ANTHROPIC_API_KEY` stays unset** for the contained process:
   ```bash
   "${PROBE[@]}" -- /bin/sh -c 'echo "${ANTHROPIC_API_KEY:-UNSET}"'
   # EXPECT: UNSET
   ```
5. **A real read produces a genuine NON-NULL finding** against a trusted repo —
   THE load-bearing gate (round-2 HIGH 2). If claude can't start inside the cage
   (wrong/incomplete claude binds), the reader silently returns `{finding:null}`
   forever — a broken cage that never runs. So this MUST yield a real finding that
   cites real files, not null. Confirm also:
   - the contained process is `stage-reader` (item 1);
   - no zombie `claude` / no leftover `stage-reader-*` unit afterwards
     (`systemctl list-units 'stage-reader-*'` is empty);
   - the per-run scratch dir under `/var/lib/stage-reader/clones/` is **wiped**.
   If it returns null: check `journalctl` for the transient unit and
   `cat /etc/stage-reader/binds.conf` — the claude install tree is the usual cause.
6. **Timeout path + reaper authorization (round-3 HIGH — the validating helper).**
   Set `STAGE_READER_TIMEOUT_MS=2000`, point at a larger repo, confirm the run is
   killed and the cage unit torn down within a few seconds. Then confirm the reaper
   HELPER is authorized (not a swallowed no-op) AND that it rejects coercion:
   ```bash
   # authorized + accepts a valid name (no-op on an absent unit → exit 0):
   sudo -n /usr/local/sbin/stage-reader-reap stage-reader-nonexistent
   #   EXPECT: no password prompt, exits 0. "a password is required"/"not allowed"
   #   means the grant is missing.
   # rejects the coercion PoCs (each MUST print "stage-reader-reap: refusing/usage…"
   # and exit 64 — the helper, NOT systemctl, is the gate):
   sudo -n /usr/local/sbin/stage-reader-reap stage-reader-ok ssh.service   # 2 args
   sudo -n /usr/local/sbin/stage-reader-reap 'stage-reader-ok ssh.service' # embedded space
   sudo -n /usr/local/sbin/stage-reader-reap ssh.service                   # wrong namespace
   # and the grant is the FIXED helper path, NOT a wildcard on systemctl:
   sudo grep -n 'stage-reader-reap' /etc/sudoers.d/stage-reader
   ! sudo grep -q 'systemctl .* stage-reader-\*' /etc/sudoers.d/stage-reader && echo "no wildcard systemctl grant (good)"
   ```
7. **Unit names are unique per run (round-2 MED).** Kick two reads (or inspect a
   prior run's journal) and confirm the transient units differ —
   `stage-reader-<spotlightId|rand>-<hex>`, NOT a shared `stage-reader-clone`.

## What is verified now vs. unverified-until-Pi

**Verified now (in CI / on this branch — 43 `reader.test.js` tests + 36 smoke):**
- Direct-mode (opt-out) behaviour is unchanged.
- **Fail-safe polarity (FIX F):** `buildSpawn` with NO env selects the cage
  (`command === 'sudo'`), not direct.
- **Unique unit name (round-2 MED):** `buildSpawn` derives the unit from the run
  dir (`stage-reader-<run-token>`), distinct per run, and a unit test asserts it
  byte-matches the wrapper's shell derivation (`basename(dirname(clone))`,
  sanitised). The wrapper builds its systemd-run argv as an array so the resolved
  claude binds append cleanly (`bash -n` clean).
- **Pinned command (FIX B):** in sandbox mode `buildSpawn` produces EXACTLY
  `['-n', <wrapper>, <cloneDir>]` — no `--`, no `claude`, no tool flags after the
  clone dir — and the prompt rides `stdinPrompt` (a unit test asserts the exact
  3-element argv and the stdin path). A FAKE-`sudo` end-to-end asserts the prompt
  arrives on stdin and the finding parses.
- **Wrapper rejects subversion (FIX B/D):** shell-level tests drive the real
  `ops/stage-reader-run` and confirm it rejects >1 arg (no `/bin/sh` smuggling),
  rejects 0 args, rejects a relative path, and rejects a path outside `clones/`.
  (On the macOS CI-author box the out-of-`clones/` rejection fires one line early
  via BSD `realpath` lacking `-e`; the GNU `realpath -e` containment message is a
  Pi-only check — see below.)
- **Reaper helper rejects subversion (round-3 HIGH):** shell-level tests drive the
  real `ops/stage-reader-reap` and confirm it accepts a valid `stage-reader-<token>`
  name (full `:._-` charset) but rejects 0 args, >1 arg (the two-token PoC), an
  embedded space (the one-arg PoC), a wrong namespace, the bare prefix (empty
  token), slash/`..`/`;` bytes, and an over-long name. The sudoers grant is the
  FIXED helper path, validated by `visudo -cf` — NO wildcard on `systemctl`.
- No OAuth token / no `ANTHROPIC_API_KEY` rides through sudo; the cost-abort
  survives in sandbox mode; minimal `{PATH}` env; deterministic unit name.
- The wrapper and installer pass `bash -n`; sudoers validated by `visudo -cf` on
  a temp file BEFORE install (FIX E).

**Unverified until run on the Pi (CI cannot sudo / spawn systemd / run claude) —
the load-bearing security claims, CLAIMED not verified until the checklist runs:**
- That `systemd-run --uid/--gid/--property=...` accepts **every** directive —
  ESPECIALLY `TemporaryFileSystem`, `BindReadOnlyPaths`, `BindPaths`,
  `PrivateDevices` (the FIX A allowlist-fs) and `--input-format text` on the Pi's
  `claude` — on the Pi's systemd (Bookworm = systemd 252; all directives used are
  ≥ that). I could NOT run `man systemd.exec`/`systemd-run --help` on the
  authoring Mac (no systemd here); the property names are asserted against systemd
  docs, not a live `man`. **Confirm on the Pi before trusting the cage.**
- That the prompt actually flows `node stdin → sudo → systemd-run --pipe →
  claude -p` and produces a real finding (checklist item 5). The
  `claude -p`-reads-stdin behaviour was confirmed against the local `claude`
  binary, but NOT through the full sudo→systemd-run `--pipe` chain.
- **That claude actually STARTS inside the cage and returns a NON-NULL finding**
  (round-2 HIGH 2, checklist item 5). The claude-tree resolution
  (`readlink -f` → `/etc/stage-reader/binds.conf` → wrapper sources it) is
  designed and the conf round-trips in a local shell test, but whether the Pi's
  specific shim+versions layout binds *completely* enough for claude to load is
  the load-bearing unverified claim. A null finding here = a broken cage.
- **That the reaper helper is authorized** (round-3 HIGH, checklist item 6): the
  installer grants the FIXED `/usr/local/sbin/stage-reader-reap *` path, but
  `sudo -n stage-reader-reap …` succeeding (vs. password-prompting / denied), and
  the helper's stop/kill actually reaching a live unit, are on-Pi.
- That the allowlist filesystem (item 2 — `/home/nick` AND sibling clones absent),
  the egress port-filter (item 3), run-as-stage-reader (item 1), the pinned-command
  rejection (item 0), and the SIGTERM→unit-stop + authorized reaper-helper teardown
  (item 6) all behave as designed.
- The residual TOCTOU window on the clone dir (FIX D) is narrowed, not closed —
  see "Filesystem ownership + the TOCTOU window" above.
