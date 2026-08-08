// Package executor turns authenticated server commands into local actions.
// Every command is (1) signature-verified, (2) checked against an explicit
// allowlist, (3) executed with action-specific safety checks, and (4)
// audit-logged regardless of outcome — accepted, rejected, or failed.
package executor

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog"
	processutil "github.com/shirou/gopsutil/v3/process"

	"optifleet-agent/internal/cleanup"
	"optifleet-agent/internal/transport"
)

// protectedProcessNames must never be killed remotely — killing them can
// crash or lock out the host, defeating the point of a management agent.
var protectedProcessNames = map[string]struct{}{
	"system":       {},
	"csrss.exe":    {},
	"wininit.exe":  {},
	"winlogon.exe": {},
	"services.exe": {},
	"smss.exe":     {},
	"lsass.exe":    {},
	"init":         {},
	"launchd":      {},
	"systemd":      {},
	"kernel_task":  {},
}

type Config struct {
	AllowedActions       map[string]struct{}
	HMACSecret           string
	CleanTempAllowedDirs []string
	RestartConfirmDelay  time.Duration

	// run_script is the highest-risk action this agent exposes: it executes
	// server-supplied script content verbatim (as SYSTEM/root, no interactive
	// window). It is only reachable if "run_script" is explicitly present in
	// AllowedActions — off by default in configs/agent.yaml. These bounds
	// apply even when enabled; they cannot be disabled, only tightened.
	ScriptTimeout        time.Duration // hard kill if the script runs longer than this
	MaxScriptBytes       int           // reject script bodies larger than this
	MaxScriptOutputBytes int           // stdout+stderr captured/audited per run, truncated beyond this
}

type Executor struct {
	cfg   Config
	log   zerolog.Logger
	audit zerolog.Logger

	// Set via SetOutputSender after construction — main.go wires this to
	// transport.Client.SendCommandOutput once the client exists, which is
	// itself constructed *after* the executor (the client's own constructor
	// needs Executor.Handle as an argument), so this can't be a constructor
	// parameter without a circular dependency between the two.
	sendOutput func(commandID, line string, done bool, errMsg string)

	// Set via SetStateChangeNotifier — same deferred-wiring reason as
	// sendOutput (the poller is constructed after the executor). Fired after
	// a command in stateChangingActions succeeds, so the dashboard's process
	// list reflects a kill immediately instead of waiting up to
	// NormalInterval (minutes) for the next scheduled snapshot.
	notifyStateChanged func()
}

// stateChangingActions are commands whose success visibly changes what the
// *next* telemetry snapshot would show — kill_process removes a row from
// top_processes, clean_temp changes disk free space. restart_host and
// run_script are deliberately excluded: a reboot has no "next snapshot" to
// rush (the host is going down), and run_script's effects are open-ended,
// not something a generic refresh is targeting.
var stateChangingActions = map[string]struct{}{
	"kill_process": {},
	"clean_temp":   {},
}

func New(cfg Config, log, audit zerolog.Logger) *Executor {
	return &Executor{cfg: cfg, log: log.With().Str("component", "executor").Logger(), audit: audit}
}

// SetOutputSender wires up streaming output for long-running commands
// (network_diagnostic) — see the Executor.sendOutput field comment. Safe to
// leave unset (e.g. in tests): networkDiagnostic just skips the incremental
// sends and the caller only sees the final aggregated CommandResultPayload.
func (e *Executor) SetOutputSender(fn func(commandID, line string, done bool, errMsg string)) {
	e.sendOutput = fn
}

// SetStateChangeNotifier wires the out-of-cycle telemetry refresh — see the
// notifyStateChanged field comment. Safe to leave unset (e.g. in tests): the
// dashboard just falls back to seeing the change on the next scheduled poll.
func (e *Executor) SetStateChangeNotifier(fn func()) {
	e.notifyStateChanged = fn
}

