# The Reader OS Sandbox (Slice 8)

> **The cage that must exist before the monster.** This is the OS-level
> confinement that lets `reader.js` (The Reader) point at **untrusted,
> attacker-controllable attendee repositories** in production. Until it is
> installed AND `STAGE_READER_SANDBOX=1` is set, point The Reader **only at
> trusted repos** — see the constraint banner in `reader.js`.

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
   exists. `reader.js` restricts the model's *tools*, but in direct mode the
   `claude` **process still runs as `nick`** with nick's full filesystem and
   network access. A zero-day in the CLI, node, or a transitive dep — triggered
   by reading crafted bytes — would execute **as nick**: read `~/.ssh`,
   `ops/*.local.env` (OAuth tokens, OpenAI/GitHub keys), `stage-state.json`,
   exfiltrate over any port. A zero-click RCE on the host. **This sandbox
   contains threat 2** by running the process as an unprivileged user inside a
   tight systemd cage with an egress filter.

## The invariant this enforces

> A `claude` process reading an attacker-controllable clone runs as the
> unprivileged **`stage-reader`** system user such that it:
> 1. **CANNOT** read `/home/nick` or any path outside its clone dir + its own
>    claude-config dir (filesystem confinement);
> 2. **CANNOT** gain privileges (`NoNewPrivileges=yes` + a seccomp syscall
>    filter);
> 3. has network egress restricted to **HTTPS (443) + DNS only** (it only ever
>    talks to the Anthropic API; it has no Bash/WebFetch tool anyway — this is
>    defense-in-depth against a claude-CLI compromise);
> 4. the stage-server (running as `nick`) keeps doing **all** git/clone/network;
>    `claude` does neither. The raw repo bytes reach **only** the contained
>    reader.

## The mechanism

The stage-server runs under nick's **user** systemd and cannot spawn a process
as another uid with confinement without privilege. So:

```
reader.js (as nick)
  │  git clone  (as nick — all network is nick's)
  │  spawn: sudo -n /usr/local/sbin/stage-reader-run <cloneDir> -- claude <ro args>
  ▼
sudo (NOPASSWD, ONE command only)
  ▼
/usr/local/sbin/stage-reader-run   (root-owned 0755, NOT writable by nick)
  │  validates cloneDir is under /var/lib/stage-reader (realpath, no .. / symlink escape)
  │  exec systemd-run --uid=stage-reader --gid=stage-reader --wait --pipe --collect
  │                   --working-directory=<cloneDir>  <confinement property set>
  ▼
transient systemd unit "stage-reader-<clone>"   ← THE CAGE
  └── claude  (as stage-reader, confined fs/syscalls/caps, egress 443+53 only)
```

### Why a root wrapper + NOPASSWD sudoers (and not something lighter)

- A **user-systemd** service can't change uid or drop into another user's
  cgroup — those need root. The stage-server is nick's user process.
- `systemd-run` **as root** can `--uid=stage-reader` *and* apply the full
  `systemd.exec` confinement property set in one shot. That's the cleanest cage
  primitive already on the Pi (no firejail/bubblewrap dependency).
- The sudoers glob is `nick ALL=(root) NOPASSWD: /usr/local/sbin/stage-reader-run *`.
  The `*` is broad — sudoers globbing **cannot** express "a path under
  `/var/lib/stage-reader` with no `..`/symlink escape". **So the real trust
  boundary is the wrapper's argument validation**, performed as root before it
  execs anything. The wrapper is root-owned and not writable by nick, so nick
  cannot weaken the gate he is trusted to invoke.

### Filesystem ownership (clone readable by stage-reader, writable by nick)

- `/var/lib/stage-reader` and `/var/lib/stage-reader/clones`: owned
  **`nick:stage-reader`, mode 0750**, with a **default ACL**
  `g:stage-reader:r-x` on `clones/` so every per-run clone dir nick creates is
  automatically group-traversable/readable by stage-reader — no per-run `chmod`.
  nick writes (clones into) it; stage-reader only reads; the cage additionally
  mounts the clone `ReadOnlyPaths`, so even the contained process can't write it.
