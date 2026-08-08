//go:build windows

package selfupdate

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// applyPlatform hands the actual file-swap-and-restart off to a small
// batch script, launched detached, rather than doing it inline here. A
// running Windows service holds its own .exe file open — this process
// cannot overwrite or delete itself while it's still the one running, so
// the swap has to happen from OUTSIDE this process, after it (and the
// service around it) has actually stopped. The sequence:
//  1. stop the service via the bundled nssm.exe (releases the file lock)
//  2. rename the running exe out of the way (kept as .old, not deleted —
//     a human can restore it by hand if the new build turns out broken;
//     there's no automatic crash-loop rollback here yet)
//  3. rename the downloaded .new build into the real exe's place
//  4. start the service again — now running the new build
//
// This function returns as soon as the script is launched; it does not
// wait for the swap to finish, since step 1 stops the very process this
// function is running in.
func applyPlatform(exePath, newPath, serviceName string) error {
	installDir := filepath.Dir(exePath)
	nssmPath := filepath.Join(installDir, "nssm.exe")
	if _, err := os.Stat(nssmPath); err != nil {
		return fmt.Errorf("selfupdate: nssm.exe not found at %s: %w", nssmPath, err)
	}

	oldPath := exePath + ".old"
	logPath := filepath.Join(installDir, "apply-update.log")
	scriptPath := filepath.Join(installDir, "apply-update.bat")
	// `ping -n 4 127.0.0.1` is a deliberate substitute for `timeout /t 3` —
	// timeout.exe refuses to run at all without a real attached console
	// ("Input redirection is not supported"), which this script doesn't
	// have (verified on real hardware: the swap silently stalled right
	// after the "stop" line, every time, until this was swapped in). ping
	// has no such requirement. Every step's own output is appended to
	// apply-update.log so a future failure leaves a trail instead of a
	// silent stuck state like this one.
	script := fmt.Sprintf(`@echo off
echo [%%date%% %%time%%] starting update > "%s"
"%s" stop %s >> "%s" 2>&1
ping -n 4 127.0.0.1 >nul
del /f /q "%s" 2>>"%s"
move /y "%s" "%s" >>"%s" 2>&1
move /y "%s" "%s" >>"%s" 2>&1
"%s" start %s >> "%s" 2>&1
echo [%%date%% %%time%%] update finished >> "%s"
schtasks /delete /tn OptiFleetAgentSelfUpdate /f >nul 2>&1
del "%%~f0"
`, logPath,
		nssmPath, serviceName, logPath,
		oldPath, logPath,
		exePath, oldPath, logPath,
		newPath, exePath, logPath,
		nssmPath, serviceName, logPath,
		logPath)

	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		return fmt.Errorf("selfupdate: write updater script: %w", err)
	}

	// Launched via the Task Scheduler rather than as a direct child process
	// (exec.Command + CreationFlags). Verified on real hardware that even
	// CREATE_BREAKAWAY_FROM_JOB + CREATE_NO_WINDOW wasn't enough: the
	// script's own "nssm stop" line reliably died mid-command the instant
	// the service actually stopped, every time. NSSM (and Windows service
	// stop handling generally) can tear down a stopping service's process
	// tree by walking parent-PID relationships directly, which has nothing
	// to do with Job Objects — CREATE_BREAKAWAY_FROM_JOB only escapes job
	// membership, it doesn't change who the OS considers this process's
	// parent. A task-scheduler-launched process's parent is the Task
	// Scheduler service itself (svchost.exe), never this agent, so it's
	// structurally immune to that class of problem rather than working
	// around it. schtasks.exe has shipped on every Windows version this
	// project targets — no extra dependency.
	taskName := "OptiFleetAgentSelfUpdate"
	_ = exec.Command("schtasks", "/delete", "/tn", taskName, "/f").Run() // best-effort: clear a stale task from a previous attempt, if any
	// /RU SYSTEM explicitly, rather than leaving schtasks to infer the
	// account from this process's own context: verified on real hardware
	// that letting it infer fails outright ("No mapping between account
	// names and security IDs was done") when the calling process is a
	// LocalSystem service, which every install.ps1 in this project sets up
	// (NSSM's own default — see dist-agent-deploy-global/install.ps1) —
	// there's no ordinary "UserId" for Task Scheduler to resolve a
	// LocalSystem logon back to implicitly.
	createArgs := []string{"/create", "/tn", taskName, "/tr", scriptPath, "/sc", "once", "/st", "23:59", "/rl", "highest", "/ru", "SYSTEM", "/f"}
	if out, err := exec.Command("schtasks", createArgs...).CombinedOutput(); err != nil {
		return fmt.Errorf("selfupdate: schtasks create failed: %w (%s)", err, string(out))
	}
	if out, err := exec.Command("schtasks", "/run", "/tn", taskName).CombinedOutput(); err != nil {
		return fmt.Errorf("selfupdate: schtasks run failed: %w (%s)", err, string(out))
	}
	return nil
}