// Handle implements transport.CommandHandler. It is the single choke point
// every inbound command passes through.
func (e *Executor) Handle(ctx context.Context, cmd transport.CommandPayload) (result transport.CommandResultPayload) {
	result = transport.CommandResultPayload{CommandID: cmd.ID, ExecutedUnix: time.Now().Unix()}

	// A bad command handler must never take the whole agent down with it.
	defer func() {
		if r := recover(); r != nil {
			e.log.Error().Interface("panic", r).Str("command_id", cmd.ID).Str("action", cmd.Action).Msg("command handler panicked, recovered")
			result.Success = false
			result.Message = fmt.Sprintf("internal error executing command: %v", r)
		}
	}()

	auditEvt := e.audit.Info().Str("command_id", cmd.ID).Str("action", cmd.Action).Interface("params", cmd.Params)

	if !cmd.VerifySignature(e.cfg.HMACSecret) {
		auditEvt.Bool("accepted", false).Str("reason", "signature_invalid").Msg("command rejected")
		result.Success = false
		result.Message = "signature verification failed"
		return result
	}

	// Reject stale commands to limit replay-attack value of a captured envelope.
	if age := time.Since(time.Unix(cmd.IssuedAtUnix, 0)); age > 2*time.Minute || age < -30*time.Second {
		auditEvt.Bool("accepted", false).Str("reason", "stale_or_future_timestamp").Dur("age", age).Msg("command rejected")
		result.Success = false
		result.Message = "command timestamp outside acceptable window"
		return result
	}

	if _, ok := e.cfg.AllowedActions[cmd.Action]; !ok {
		auditEvt.Bool("accepted", false).Str("reason", "not_in_allowlist").Msg("command rejected")
		result.Success = false
		result.Message = fmt.Sprintf("action %q is not in the allowlist", cmd.Action)
		return result
	}

	auditEvt.Bool("accepted", true).Msg("command accepted, executing")

	var msg string
	var err error
	switch cmd.Action {
	case "kill_process":
		msg, err = e.killProcess(ctx, cmd.Params)
	case "clean_temp":
		msg, err = e.cleanTemp(cmd.Params)
	case "restart_host":
		msg, err = e.restartHost(cmd.Params)
	case "shutdown_host":
		msg, err = e.shutdownHost(cmd.Params)
	case "run_script":
		msg, err = e.runScript(ctx, cmd)
	case "network_diagnostic":
		msg, err = e.networkDiagnostic(ctx, cmd.ID, cmd.Params)
	default:
		err = fmt.Errorf("no handler implemented for allowlisted action %q", cmd.Action)
	}

	if err != nil {
		e.audit.Error().Str("command_id", cmd.ID).Str("action", cmd.Action).Err(err).Msg("command execution failed")
		result.Success = false
		result.Message = err.Error()
		return result
	}

	e.audit.Info().Str("command_id", cmd.ID).Str("action", cmd.Action).Str("result", msg).Msg("command executed")
	result.Success = true
	result.Message = msg

	if _, ok := stateChangingActions[cmd.Action]; ok && e.notifyStateChanged != nil {
		e.notifyStateChanged()
	}

	return result
}

// killProcess accepts either params["pid"] (exact, unambiguous) or
// params["name"] (resolved against the live process list at execution
// time — not a stale telemetry snapshot). Name lookup exists because
// natural-language commands ("close the hung antivirus scanner") name a
// program, not a PID; the server-side LLM parser and guardrail never
// invent a PID themselves. If a name matches more than one running
// process, this refuses rather than killing all matches — silently
// expanding a kill from one process to several based on a fuzzy name
// match is exactly the kind of blast-radius growth this agent's design
// avoids elsewhere (see the executor package doc comment).
func (e *Executor) killProcess(ctx context.Context, params map[string]string) (string, error) {
	if pidStr, ok := params["pid"]; ok {
		pid, err := strconv.ParseInt(pidStr, 10, 32)
		if err != nil {
			return "", fmt.Errorf("kill_process: invalid pid %q: %w", pidStr, err)
		}
		return e.killByPID(ctx, int32(pid))
	}

	name := strings.TrimSpace(params["name"])
	if name == "" {
		return "", fmt.Errorf("kill_process: requires either params.pid or params.name")
	}
	return e.killByName(ctx, name)
}