- `/var/lib/stage-reader/{home,claude-config,run-tmp}`: owned
  **`stage-reader:stage-reader`, mode 0700** — stage-reader's private HOME, its
  OWN claude config + OAuth token (mode 0600, **separate** from nick's), and a
  writable scratch (`TMPDIR`). nick cannot read stage-reader's token; the cage's
  `ReadWritePaths` is exactly these three and nothing else.

### The confinement property set (the cage)

Applied by the wrapper via `systemd-run --property=`. Each is a standard
`systemd.exec(5)` directive:

| Property | Effect |
|---|---|
| `NoNewPrivileges=yes` | no setuid/fscaps privilege escalation, ever |
| `SystemCallFilter=@system-service` + `~@privileged @mount @debug @reboot @swap @obsolete @resources` | seccomp allowlist of ordinary service syscalls, minus the dangerous classes |
| `SystemCallArchitectures=native` | block non-native syscall ABIs (defeats a 32-bit-ABI bypass) |
| `CapabilityBoundingSet=` / `AmbientCapabilities=` (empty) | no capabilities at all |
| `ProtectHome=yes` | `/home`, `/root`, `/run/user` become empty/inaccessible → **cannot read `/home/nick`** |
| `ProtectSystem=strict` | entire filesystem read-only except `ReadWritePaths` |
| `ReadOnlyPaths=<cloneDir>` | the repo bytes are read-only even to the contained process |
| `ReadWritePaths=<home> <config> <run-tmp>` | the ONLY writable paths |
| `PrivateTmp=yes` | private `/tmp`, `/var/tmp` |
| `ProtectProc=invisible` + `ProcSubset=pid` | can't see other processes in `/proc` |
| `ProtectKernelTunables/Modules/Logs=yes`, `ProtectClock=yes`, `ProtectControlGroups=yes`, `ProtectHostname=yes` | kernel/host state read-only or hidden |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` | only IP + unix sockets (no raw/packet/netlink) |
| `RestrictNamespaces=yes`, `RestrictRealtime=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `RemoveIPC=yes` | shut common escape/privilege primitives |
| `UMask=0077` | anything it does write is private |

**`MemoryDenyWriteExecute` is DELIBERATELY OMITTED.** node (and therefore
`claude`) JITs — W^X memory would `SIGSEGV` the runtime and break every run. The
seccomp filter + capability drop + namespace/filesystem confinement carry the
containment without it. (Stated as a named, accepted tradeoff: a JIT-based RCE
that lives entirely in already-mapped RWX pages is not blocked by the seccomp
classes we drop, but it still cannot escalate privilege, read `/home/nick`, or
egress anywhere but 443/53.)

### Egress filter (`ops/stage-reader-nftables.conf`)

An additive nftables table `inet stage_reader` that matches **by UID**
(`meta skuid stage-reader`) and allows only `tcp/443` + `udp,tcp/53` +
established/related + loopback, dropping (rate-limited-logged) everything else.
Because it's scoped to the stage-reader UID, the **stage-server's own** clone
traffic (git/HTTPS), yt-dlp, OpenAlex, and Tailscale — all running as `nick` —
are **completely unaffected**.

### Kill-path propagation (timeout → contained child)

`reader.js`'s wall-clock guard does `child.kill('SIGTERM')` then `SIGKILL`. In
sandbox mode `child` is `sudo -n`, not `claude`. The chain:

```
Node child.kill('SIGTERM')
  → sudo forwards SIGTERM to its child            (sudo ≥ 1.8.15)
  → the wrapper has exec'd into `systemd-run --wait`, which on SIGTERM STOPS the
    transient unit
  → systemd sends SIGTERM to claude in the unit's cgroup, then SIGKILL after the
    unit's TimeoutStopSec=5 (KillMode=mixed) — a hard, cgroup-scoped kill of the
    whole contained tree
```

So **systemd itself owns the contained hard-kill** (cgroup-scoped, can't be
ignored). Node's `SIGKILL` fallback is only a last-resort reaper of the
sudo/systemd-run layer; a stray transient unit is `--collect`-cleaned anyway.

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

# 3. the root-owned wrapper (NOT writable by nick)
sudo install -o root -g root -m 0755 ~/stage/ops/stage-reader-run /usr/local/sbin/stage-reader-run

# 4. the NOPASSWD sudoers drop-in — VALIDATE with visudo before trusting it
printf '%s\n' 'nick ALL=(root) NOPASSWD: /usr/local/sbin/stage-reader-run *' \
  | sudo tee /etc/sudoers.d/stage-reader >/dev/null
sudo chmod 0440 /etc/sudoers.d/stage-reader
sudo visudo -cf /etc/sudoers.d/stage-reader      # MUST print "parsed OK"

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

# 7. flip the stage-server into sandbox mode (systemd drop-in), then restart
sudo systemctl --user --machine=nick@ edit stage-server.service   # OR edit the drop-in by hand:
#   [Service]
#   Environment=STAGE_READER_SANDBOX=1
systemctl --user daemon-reload
systemctl --user restart stage-server.service
```

> The token in step 5: **do NOT** set `ANTHROPIC_API_KEY` anywhere the
> stage-server or stage-reader can see it. `reader.js` hard-aborts the run if it
> detects one (the ~$1,800 metered-billing footgun) — that guard is
> mode-independent and survives in sandbox mode.

## On-Pi verification checklist (the REAL gate — CI cannot do any of this)

Run after install, pointing at a **benign** trusted repo first. Until every box
is checked on the Pi, the OS confinement is **claimed, not verified**.

1. **Process runs as `stage-reader`.** Kick a read, and while it runs:
   ```bash
   ps -o user,pid,cmd -C claude        # USER column must be 'stage-reader', NOT 'nick'
   systemctl list-units 'stage-reader-*'   # the transient cage unit is present
   ```
2. **Cannot read `/home/nick`.** Confirm the cage blocks it. Temporarily run an
   equivalent probe in the cage:
   ```bash
   sudo /usr/local/sbin/stage-reader-run /var/lib/stage-reader/clones/<a-real-clone> -- \
     /bin/sh -c 'cat /home/nick/.ssh/id_* 2>&1; cat /home/nick/stage/ops/reader.local.env 2>&1'
   # EXPECT: "No such file or directory" / "Permission denied" — NOT file contents.
   # (ProtectHome=yes makes /home appear empty inside the cage.)
   ```
   > Note: this probe passes `/bin/sh` as the command, which the wrapper permits
   > (it validates the *clone dir*, not the command). That's fine for a manual
   > confinement probe; in production `reader.js` only ever passes `claude`.
3. **Egress to a non-443 port is dropped.**
   ```bash
   sudo /usr/local/sbin/stage-reader-run /var/lib/stage-reader/clones/<a-real-clone> -- \
     /bin/sh -c 'timeout 5 bash -c "echo > /dev/tcp/1.1.1.1/80" 2>&1 && echo OPEN || echo BLOCKED'
   # EXPECT: BLOCKED (port 80 not allowed). Then repeat with /443 → should connect.
   sudo nft list table inet stage_reader    # the drop counter / log confirms it
   ```
4. **`ANTHROPIC_API_KEY` stays unset** for the contained process:
   ```bash
   sudo /usr/local/sbin/stage-reader-run /var/lib/stage-reader/clones/<a-real-clone> -- \
     /bin/sh -c 'echo "${ANTHROPIC_API_KEY:-UNSET}"'
   # EXPECT: UNSET
   ```
5. **A real read produces a genuine finding** against a trusted repo, and:
   - no zombie `claude` / no leftover `stage-reader-*` unit afterwards
     (`systemctl list-units 'stage-reader-*'` is empty);
   - the per-run scratch dir under `/var/lib/stage-reader/clones/` is **wiped**.
6. **Timeout path:** set `STAGE_READER_TIMEOUT_MS=2000`, point at a larger repo,
   confirm the run is killed and the cage unit torn down within a few seconds.

## What is verified now vs. unverified-until-Pi

**Verified now (in CI / on this branch):**
- Direct-mode behaviour is unchanged — all 24 original `reader.test.js` tests
  green.
- The sandbox **spawn-path selection** is correct: `buildSpawn` produces
  `sudo -n <wrapper> <cloneDir> -- claude <ro args>` with a minimal `{PATH}` env,
  no OAuth token through sudo, no `ANTHROPIC_API_KEY`, and the deterministic unit
  name (2 unit tests + 1 end-to-end via a FAKE `sudo`).
- Sandbox mode does **not** require nick's token, and the `ANTHROPIC_API_KEY`
  cost-abort survives in sandbox mode (2 end-to-end tests).
- The wrapper and installer pass `bash -n`; the sudoers line passes a `visudo -c`
  shape (validated again at install time).

**Unverified until run on the Pi (CI cannot sudo / spawn systemd / run claude):**
- That `systemd-run --uid/--gid/--property=...` accepts every directive on the
  Pi's systemd version (RPi OS Bookworm ships systemd 252; all directives used
  are ≥ that). **Confirm with `systemd-run --help` and `man systemd.exec` on the
  Pi before trusting the cage.**
- That the SIGTERM→unit-stop→SIGKILL chain actually reaps the contained `claude`
  (checklist item 6).
- The filesystem confinement, the egress filter, and the run-as-stage-reader
  property (checklist items 1–5). **These are the load-bearing security claims
  and are CLAIMED, not verified, until the checklist is walked on the Pi.**
