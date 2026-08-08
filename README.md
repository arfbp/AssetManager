# OptiFleet AI Agent

A low-footprint background agent for internal fleet management: hardware
telemetry collection with dynamic polling, and a real-time control channel
for authenticated remote commands. Written in Go, runs as a standard, named
OS service (Windows Service / launchd daemon / systemd unit).

## Design decisions worth knowing

- **Visible, not hidden.** The service registers under `service.name` in
  `configs/agent.yaml` (default `OptiFleetAIAgent` / display name
  `OptiFleet AI Agent`) and shows up normally in Task Manager, `services.msc`,
  `launchctl list`, or `systemctl status`. It runs with no GUI/tray icon,
  which is standard background-service behavior, but it does not attempt to
  conceal itself from the OS's own service tooling. That's a deliberate
  boundary: real invisibility requires rootkit-style techniques that are
  indistinguishable from malware, and this codebase doesn't implement them.
- **Every remote command is signature-verified, allowlisted, and
  audit-logged**, including rejected attempts (`internal/executor`). Nothing
  the server sends executes as arbitrary shell — only the three specific,
  parameterized actions in `configs/agent.yaml: commands.allowed`.
- **`restart_host` requires an explicit `confirm: true` param** on top of
  signature + allowlist checks, and is delayed (`commands.restart_confirm_delay`,
  default 30s) rather than immediate.
- **Secrets never live in the YAML config.** Auth token and HMAC signing
  secret are read from environment variables (`OPTIFLEET_AUTH_TOKEN`,
  `OPTIFLEET_HMAC_SECRET`); `config.Load` refuses to start without them.

## Folder structure

```
cmd/agent/main.go          Entry point: flag parsing, service wiring, graceful shutdown
internal/config/           YAML config loading + validation (fails closed, not open)
internal/logger/           Rotated structured logs: agent.log (ops) + audit.log (commands)
internal/telemetry/
  types.go                 Snapshot / ProcessInfo / DiskInfo / DeviceInfo data model
  devices_windows.go        Connected USB/printer/monitor enumeration via WMI
  devices_darwin.go         Same, via system_profiler + lpstat (macOS)
  devices_other.go          No-op stub for platforms without an implementation yet
  collector.go              One-shot telemetry read via gopsutil (CPU/RAM/disk/processes)
  poller.go                 Dynamic normal(5m)/alert(10s) polling state machine
internal/transport/
  protocol.go                Wire format: envelopes, HMAC-signed commands
  client.go                  WebSocket client: TLS/mTLS, reconnect w/ backoff, read/write loops
internal/executor/         Command allowlist, signature check, action handlers, audit log
  script_windows.go / script_unix.go   Hidden-window process spawn for run_script (Windows/Unix split)
internal/cleanup/          Shared safe directory-content deletion (path-traversal-safe, allowlist-only)
internal/selfheal/         Self-Healing Engine: service watchdog, disk auto-cleanup, memory leak monitor
  service_ctl_windows.go / service_ctl_unix.go   SCM (x/sys/windows/svc/mgr) vs systemctl/launchctl
  workingset_windows.go / workingset_unix.go     EmptyWorkingSet trim (Windows-only) vs no-op
internal/svc/               kardianos/service wrapper (Start/Stop lifecycle)
configs/agent.yaml          Default configuration
scripts/                    Build + install helpers (Windows/macOS)
```

## How dynamic polling works (`internal/telemetry/poller.go`)

A single timer drives collection — not two competing tickers — so a mode
switch takes effect on the very next wake-up:

- **Normal mode**: collect + report every `polling.normal_interval` (default 5m).
- The moment one reading has CPU or memory ≥ threshold (default 85%), the
  agent switches to **alert mode**: collect + report every
  `polling.alert_interval` (default 10s).
- It only drops back to normal mode after `polling.recovery_streak`
  (default 3) *consecutive* readings back under threshold — this hysteresis
  stops the agent from flapping mode every tick when a metric hovers right at
  the line.

## How the command channel works (`internal/transport`, `internal/executor`)

1. Agent dials `server.url` (must be `wss://`) with mTLS client cert
   (preferred) or a bearer token, and keeps the connection alive with
   ping/pong + exponential-backoff reconnect.