func (e *Executor) killByPID(ctx context.Context, pid int32) (string, error) {
	if pid <= 4 { // 0 and 4 (System) on Windows, 1 (init/launchd) on Unix
		return "", fmt.Errorf("kill_process: refusing to touch protected low-numbered pid %d", pid)
	}

	proc, err := processutil.NewProcessWithContext(ctx, pid)
	if err != nil {
		return "", fmt.Errorf("kill_process: pid %d not found: %w", pid, err)
	}
	name, _ := proc.NameWithContext(ctx)
	if _, protected := protectedProcessNames[strings.ToLower(name)]; protected {
		return "", fmt.Errorf("kill_process: refusing to kill protected process %q (pid %d)", name, pid)
	}

	if err := proc.KillWithContext(ctx); err != nil {
		return "", fmt.Errorf("kill_process: pid %d: %w", pid, err)
	}
	return fmt.Sprintf("killed pid %d (%s)", pid, name), nil
}

type processMatch struct {
	proc       *processutil.Process
	createTime int64
}

func (e *Executor) killByName(ctx context.Context, name string) (string, error) {
	if _, protected := protectedProcessNames[strings.ToLower(name)]; protected {
		return "", fmt.Errorf("kill_process: refusing to kill protected process %q", name)
	}

	procs, err := processutil.ProcessesWithContext(ctx)
	if err != nil {
		return "", fmt.Errorf("kill_process: list processes: %w", err)
	}

	var matches []processMatch
	for _, p := range procs {
		pName, err := p.NameWithContext(ctx)
		if err != nil {
			continue
		}
		if strings.EqualFold(pName, name) {
			createTime, _ := p.CreateTimeWithContext(ctx)
			matches = append(matches, processMatch{proc: p, createTime: createTime})
		}
	}

	switch len(matches) {
	case 0:
		return "", fmt.Errorf("kill_process: no running process named %q", name)
	case 1:
		return e.killVerified(ctx, matches[0], name)
	default:
		pids := make([]string, len(matches))
		for i, m := range matches {
			pids[i] = strconv.FormatInt(int64(m.proc.Pid), 10)
		}
		return "", fmt.Errorf(
			"kill_process: %d processes named %q are running (pids: %s) — retry with params.pid to pick one",
			len(matches), name, strings.Join(pids, ", "),
		)
	}
}

// killVerified re-checks the process's name and start time immediately
// before killing, right after the name-based lookup in killByName above.
// The OS can recycle a PID to an unrelated process between "list all
// processes" and "kill this PID" — re-reading both name and creation time
// by PID right before the kill narrows that window from "the whole process
// list scan" down to one syscall. It can't be closed to zero in userspace
// (that needs a kernel handle, not a re-read by PID), but a PID getting
// recycled to a same-named process with the same start-time timestamp in
// that single-syscall gap is not a realistic scenario to defend further
// against.
func (e *Executor) killVerified(ctx context.Context, m processMatch, expectedName string) (string, error) {
	freshName, err := m.proc.NameWithContext(ctx)
	if err != nil || !strings.EqualFold(freshName, expectedName) {
		return "", fmt.Errorf("kill_process: pid %d no longer matches %q (now %q) — not killing, likely pid reuse", m.proc.Pid, expectedName, freshName)
	}
	if m.createTime != 0 {
		if freshCreateTime, err := m.proc.CreateTimeWithContext(ctx); err == nil && freshCreateTime != m.createTime {
			return "", fmt.Errorf("kill_process: pid %d process identity changed since lookup — not killing, likely pid reuse", m.proc.Pid)
		}
	}
	return e.killByPID(ctx, m.proc.Pid)
}

// cleanTemp deletes the contents (not the directory itself) of one
// allowlisted directory, delegating the actual safety checks (path
// traversal, allowlist membership) to the shared internal/cleanup package
// also used by the autonomous disk self-healing monitor.
func (e *Executor) cleanTemp(params map[string]string) (string, error) {
	target := params["dir"]
	if target == "" {
		var err error
		target, err = cleanup.FirstAllowed(e.cfg.CleanTempAllowedDirs)
		if err != nil {
			return "", fmt.Errorf("clean_temp: %w", err)
		}
	}

	res, err := cleanup.Directory(e.cfg.CleanTempAllowedDirs, target)
	if err != nil {
		return "", fmt.Errorf("clean_temp: %w", err)
	}
	return res.String(), nil
}

