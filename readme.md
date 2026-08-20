# OptiFleet AI Agent

A background agent for managing an organization's device fleet. It uses minimal resources, collects hardware telemetry through dynamic polling, and provides a real-time control channel for receiving authenticated remote commands. Written in Go and runs as a standard OS service (Windows Service / launchd daemon / systemd unit).

## Key Design Concepts

- **Visible, Not Hidden** The service is registered under `service.name` in `configs/agent.yaml` (the default is `OptiFleetAIAgent` / display name `OptiFleet AI Agent`) and appears normally in Task Manager, `services.msc`, `launchctl list`, or `systemctl status` The agent runs without a GUI/tray icon, which is standard behavior for a typical background service, but it does not attempt to hide itself from the OS's own service-management tools. This is the intentional boundary: truly invisible hiding would require rootkit-like techniques that are indistinguishable from malware, and this codebase does not do that.
- **Every remote command must be signature-verified, be on the allowlist, and be recorded in the audit log every time** including rejected commands (`internal/executor`) Nothing sent by the server is executed as an unrestricted shell command — There are only 3 actions with explicitly defined parameters in `configs/agent.yaml: commands.allowed` เท่านั้น
- **`restart_host`**** must explicitly include the parameter ****`confirm: true`**** explicitly specified** in addition to signature verificationand allowlist and execution is delayed before the actual operation (`commands.restart_confirm_delay` The default 30 วิminutes) instead of executing immediately
- **Secrets are never stored in the YAML config** The authentication token and HMAC signing secret are read only from environment variables (`OPTIFLEET_AUTH_TOKEN`, `OPTIFLEET_HMAC_SECRET`) — `config.Load` will refuse to start if either value is missing

## Folder Structure

```
cmd/agent/main.go          Program entry point: parse flags, bind the service, graceful shutdown
internal/config/           Load + validate YAML config (fail closed, not fail open)
internal/logger/           Rotating logs: agent.log (ops) + audit.log (received commands)
internal/telemetry/
  types.go                 Data models Snapshot / ProcessInfo / DiskInfo / DeviceInfo
  devices_windows.go        Enumerate connected USB devices/printers/displays through WMI
  devices_darwin.go         Same, but through system_profiler + lpstat (macOS)
  devices_other.go          Empty stub for unsupported platforms
  collector.go              Read telemetry once through gopsutil (CPU/RAM/disk/process)
  poller.go                 State machine switching between normal (5 minutes)/alert (10 seconds)
internal/transport/
  protocol.go                Wire data format: envelope, HMAC-signed commands
  client.go                  WebSocket client: TLS/mTLS, reconnect with backoff, read/write loop
internal/executor/         command allowlist, signature verification, action handlers, audit log
  script_windows.go / script_unix.go   Create a windowless process for run_script
internal/cleanup/          Safely delete files in directories (prevent path traversal, allowlist only)
internal/selfheal/         Self-Healing Engine: monitor services, automatically clean disk files, detect memory leaks
  service_ctl_windows.go / service_ctl_unix.go   SCM (x/sys/windows/svc/mgr) เทียบกับ systemctl/launchctl
  workingset_windows.go / workingset_unix.go     trim EmptyWorkingSet (Windows only) compared with a no-op
internal/svc/               kardianos/service wrapper (Start/Stop lifecycle)
configs/agent.yaml          Default config
scripts/                    Build + install helper scripts (Windows/macOS)

```

## How dynamic polling works (`internal/telemetry/poller.go`)

A single timer drives data collection — not two competing tickers — so when the mode switches, the change takes effect on the next wake-up cycle immediately::

- **Normal mode**: collect + report every `polling.normal_interval` (The default 5 minutes)
- As soon as any reading shows CPU or RAM ≥ the threshold (The default 85%) the agent switches to **alert**: collect + report every `polling.alert_interval` (The default 10 วิminutes)
- willกลับไปNormal modeก็ต่อwhenมีthereadvalueติดต่อกัน `polling.recovery_streak` times (The default 3) thatbelow threshold แล้วเท่านั้น — This hysteresis prevents the agent from switching modes repeatedly on every tick when metrics fluctuate around the threshold

## How the Command Channel Works (`internal/transport`, `internal/executor`)