2. Server pushes a `command` envelope: `{id, action, params, issued_at_unix,
   signature}`. `signature` is HMAC-SHA256 over the canonical JSON of
   `{id, action, params, issued_at_unix}`, keyed with the shared secret in
   `OPTIFLEET_HMAC_SECRET` — the agent recomputes and compares it locally, so a
   compromised relay in between can't forge or replay-modify commands even
   though the WebSocket session itself is authenticated.
3. `Executor.Handle` checks, in order: signature validity → timestamp freshness
   (rejects anything >2 min old or from the future) → allowlist membership →
   action-specific safety checks (protected-process list for `kill_process`,
   directory allowlist for `clean_temp`, explicit confirm for `restart_host`).
4. Every step is written to `audit.log`, whether accepted, rejected, or
   failed, before a `command_result` is sent back to the server.

## Self-Healing Engine (`internal/selfheal`)

Three autonomous loops, wired into `runAgent` in [cmd/agent/main.go](cmd/agent/main.go).
Everything they act on is drawn from **local config** (`self_heal:` in
`configs/agent.yaml`), fixed at deploy time — none of it is expandable by a
runtime server command. That's a deliberate, narrower trust boundary than
the remote command path in `internal/executor`: a compromised or malicious
server command can only ever do what `commands.allowed` lets it do; the
self-healing loops can only ever touch what `self_heal:` lists, full stop.

- **Service watchdog** (`watchdog.go`): polls each service in
  `self_heal.services.watch` every `check_interval` (default 1m) via the
  real OS service-manager API — `golang.org/x/sys/windows/svc/mgr` on
  Windows, `systemctl`/`launchctl` on Linux/macOS — and starts it if
  stopped. A rolling `max_restarts_per_hour` cap (default 5) stops it from
  fighting a genuine crash loop forever; past the cap it stops touching the
  service and sends a loud `restart_suppressed` alert instead of silently
  giving up.
- **Disk auto-cleanup** (`disk_cleanup.go`): on every telemetry snapshot,
  if any disk's free space drops below `self_heal.disk_cleanup.free_threshold_percent`
  (default 10%), it cleans every directory in
  `commands.clean_temp_allowed_dirs` — the *same* allowlist the remote
  `clean_temp` command uses, via the same `internal/cleanup` package, so
  there's exactly one path-traversal-safe implementation instead of two to
  keep in sync. A `cooldown` (default 15m) stops it from re-running every
  poll tick.
- **Memory leak monitor** (`memory_leak.go`, `memory_monitor.go`): tracks
  each top-N process's RSS across snapshots and flags one whose memory grew
  monotonically by `self_heal.memory_leak.growth_threshold_mb` (default
  500MB) or more over `min_samples` (default 5) consecutive readings — a
  single spike doesn't trigger it, sustained one-directional growth does. On
  flag, it (1) calls `EmptyWorkingSet` on Windows to trim the process's
  physical footprint (`workingset_windows.go`; a documented no-op on
  Linux/macOS, see below), and (2) sends a `memory_leak_suspected` alert to
  the server. **It never kills or restarts the process itself** — a
  heuristic growth signal isn't reliable enough to justify silently
  destroying a user's unsaved work in Excel, a browser tab, etc. The server
  can push an explicit, signed `kill_process` command if a human or policy
  decides that's warranted.

All three report what they did via a new `alert` message type
(`transport.AlertPayload` / `Client.SendAlert`) — fire-and-forget, since the
whole point of self-healing is to recover without depending on the server
being reachable.

### The `run_script` command — read this before enabling it

`internal/executor`'s `run_script` action executes server-supplied
PowerShell/cmd/bash/sh content verbatim, as SYSTEM/root, with no console
window (`script_windows.go` / `script_unix.go`). This is categorically
different from every other command here: `kill_process`, `clean_temp`, and
`restart_host` have code-defined, bounded semantics — params only tune
behavior within safe limits the agent itself enforces. `run_script`'s
semantics *are* whatever the script says; the agent cannot vet content the
way it vets a fixed-shape action.

It is **off by default** and gated twice before it will run at all:

1. `run_script` must be explicitly added to `commands.allowed` in
   `configs/agent.yaml`.
2. The environment variable `OPTIFLEET_ENABLE_RUN_SCRIPT=true` must also be
   set — `config.Load` refuses to start otherwise. This second gate exists
   so enabling it can never be an accidental side effect of copying a config
   file around.

Even enabled, every invocation still passes through the same
signature+timestamp+allowlist checks as every other command, is bounded by
a hard timeout (`commands.script_timeout`, default 5m) and body/output size
caps, and — critically — the **full script body (SHA-256 + verbatim text)
and captured stdout/stderr are written to `audit.log` for every attempt**,
success or failure. "Silent" here means invisible to the interactive user's
desktop, which is just how Windows services already work (Session 0 has no
desktop to show a window on regardless) — it does not mean invisible to
your own logs, and nothing in this codebase suppresses or skips that audit
write.

What this agent cannot do for you: vet script *content* for safety, or
verify a human actually approved a given script before it was pushed. That
has to be a server-side control — RBAC on who can issue `run_script`
commands, a review/approval step, rate limiting. Treat enabling this action
as equivalent to granting whoever controls that server-side workflow full
SYSTEM/root access to every enrolled host, because that's what it is.

## Building

Requires Go 1.22+ (not installed in this environment — install it, then run
the commands below; `go.sum` will be generated by `go mod tidy` since it
wasn't possible to fetch dependencies here).

```powershell
go mod tidy
go build -o bin/optifleet-agent.exe ./cmd/agent   # Windows
# or: go build -o bin/optifleet-agent ./cmd/agent  # macOS/Linux
```

Run locally without installing as a service (useful for development):

```powershell
./bin/optifleet-agent.exe -run -config configs/agent.yaml
```

Install/manage as a service:

```powershell
./bin/optifleet-agent.exe -service install -config configs/agent.yaml
./bin/optifleet-agent.exe -service start   -config configs/agent.yaml
./bin/optifleet-agent.exe -service stop    -config configs/agent.yaml
./bin/optifleet-agent.exe -service uninstall -config configs/agent.yaml
```

Or use `scripts/install_windows.ps1` (run as Administrator) /
`scripts/install_macos.sh` (run with `sudo`), which build and install in one
step.

Before starting the service, set the two required secrets as environment
variables (machine-level, or via your secrets manager / MDM — not in
`agent.yaml`):

```powershell
setx OPTIFLEET_AUTH_TOKEN "..."          /M
setx OPTIFLEET_HMAC_SECRET "..."         /M
```

## Resource target notes

The <20MB RAM / <1% CPU target is achievable but not automatic with Go's
runtime GC. To get there in practice:

- Set `GOGC=50` and/or `GOMEMLIMIT=24MiB` as environment variables on the
  service to cap heap growth and trigger more frequent (cheap, since the heap
  is tiny) collections instead of growing.
- Build with `-ldflags "-s -w"` to strip debug info (smaller binary, not
  runtime RAM, but reduces disk footprint and load time).
- The dominant RAM cost is the process list gathered on every telemetry read
  (`polling.top_n_processes`), which is also the main CPU cost during
  `Collect()`. The default (`0`) reports every running process — accurate,
  matches what Task Manager shows, but the highest-footprint setting. Set it
  to a positive number (10–15 is plenty for spotting a runaway process) to
  cap the report and trade completeness for the <20MB/<1% target.
- If <20MB proves too tight for Go's baseline runtime overhead in practice,
  the same architecture (poller state machine, signed command allowlist,
  audit-logged executor) ports directly to Rust using `sysinfo` +
  `windows-service`/a launchd wrapper + `tokio-tungstenite`, at the cost of
  more scaffolding code than kardianos/service gives you for free in Go.

## What's intentionally not implemented yet

- Server-side signing implementation (this repo is the agent only).
- Log shipping / centralized log aggregation — `audit.log` and `agent.log`
  are local, rotated files; wire them into your existing log pipeline.
- Auto-update mechanism — deliberately out of scope for a first pass; an
  agent that can silently replace its own binary is a significant additional
  trust boundary that deserves its own signed-release design, not a bolt-on.
