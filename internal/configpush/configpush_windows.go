//go:build windows

package configpush

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// runScriptEnvLine is the one literal env-var line this package will ever
// add to a service's environment — see ConfigUpdatePayload's doc comment in
// internal/transport/protocol.go for why this is a fixed literal rather than
// a server-supplied value spliced into the generated batch script.
const runScriptEnvLine = "OPTIFLEET_ENABLE_RUN_SCRIPT=true"

// applyPlatform swaps in the new agent.yaml and, if enableRunScript is set,
// adds runScriptEnvLine to the service's NSSM AppEnvironmentExtra — via the
// same Task-Scheduler-launched batch-script pattern as
// internal/selfupdate_windows.go's applyPlatform, and for the exact same
// reasons (a running service holds files open / can tree-kill a direct
// child the instant it stops; see that file's doc comments for the two real
// bugs that pattern was built to route around).
//
// AppEnvironmentExtra is a multi-value (REG_MULTI_SZ) NSSM parameter, and
// `nssm set` REPLACES it wholesale rather than appending — so the existing
// values (this agent's own OPTIFLEET_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET,
// set at install time) are read back here and merged in Go, before they're
// baked into the generated script, rather than risking a batch script
// clobbering them.
func applyPlatform(configPath, newConfigPath, serviceName string, enableRunScript bool) error {
	installDir := filepath.Dir(configPath)
	nssmPath := filepath.Join(installDir, "nssm.exe")
	if _, err := os.Stat(nssmPath); err != nil {
		return fmt.Errorf("configpush: nssm.exe not found at %s: %w", nssmPath, err)
	}

	envLines, err := currentEnvExtra(nssmPath, serviceName)
	if err != nil {
		return err
	}
	if enableRunScript && !containsLine(envLines, runScriptEnvLine) {
		envLines = append(envLines, runScriptEnvLine)
	}
	// nssm set <service> AppEnvironmentExtra takes one KEY=VALUE per
	// argument — each becomes one line of the stored multi-value. Every
	// value here originates from either this machine's own install-time
	// secrets or the fixed runScriptEnvLine literal above, never directly
	// from server-supplied text, so passing them as separate batch-script
	// arguments carries no injection risk.
	envArgs := strings.Join(envLines, " ")

	oldPath := configPath + ".old"
	logPath := filepath.Join(installDir, "apply-config.log")
	scriptPath := filepath.Join(installDir, "apply-config.bat")
	script := fmt.Sprintf(`@echo off
echo [%%date%% %%time%%] starting config update > "%s"
"%s" stop %s >> "%s" 2>&1
ping -n 4 127.0.0.1 >nul
del /f /q "%s" 2>>"%s"
move /y "%s" "%s" >>"%s" 2>&1
move /y "%s" "%s" >>"%s" 2>&1
"%s" set %s AppEnvironmentExtra %s >> "%s" 2>&1
"%s" start %s >> "%s" 2>&1
echo [%%date%% %%time%%] config update finished >> "%s"
schtasks /delete /tn OptiFleetAgentConfigPush /f >nul 2>&1
del "%%~f0"
`, logPath,
		nssmPath, serviceName, logPath,
		oldPath, logPath,
		configPath, oldPath, logPath,
		newConfigPath, configPath, logPath,
		nssmPath, serviceName, envArgs, logPath,
		nssmPath, serviceName, logPath,
		logPath)

	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		return fmt.Errorf("configpush: write updater script: %w", err)
	}

	// Same schtasks-launch reasoning as internal/selfupdate_windows.go: a
	// direct child process of this agent gets torn down the instant "nssm
	// stop" actually stops the service (verified there on real hardware),
	// regardless of CREATE_BREAKAWAY_FROM_JOB — only a process whose parent
	// is the Task Scheduler service itself is structurally immune. Same
	// /ru SYSTEM requirement too: this agent runs as LocalSystem, which
	// schtasks cannot resolve an implicit account context for.
	taskName := "OptiFleetAgentConfigPush"
	_ = exec.Command("schtasks", "/delete", "/tn", taskName, "/f").Run() // best-effort: clear a stale task from a previous attempt, if any
	createArgs := []string{"/create", "/tn", taskName, "/tr", scriptPath, "/sc", "once", "/st", "23:59", "/rl", "highest", "/ru", "SYSTEM", "/f"}
	if out, err := exec.Command("schtasks", createArgs...).CombinedOutput(); err != nil {
		return fmt.Errorf("configpush: schtasks create failed: %w (%s)", err, string(out))
	}
	if out, err := exec.Command("schtasks", "/run", "/tn", taskName).CombinedOutput(); err != nil {
		return fmt.Errorf("configpush: schtasks run failed: %w (%s)", err, string(out))
	}
	return nil
}

// currentEnvExtra reads back this service's existing AppEnvironmentExtra
// (nssm get prints one value per line, or nothing if unset) so applyPlatform
// can merge into it rather than overwrite it.
func currentEnvExtra(nssmPath, serviceName string) ([]string, error) {
	out, err := exec.Command(nssmPath, "get", serviceName, "AppEnvironmentExtra").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("configpush: nssm get AppEnvironmentExtra: %w (%s)", err, string(out))
	}
	var lines []string
	for _, raw := range strings.Split(string(out), "\n") {
		line := strings.TrimSpace(raw)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines, nil
}

func containsLine(lines []string, target string) bool {
	for _, l := range lines {
		if strings.EqualFold(l, target) {
			return true
		}
	}
	return false
}