// restartHost schedules a host restart after cfg.RestartConfirmDelay so a
// mistaken or malicious single command doesn't yank the machine out from
// under a user with zero warning. Requires params["confirm"] == "true" as a
// second, explicit signal beyond the allowlist+signature checks already
// enforced in Handle.
//
// The delay itself is tracked by the OS's own shutdown command (Windows'
// "/t <seconds>", Unix's "shutdown -r +<minutes>"), not by sleeping inside
// this process — a bare goroutine sleeping here would silently forget the
// scheduled restart if the agent service itself got stopped or crashed
// during the delay window, even though the audit log already recorded it as
// "scheduled". The OS's own delayed-shutdown mechanism survives that.
func (e *Executor) restartHost(params map[string]string) (string, error) {
	if params["confirm"] != "true" {
		return "", fmt.Errorf("restart_host: requires params.confirm == \"true\"")
	}

	delay := e.cfg.RestartConfirmDelay
	if delay <= 0 {
		delay = 30 * time.Second
	}

	cmd, err := restartCommand(delay)
	if err != nil {
		return "", fmt.Errorf("restart_host: %w", err)
	}

	e.audit.Warn().Dur("delay", delay).Msg("restart_host: scheduled via OS delayed-shutdown")

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("restart_host: failed to invoke OS restart: %w", err)
	}

	return fmt.Sprintf("restart scheduled in %s (tracked by the OS, survives agent restarts)", delay), nil
}

func restartCommand(delay time.Duration) (*exec.Cmd, error) {
	switch runtime.GOOS {
	case "windows":
		secs := int(delay.Seconds())
		if secs < 0 {
			secs = 0
		}
		return exec.Command("shutdown", "/r", "/t", strconv.Itoa(secs)), nil
	case "darwin", "linux":
		// Unix shutdown's time argument is minutes (or "now"/"hh:mm"), not
		// seconds — round up so a sub-minute delay still gets at least one
		// minute of OS-tracked warning rather than silently truncating to 0.
		mins := int((delay + time.Minute - time.Nanosecond) / time.Minute)
		if mins < 1 {
			mins = 1
		}
		return exec.Command("shutdown", "-r", fmt.Sprintf("+%d", mins)), nil
	default:
		return nil, fmt.Errorf("no restart command for GOOS=%s", runtime.GOOS)
	}
}

// shutdownHost is restartHost's counterpart for a genuine power-off — added
// after a real operator request ("shut down the device") got misread as
// restart_host, since that was previously the only whole-machine action this
// agent implemented. Reboot (restart_host) turns the machine back on by
// itself; shutdown_host powers it off and leaves it off — operationally
// different enough (someone has to physically press the power button, or
// use out-of-band remote power-on, to bring it back) that conflating the two
// is a real mistake, not just a wording difference. Same confirm-gate and
// OS-tracked-delay reasoning as restartHost applies here unchanged.
func (e *Executor) shutdownHost(params map[string]string) (string, error) {
	if params["confirm"] != "true" {
		return "", fmt.Errorf("shutdown_host: requires params.confirm == \"true\"")
	}

	delay := e.cfg.RestartConfirmDelay
	if delay <= 0 {
		delay = 30 * time.Second
	}

	cmd, err := shutdownCommand(delay)
	if err != nil {
		return "", fmt.Errorf("shutdown_host: %w", err)
	}

	e.audit.Warn().Dur("delay", delay).Msg("shutdown_host: scheduled via OS delayed-shutdown")

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("shutdown_host: failed to invoke OS shutdown: %w", err)
	}

	return fmt.Sprintf("shutdown scheduled in %s (tracked by the OS, survives agent restarts) — the device will power off and stay off", delay), nil
}

