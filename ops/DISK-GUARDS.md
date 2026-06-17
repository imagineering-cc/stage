# Stage Pi disk guards

Two cheap, zero-dependency infra-as-code guards against the failure class that
once took the Pi down: the SD card filling to 100% / 0 bytes, which crash-looped
the GitHub Actions runner and blocked CD. (The cause was a now-decommissioned
Docker media stack writing to **unmounted** mountpoints, so its writes landed on
the root fs.) The stack is gone; the failure class is not. These guards are bash
+ coreutils + curl only — nothing new to install.

## 1. Disk-usage alert (detective)

Pings Nick before the disk is full.

- `disk-alert.sh` — reads `df` for `/` and notifies when usage ≥ threshold.
- `stage-disk-alert.service` / `.timer` — run it every 15 min as a systemd
  **user** timer (same pattern as `stage-server.service`).
- `alert.local.env.example` — template for the **gitignored** secrets drop-in.

### Config

All env, overridable in `ops/alert.local.env` (sourced automatically) or the
`.service`:

| Var | Default | Meaning |
|-----|---------|---------|
| `STAGE_DISK_MOUNT` | `/` | filesystem to watch |
| `STAGE_DISK_THRESHOLD` | `85` | alert at ≥ this usage % |
| `STAGE_ALERT_TG_TOKEN` | — | Telegram bot token (default notifier) |
| `STAGE_ALERT_TG_CHAT` | — | Telegram chat id |
| `STAGE_ALERT_CMD` | — | replace the notifier entirely (ntfy, signal-cli, webhook…) |

### Why Telegram-curl, not the `telegram`/`signal` CLIs

Those CLIs (`~/.claude/cli-tools/...`) live on Nick's **Mac**, not the Pi. The
Pi can reach the public Telegram Bot API over HTTPS with nothing but `curl`, so
the default notifier is a single curl call to `sendMessage`, reusing the
existing `claude-dreams-telegram` bot token + Nick's chat id. The notifier is a
single pluggable function — set `STAGE_ALERT_CMD` to swap in any other
transport without editing the script.

### Secret placement (NEVER committed)

```bash
cp ops/alert.local.env.example ops/alert.local.env
chmod 600 ops/alert.local.env
# edit in the real bot token + chat id
```

`ops/alert.local.env` is gitignored (`*.local.env` + an explicit rule). The token
is never on a command line, never in a tracked unit file.

### Failure behaviour (deliberate)

- **Notifier fails** (no network, unconfigured, HTTP error): logged loudly to
  stderr / journal, but the script still exits `0`. The monitor must never
  become the thing that crash-loops.
- **`df` unparseable**: exits `1` so systemd records a real fault.
- **Bad threshold config**: exits `2`.

## 2. Mount guard (preventive)

Stops a future writer from writing to an **unmounted** target — the exact root
cause of the original incident.

- `require-mount.sh DIR [DIR ...]` — exits non-zero unless every DIR is a live
  mountpoint. Drop it in as an `ExecStartPre=` on any writer service.

Two complementary wiring patterns — use both where you can:

```ini
# (a) live-kernel precondition, no fstab assumptions:
[Service]
ExecStartPre=/home/nick/stage/ops/require-mount.sh /mnt/media

# (b) declarative dependency when the mount is in fstab / a .mount unit:
[Unit]
RequiresMountsFor=/mnt/media
```

`RequiresMountsFor=` orders + fails the service against systemd's view of the
mount; `require-mount.sh` checks the **live** kernel state. (a) catches the case
where fstab is right but the mount silently dropped; (b) catches ordering. There
is no writer wired today (downstream is gone) — this is ready-to-wire
scaffolding for the next stack.

## Install

Both guards install via `ops/install-user-services.sh` (it enables + starts the
disk-alert timer and verifies the guard scripts are present and executable). The
mount guard is a library script — installed/validated, not wired to any service
until a writer needs it.

## On-Pi verification (needs the live appliance)

- **Alert:** temporarily lower the threshold to below current usage
  (`STAGE_DISK_THRESHOLD=1 ./ops/disk-alert.sh`) and confirm a Telegram message
  arrives, then revert. Do NOT fill the disk to test.
- **Mount guard:** `./ops/require-mount.sh /` (a real mountpoint → exit 0) and
  `./ops/require-mount.sh /tmp/not-a-mount` (→ exit 1).
- **Timer:** `systemctl --user list-timers stage-disk-alert.timer` shows it
  scheduled; `journalctl --user -u stage-disk-alert.service` shows runs.