1. The agent connects to `server.url` (mustis `wss://`) using an mTLS client certificate (recommended) or bearer token, then keeps the connection alive with ping/pong and exponential-backoff reconnects
2. The server sends a `command` envelope: `{id, action, params, issued_at_unix, signature}` where `signature` is the HMAC-SHA256 of the canonical JSON of `{id, action, params, issued_at_unix}` signed with the shared secret in `OPTIFLEET_HMAC_SECRET` — The agent recalculates and compares the value locally Therefore, even if an intermediate relay is compromised, commands cannot be forged or modified in transit, even if the WebSocket session itself has already been authenticated.
3. `Executor.Handle` checks in order: signature validity → timestamp freshness (rejecting commands older than 2 minutes or from the future) → allowlist membership → action-specific safety checks (protected process list for `kill_process`, directory allowlist for `clean_temp`, explicit confirmation required for `restart_host`)
4. Every step is written to `audit.log` whether accepted, rejected, or failed, before sending `command_result` กลับไปยังserver

## Self-Healing Engine (`internal/selfheal`)

Three automatic loops ผูกเข้ากับ `runAgent` in [cmd/agent/main.go](https://github.com/chinnavat1725/OptiFleet-AI/blob/main/cmd/agent/main.go) Everything these loops do comes from **config local config** เท่านั้น (`self_heal:` in `configs/agent.yaml`) defined at deployment time nothing can be expanded through server commands at runtime — This is an intentionally narrower trust boundary than the remote command channelin `internal/executor` whereSetใจ: A compromised or malicious server command can only do what `commands.allowed` อนุญาตเท่านั้น the self-healing loops can only touch what `self_heal:` ระบุเท่านั้นเช่นกัน

- **Service monitoring** (`watchdog.go`): polls each service in `self_heal.services.watch` ทุก `check_interval` (The default 1 minutes) through the OS's actual service-management APIs — `golang.org/x/sys/windows/svc/mgr` บน Windows, `systemctl`/`launchctl` บน Linux/macOS — and restarts it if it stops has a rolling limit of `max_restarts_per_hour` mode rolling (The default 5) to avoid endlessly fighting a genuine crash loop Once the limit is exceeded, it stops touching that service and sends a `restart_suppressed` alert loudly instead of failing silently
- **Automatic disk cleanup** (`disk_cleanup.go`): Whenever a telemetry snapshot is collected if free space on any disk falls below `self_heal.disk_cleanup.free_threshold_percent` (The default 10%) it cleans every directory in `commands.clean_temp_allowed_dirs` — allowlist ชุด *singleกัน* กับthatCommand `clean_temp` fromระยะไกลuse through the same package `internal/cleanup` ตัวsingleกัน Therefore, it isso there is one path-traversal-protected implementation instead of two implementations that must be kept in sync มี `cooldown` (The default 15 minutes) to prevent it from running again on every poll tick
- **Memory leak detection** (`memory_leak.go`, `memory_monitor.go`): tracks the RSS of the top processes in each snapshot and flags a process when its memory grows monotonically to `self_heal.memory_leak.growth_threshold_mb` (The default 500MB) or later for `min_samples` (The default 5) consecutive samples — A single spike does not trigger a flag; growth must continue in the same direction Once flagged, it (1) เรียก `EmptyWorkingSet` บน Windows to reduce the process's actual memory footprint (`workingset_windows.go`; บน Linux/macOS is intentionally a no-op ดูด้านล่าง) and (2) sendalert `memory_leak_suspected` ไปยังserver **will never kill or restart the process itself** — memory-growth heuristic signals are not reliable enough to silently destroy a user's unsaved work in Excel or browser tabs The server can send a `kill_process` thatเซ็นandระบุชัดเจนcan ifhumanor policy ตัดสินใจว่า จำis

All three loops report their actions through a new `alert` (`transport.AlertPayload` / `Client.SendAlert`) mode fire-and-forget เพราะ จุดประสงค์mainof self-healing คือกู้คืนcanเองwherenotmustพึ่งว่าserver willเชื่อมต่อcanornot

### Command `run_script` — Read Before Enabling

action `run_script` in `internal/executor` executes the content PowerShell/cmd/bash/sh thatserversendมาตรงๆ inprivileges SYSTEM/root wherenotมีหน้าต่างคอนโซล (`script_windows.go` / `script_unix.go`) นี่ต่างfromCommandอื่นทุกตัวwhere สิ้นเชิง: `kill_process`, `clean_temp`, and `restart_host` have behavior explicitly bounded in code — parameters can only be adjusted within the safe boundaries enforced by the agent itself part `run_script` behavior *คือ* thingthatscriptบอกtoทำ the agent cannot inspect the content the way it can inspect fixed-form actions

Therefore, it is **disableisThe default** andมีประตูกั้นสองชั้นก่อนwillทำงานcan:

1. must explicitly add `run_script` to `commands.allowed` in `configs/agent.yaml` explicitly
2. must also set environment variable `OPTIFLEET_ENABLE_RUN_SCRIPT=true` to — `config.Load` willปฏิเสธthestartifnotมีvalueนี้ ประตูชั้นthatสองนี้มีเพื่อ nottotheเdisableuseงานเกิดขึ้นwhereบังเอิญfromtheก็อปปี้files config ไปมา

Even when enabled ทุกtheเรียกยังmustผ่านsignature verification+timestamp+allowlist เหมือนCommandอื่นทุกตัว มี a limited timeout (`commands.script_timeout` The default 5 minutes) andจำกัดขนาด body/output andthatสำคัญคือ **the full script content (SHA-256 + raw text) and stdout/stderr thatจับcanwillถูกเขียนลง ****`audit.log`**** every time execution is attempted** whether it succeeds or fails The word "silent" here means invisible from the desktop of the currently logged-in user which is already standard behavior for a Windows service (Session 0 notมี desktop toแสดงหน้าต่างอยู่แล้วnot ว่ากรณีใด) — notcanแปลว่ามองnotเห็นfrom log ofคุณเอง andthere is no part of this codebase that bypasses or suppresses audit logging

What this agent cannot do: checkสอบ *content* scriptว่าsafeornot or verify that a human actually approved the script before it is sent That must be enforced on the server side — RBAC ว่าใครsendCommand `run_script` can, ขั้นตอน review/approve, rate limiting toถือว่าenabling this action is equivalent to granting full SYSTEM/root privileges on every registered machine to whoever controls that server-side workflow, because that is what it actually is

## Building

Requires Go 1.22 or later

```
go mod tidy
go build -o bin/optifleet-agent.exe ./cmd/agent   # Windows
# or: go build -o bin/optifleet-agent ./cmd/agent  # macOS/Linux
```

runmode local wherenotmustติดSetis service (สะดวกforพัฒนา):

```
./bin/optifleet-agent.exe -run -config configs/agent.yaml
```

Install/manage as a service::

```
./bin/optifleet-agent.exe -service install -config configs/agent.yaml
./bin/optifleet-agent.exe -service start   -config configs/agent.yaml
./bin/optifleet-agent.exe -service stop    -config configs/agent.yaml
./bin/optifleet-agent.exe -service uninstall -config configs/agent.yaml
```

Or use `scripts/install_windows.ps1` (run as Administrator) / `scripts/install_macos.sh` (runto `sudo`) ซึ่ง build andติดSetinขั้นตอน single

Before starting the service, set both required secrets as environment variables (at the machine level or through a secrets manager / MDM — never put them in `agent.yaml`):

```
setx OPTIFLEET_AUTH_TOKEN "..."          /M
setx OPTIFLEET_HMAC_SECRET "..."         /M
```

## Resource Usage Targets

A RAM target of <20MB / CPU <1% is achievable, but it does not happen automatically from the Go runtime's GC; in practice, additional tuning is required::

- Set `GOGC=50` and/or `GOMEMLIMIT=24MiB` is environment variable บน service เพื่อจำกัดtheโตof heap andtocollectขยะบ่อยขึ้น (which is appropriate because the heap is already small) แทนthatwillปล่อยtoโต
- Build to `-ldflags "-s -w"` to strip debug information (ไบนารีเล็กลง notใช่ RAM ตอนrun butreduce footprint บนดิสก์andเวลาโหreduce)
- Most RAM cost comes from the process list collected on every telemetry read (`polling.top_n_processes`) which is also the main CPU cost during `Collect()` to The default (`0`) reports every running process — accurate and consistent with what Task Manager shows, but with the highest footprint Setisจำนวนบวก (10–15 enough to catch abnormal processes) เพื่อจำกัดreportandแลกความcompletenessกับtarget <20MB/<1%
- If <20MB is still too tight relative to the Go runtime's baseline overhead in ทางปฏิบัติ สถาปัตยกรรมsingleกัน (state machine of poller, allowlist Commandthatเซ็นลายเซ็น, executor thatบันทึก audit log) can be ported directly to Rust whereuse `sysinfo` + `windows-service`/wrapper of launchd + `tokio-tungstenite` at the cost of more scaffolding code than kardianos/service provides for free in Go

## thingthatยังnotcanทำwhereSetใจ

- ฝั่งserverforเซ็นCommand (repo นี้มีonlyตัวagent)
- Centralized log shipping — `audit.log` and `agent.log` is files local mode rotate เอง mustเชื่อมเข้ากับ log pipeline thatมีอยู่เอง
- Auto-update mechanism — Setใจnotทำinรอบแรกนี้ เพราะagentthatแทนthatไบนารีof ตัวเองmodeเงียบๆ can ถือisขอบเขตความวางใจadditionalเติมthatสำคัญ A separate signed-release design should be created rather than simply adding it on