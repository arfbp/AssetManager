//go:build windows

// Self-install path for the single-file Windows distribution: a plain
// double-click (or running the exe with zero flags from a shell) copies
// itself into a per-user data folder, registers itself to auto-start at the
// next login, and immediately starts running and sending telemetry in the
// current process — no UAC prompt, no Windows Service, no admin rights
// needed anywhere in this path.
//
// This deliberately does NOT install a Windows Service (an earlier version
// of this file did, via self-elevation). That combination — an unsigned
// binary that elevates itself and installs a system service — is exactly
// the behavior pattern antivirus heuristics flag as a dropper/trojan, and
// on real target machines it got silently deleted moments after running,
// with zero visible error. Running directly as a normal user-level process
// and auto-starting via the per-user Run registry key avoids every part of
// that pattern. The tradeoff: it only runs while that user is logged in
// (restarting automatically at each login), not before login or across
// other users' sessions the way a real service would — see server/README.md
// if that tradeoff ever needs revisiting alongside proper code signing.
//
// Ordinary invocations are unaffected: the Service Control Manager starting
// an installed service (from the separate -service install path, still
// supported for anyone who explicitly wants real service semantics), or an
// explicit -service/-run flag, both skip this path — see shouldSelfInstall.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	kservice "github.com/kardianos/service"
	"golang.org/x/sys/windows/registry"

	"optifleet-agent/internal/config"
	"optifleet-agent/internal/logger"
)

// runKeyName is the value name under HKCU's Run key — shows up by this name
// in Task Manager's Startup tab / msconfig, same as any other ordinary
// auto-starting app; nothing here hides it.
const runKeyName = "OptiFleetAgent"

func shouldSelfInstall(svcFlag string, runForeground bool) bool {
	return kservice.Interactive() && svcFlag == "" && !runForeground
}

// alreadyElevated is unused now (kept so main.go's call site doesn't need a
// platform-specific signature) — this path never elevates.
func selfInstall(alreadyElevated bool) {
	installDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "OptiFleetAgent")
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "self-install: create install dir:", err)
		os.Exit(1)
	}

	exeSrc, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "self-install: locate own exe:", err)
		os.Exit(1)
	}
	exeDst := filepath.Join(installDir, "optifleet-agent.exe")
	if !samePath(exeSrc, exeDst) {
		data, err := os.ReadFile(exeSrc)
		if err != nil {
			fmt.Fprintln(os.Stderr, "self-install: read own exe:", err)
			os.Exit(1)
		}
		if err := os.WriteFile(exeDst, data, 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "self-install: copy exe to install dir:", err)
			os.Exit(1)
		}
	}

	certPath := filepath.Join(installDir, "optifleet-cert.pem")
	if err := os.WriteFile(certPath, embeddedCert, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "self-install: write cert:", err)
		os.Exit(1)
	}

	// The embedded config carries "__INSTALL_DIR__" placeholders (there's no
	// single fixed path to bake in at build time the way the Program
	// Files-based service install could) — backslashes doubled because
	// they're landing inside a YAML double-quoted scalar, same escaping the
	// original hardcoded paths used.
	yamlEscapedDir := strings.ReplaceAll(installDir, `\`, `\\`)
	yamlContent := strings.ReplaceAll(string(embeddedAgentYAML), "__INSTALL_DIR__", yamlEscapedDir)
	configPath := filepath.Join(installDir, "agent.yaml")
	if err := os.WriteFile(configPath, []byte(yamlContent), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "self-install: write agent.yaml:", err)
		os.Exit(1)
	}

	os.Setenv("OPTIFLEET_AUTH_TOKEN", embeddedAuthToken)
	os.Setenv("OPTIFLEET_HMAC_SECRET", embeddedHMACSecret)

	if err := registerAutostart(exeDst, configPath); err != nil {
		// Not fatal: the agent still runs right now for this session even
		// if it won't survive the next login. Surfacing this only via the
		// log file (below) rather than exiting, since running now is still
		// strictly better than not running at all.
		fmt.Fprintln(os.Stderr, "self-install: could not register autostart (will still run this session):", err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "self-install: config:", err)
		os.Exit(1)
	}
	loggers, err := logger.New(cfg.Logging)
	if err != nil {
		fmt.Fprintln(os.Stderr, "self-install: logger:", err)
		os.Exit(1)
	}

	loggers.Log.Info().Str("install_dir", installDir).Msg("self-install: running as a normal user-level process (no service, no admin)")
	runAgent(context.Background(), cfg, loggers, configPath)
}

// registerAutostart adds a per-user Run key entry — no admin rights
// required, unlike a Windows Service — so this resumes automatically the
// next time this user logs in.
func registerAutostart(exePath, configPath string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	cmd := fmt.Sprintf(`"%s" -run -config "%s"`, exePath, configPath)
	return k.SetStringValue(runKeyName, cmd)
}

func samePath(a, b string) bool {
	absA, errA := filepath.Abs(a)
	absB, errB := filepath.Abs(b)
	if errA != nil || errB != nil {
		return false
	}
	return strings.EqualFold(absA, absB)
}