func shutdownCommand(delay time.Duration) (*exec.Cmd, error) {
	switch runtime.GOOS {
	case "windows":
		secs := int(delay.Seconds())
		if secs < 0 {
			secs = 0
		}
		return exec.Command("shutdown", "/s", "/t", strconv.Itoa(secs)), nil
	case "darwin", "linux":
		mins := int((delay + time.Minute - time.Nanosecond) / time.Minute)
		if mins < 1 {
			mins = 1
		}
		return exec.Command("shutdown", "-h", fmt.Sprintf("+%d", mins)), nil
	default:
		return nil, fmt.Errorf("no shutdown command for GOOS=%s", runtime.GOOS)
	}
}

// runScript executes a server-supplied script with no interactive window —
// this is the agent's highest-risk capability, so every layer here exists to
// keep it bounded and accountable rather than to make it more powerful:
//
//   - reachable only if "run_script" is in the local config allowlist
//     (off by default) and only after the same signature+timestamp checks
//     every other command already passed through in Handle;
//   - script body size and total execution time are hard-capped
//     (cfg.MaxScriptBytes / cfg.ScriptTimeout) and cannot be overridden by
//     the command's own params;
//   - the full script body (hashed + logged) and captured stdout/stderr
//     (truncated at cfg.MaxScriptOutputBytes) are written to audit.log for
//     every attempt, success or failure — "no window" means invisible to the
//     interactive user session, never invisible to the audit trail;
//   - the child process is spawned with CREATE_NO_WINDOW on Windows (see
//     script_windows.go), which is standard hygiene for any service that
//     shells out — Windows services already have no desktop to show a
//     window on regardless.
//
// The agent cannot vet arbitrary script *content* the way it can vet a
// fixed-shape action like kill_process — that responsibility belongs to
// whatever approval/RBAC workflow gates who can push a run_script command
// server-side. Treat enabling this action as equivalent to granting whoever
// controls that server-side workflow full SYSTEM/root access to every
// enrolled host.
func (e *Executor) runScript(ctx context.Context, cmd transport.CommandPayload) (string, error) {
	interpreter := cmd.Params["interpreter"]
	script := cmd.Params["script"]
	if script == "" {
		return "", fmt.Errorf("run_script: missing required param 'script'")
	}

	maxBytes := e.cfg.MaxScriptBytes
	if maxBytes <= 0 {
		maxBytes = 32 * 1024
	}
	if len(script) > maxBytes {
		return "", fmt.Errorf("run_script: script body %d bytes exceeds limit %d", len(script), maxBytes)
	}

	exePath, args, ext, err := scriptCommand(interpreter)
	if err != nil {
		return "", fmt.Errorf("run_script: %w", err)
	}

	hash := sha256.Sum256([]byte(script))
	scriptHash := hex.EncodeToString(hash[:])
	e.audit.Info().
		Str("command_id", cmd.ID).
		Str("interpreter", interpreter).
		Str("script_sha256", scriptHash).
		Str("script_body", script).
		Msg("run_script: content recorded prior to execution")

	tmpFile, err := writeTempScript(script, ext)
	if err != nil {
		return "", fmt.Errorf("run_script: stage script: %w", err)
	}
	defer os.Remove(tmpFile)

	timeout := e.cfg.ScriptTimeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	outLimit := e.cfg.MaxScriptOutputBytes
	if outLimit <= 0 {
		outLimit = 16 * 1024
	}

	execCmd := exec.CommandContext(runCtx, exePath, append(args, tmpFile)...)
	stdout, err := execCmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("run_script: %w", err)
	}
	execCmd.Stderr = execCmd.Stdout // a script's own error output belongs in the same stream a caller watches live
	hideWindow(execCmd)

	if err := execCmd.Start(); err != nil {
		return "", fmt.Errorf("run_script: start: %w", err)
	}

	// Streamed line-by-line via e.sendOutput as it's produced — same
	// pattern networkDiagnostic uses, and for the same reason: a
	// multi-minute install (download + silent-install a real installer)
	// left an operator with zero visibility into whether anything was
	// happening until the whole thing finished, which read indistinguishable
	// from a hung command. The dashboard's Software Deploy page parses
	// PROGRESS:/STATUS: lines a generated script emits into a progress bar;
	// any other line is just shown as raw output.
	var full strings.Builder
	truncated := false
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if full.Len() < outLimit {
			full.WriteString(line)
			full.WriteString("\n")
		} else {
			truncated = true
		}
		if e.sendOutput != nil {
			e.sendOutput(cmd.ID, line, false, "")
		}
	}

	runErr := execCmd.Wait()

	output := full.String()
	if truncated {
		output += "\n...[output truncated]"
	}

	e.audit.Info().
		Str("command_id", cmd.ID).
		Str("script_sha256", scriptHash).
		Str("output", output).
		Bool("timed_out", runCtx.Err() == context.DeadlineExceeded).
		Msg("run_script: execution finished")

	var note string
	if runCtx.Err() == context.DeadlineExceeded {
		note = fmt.Sprintf("timed out after %s", timeout)
	} else if runErr != nil {
		note = fmt.Sprintf("exited with error: %v", runErr)
	}
	if e.sendOutput != nil {
		e.sendOutput(cmd.ID, "", true, note)
	}

	if note != "" {
		return "", fmt.Errorf("run_script: %s; output: %s", note, output)
	}
	return fmt.Sprintf("script exited 0; output: %s", output), nil
}

// scriptCommand maps a requested interpreter to an executable, base args,
// and staged-file extension, restricted to a fixed set per platform — no
// arbitrary interpreter path is ever accepted from a command.
func scriptCommand(interpreter string) (exePath string, args []string, ext string, err error) {
	switch runtime.GOOS {
	case "windows":
		switch interpreter {
		case "", "powershell":
			return "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"}, ".ps1", nil
		case "cmd":
			return "cmd.exe", []string{"/C"}, ".bat", nil
		default:
			return "", nil, "", fmt.Errorf("unsupported interpreter %q on windows (allowed: powershell, cmd)", interpreter)
		}
	case "darwin", "linux":
		switch interpreter {
		case "", "bash":
			return "/bin/bash", nil, ".sh", nil
		case "sh":
			return "/bin/sh", nil, ".sh", nil
		default:
			return "", nil, "", fmt.Errorf("unsupported interpreter %q on %s (allowed: bash, sh)", interpreter, runtime.GOOS)
		}
	default:
		return "", nil, "", fmt.Errorf("run_script unsupported on GOOS=%s", runtime.GOOS)
	}
}

func writeTempScript(body, ext string) (string, error) {
	f, err := os.CreateTemp("", "optifleet-script-*"+ext)
	if err != nil {
		return "", err
	}
	path := f.Name()
	if _, err := f.WriteString(body); err != nil {
		f.Close()
		os.Remove(path)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	if err := os.Chmod(path, 0o700); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

// networkDiagnosticTools is the fixed allowlist of read-only network
// utilities this action can run — never an arbitrary command name, and
// never shell-interpreted (exec.Command below always takes the target as
// its own argv element, so even a maliciously-crafted target string can't
// break out into a second command the way string-concatenated shell input
// could).
var networkDiagnosticTools = map[string]struct{}{
	"ping":     {},
	"tracert":  {},
	"nslookup": {},
	"netstat":  {},
}

// targetPattern is deliberately permissive enough for real hostnames/IPv4/
// IPv6 (dots, colons, hyphens, underscores) while rejecting anything that
// isn't plausibly one of those. This is a sanity/abuse check, not the actual
// security boundary — exec.Command with a separate argv element already
// prevents shell injection regardless of what this string contains.
var targetPattern = regexp.MustCompile(`^[a-zA-Z0-9.:_-]{1,253}$`)

// networkDiagnostic runs one fixed, read-only network utility (ping/tracert/
// nslookup/netstat) and streams its output back line-by-line as it's
// produced via e.sendOutput, rather than making the caller wait for the
// whole thing to finish before seeing anything — a tracert to an
// unreachable host can take 15-20 seconds, and an operator watching the
// dashboard should see each hop appear as it happens, the same as if they
// ran it themselves in a terminal. Read-only by construction: nothing here
// can change device state, so — unlike kill_process/restart_host — this
// needs no destructive-action safeguards.
func (e *Executor) networkDiagnostic(ctx context.Context, commandID string, params map[string]string) (string, error) {
	tool := strings.ToLower(strings.TrimSpace(params["tool"]))
	if _, ok := networkDiagnosticTools[tool]; !ok {
		return "", fmt.Errorf("network_diagnostic: unsupported tool %q (allowed: ping, tracert, nslookup, netstat)", tool)
	}

	target := strings.TrimSpace(params["target"])
	if tool != "netstat" {
		if target == "" {
			return "", fmt.Errorf("network_diagnostic: %s requires a target hostname/IP", tool)
		}
		if !targetPattern.MatchString(target) {
			return "", fmt.Errorf("network_diagnostic: target %q doesn't look like a valid hostname/IP", target)
		}
	}

	exePath, args, timeout, err := networkDiagnosticCommand(tool, target)
	if err != nil {
		return "", fmt.Errorf("network_diagnostic: %w", err)
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	execCmd := exec.CommandContext(runCtx, exePath, args...)
	hideWindow(execCmd)
	stdout, err := execCmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("network_diagnostic: %w", err)
	}
	execCmd.Stderr = execCmd.Stdout // ping/nslookup report real failures on stderr - keep them in the same stream

	if err := execCmd.Start(); err != nil {
		return "", fmt.Errorf("network_diagnostic: start %s: %w", tool, err)
	}

	var full strings.Builder
	lineCount := 0
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		full.WriteString(line)
		full.WriteString("\n")
		lineCount++
		if e.sendOutput != nil {
			e.sendOutput(commandID, line, false, "")
		}
	}

	waitErr := execCmd.Wait()

	// A non-zero exit is normal/expected for these tools (ping against an
	// unreachable host exits non-zero, for instance) — noted in the result
	// rather than treated as this command itself having failed.
	var note string
	if runCtx.Err() == context.DeadlineExceeded {
		note = fmt.Sprintf("timed out after %s", timeout)
	} else if waitErr != nil {
		note = fmt.Sprintf("%s exited with: %v", tool, waitErr)
	}
	if e.sendOutput != nil {
		e.sendOutput(commandID, "", true, note)
	}

	result := strings.TrimRight(full.String(), "\n")
	if note != "" {
		result += "\n(" + note + ")"
	}
	if result == "" {
		result = fmt.Sprintf("%s produced no output", tool)
	}
	return result, nil
}

// networkDiagnosticCommand maps a requested tool to its OS binary, args, and
// a hard timeout — restricted to a fixed set per platform, same pattern as
// scriptCommand above. Windows is the tested path (this project's actual
// deployment target); the Unix branch is included for build-completeness
// but hasn't been exercised on real hardware.
func networkDiagnosticCommand(tool, target string) (exePath string, args []string, timeout time.Duration, err error) {
	switch runtime.GOOS {
	case "windows":
		switch tool {
		case "ping":
			return "ping.exe", []string{"-n", "4", "-w", "2000", target}, 15 * time.Second, nil
		case "tracert":
			return "tracert.exe", []string{"-d", "-w", "1000", "-h", "20", target}, 35 * time.Second, nil
		case "nslookup":
			return "nslookup.exe", []string{target}, 10 * time.Second, nil
		case "netstat":
			return "netstat.exe", []string{"-ano"}, 10 * time.Second, nil
		}
	case "darwin", "linux":
		switch tool {
		case "ping":
			return "ping", []string{"-c", "4", target}, 15 * time.Second, nil
		case "tracert":
			return "traceroute", []string{"-n", "-m", "20", "-w", "1", target}, 35 * time.Second, nil
		case "nslookup":
			return "nslookup", []string{target}, 10 * time.Second, nil
		case "netstat":
			return "netstat", []string{"-an"}, 10 * time.Second, nil
		}
	}
	return "", nil, 0, fmt.Errorf("no %s command for GOOS=%s", tool, runtime.GOOS)
}
