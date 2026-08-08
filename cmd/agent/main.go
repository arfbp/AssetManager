// Command agent is the OptiFleet AI fleet telemetry & management agent.
//
// Usage:
//
//	agent -service install   # register as a named OS service (requires admin/root)
//	agent -service start     # start the installed service
//	agent -service stop      # stop it
//	agent -service uninstall # remove it
//	agent -run               # run in the foreground, e.g. for local testing
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	kservice "github.com/kardianos/service"

	"optifleet-agent/internal/config"
	"optifleet-agent/internal/configpush"
	"optifleet-agent/internal/executor"
	"optifleet-agent/internal/logger"
	"optifleet-agent/internal/selfheal"
	"optifleet-agent/internal/selfupdate"
	"optifleet-agent/internal/svc"
	"optifleet-agent/internal/telemetry"
	"optifleet-agent/internal/transport"
	"optifleet-agent/internal/version"
)

func main() {
	svcFlag := flag.String("service", "", "control the OS service: install, uninstall, start, stop, restart")
	runForeground := flag.Bool("run", false, "run in the foreground instead of via the service manager (for local testing)")
	configPath := flag.String("config", "configs/agent.yaml", "path to agent YAML config")
	flag.Parse()

	// A bare, interactive, flag-less invocation — a double-click, or running
	// this exe from a shell with no arguments — self-installs into a
	// per-user data folder, registers itself to auto-start at login, and
	// starts running immediately, using the config/cert/secrets embedded in
	// embed.go, so the Windows single-file distribution needs nothing
	// alongside the .exe and never requests admin rights. See
	// selfinstall_windows.go for why this check is safe against the Service
	// Control Manager's own zero-argument invocation of an installed service.
	if shouldSelfInstall(*svcFlag, *runForeground) {
		selfInstall(false)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}

	loggers, err := logger.New(cfg.Logging)
	if err != nil {
		fmt.Fprintln(os.Stderr, "logger error:", err)
		os.Exit(1)
	}

	// Visible, standard service registration — no hidden/renamed binary
	// tricks, no startup-type manipulation beyond the OS default. It will
	// show up in Task Manager / services.msc / launchctl / systemctl under
	// cfg.Service.Name like any other managed software.
	svcConfig := kservice.Config{
		Name:        cfg.Service.Name,
		DisplayName: cfg.Service.DisplayName,
		Description: cfg.Service.Description,
	}

	// Only meaningful for "install": bakes whatever secrets the installer's
	// own environment currently has into the service's own env block —
	// kardianos writes this into a per-service registry Environment value on
	// Windows, and into the launchd plist's EnvironmentVariables dict on
	// macOS. Either way it's a static copy taken at install time, not a live
	// read of the machine environment when the service manager itself
	// starts — the latter is what bit us before: a secret set with setx /
	// [Environment]::SetEnvironmentVariable(Machine) right before "install"
	// is invisible to Windows' Service Control Manager until the next
	// reboot, because SCM's own environment snapshot predates it. Baking
	// the value in here sidesteps that regardless of platform.
	if *svcFlag == "install" {
		svcConfig.EnvVars = map[string]string{}
		if v := os.Getenv(cfg.Server.AuthTokenEnvVar); v != "" {
			svcConfig.EnvVars[cfg.Server.AuthTokenEnvVar] = v
		}
		if cfg.Server.HMACSecretEnv != "" {
			if v := os.Getenv(cfg.Server.HMACSecretEnv); v != "" {
				svcConfig.EnvVars[cfg.Server.HMACSecretEnv] = v
			}
		}
	}

	// Resolved to an absolute path once here: configpush needs this exact
	// path to know where to write agent.yaml.new and where the live
	// agent.yaml it's replacing lives, and *configPath alone is only
	// guaranteed correct relative to whatever the process's CWD was at
	// startup (the installed service always passes an absolute path — see
	// dist-agent-deploy-global/install.ps1's AppParameters — but this keeps
	// -run/local-testing invocations correct too).
	absConfigPath, err := filepath.Abs(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config path error:", err)
		os.Exit(1)
	}

	runFunc := func(ctx context.Context) {
		runAgent(ctx, cfg, loggers, absConfigPath)
	}

	if *runForeground {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		loggers.Log.Info().Msg("agent: running in foreground mode")
		runFunc(ctx)
		return
	}

	svcInstance, err := svc.New(svcConfig, loggers.Log, runFunc)
	if err != nil {
		fmt.Fprintln(os.Stderr, "service init error:", err)
		os.Exit(1)
	}

	if *svcFlag != "" {
		if err := kservice.Control(svcInstance, *svcFlag); err != nil {
			fmt.Fprintf(os.Stderr, "service control %q failed: %v\n", *svcFlag, err)
			os.Exit(1)
		}
		fmt.Printf("service %s: %s OK\n", cfg.Service.Name, *svcFlag)
		return
	}

	if err := svcInstance.Run(); err != nil {
		loggers.Log.Error().Err(err).Msg("agent: service run exited with error")
		os.Exit(1)
	}
}

// runAgent wires the collector -> poller -> transport -> executor pipeline
// and blocks until ctx is cancelled (service stop / foreground Ctrl-C).
func runAgent(ctx context.Context, cfg *config.Config, loggers *logger.Loggers, configPath string) {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown-host"
	}

	configHash, err := hashFile(configPath)
	if err != nil {
		// Not fatal — the agent still runs fine without config-push
		// convergence, it just never reports a hash the server can compare
		// against, so it'll simply never receive a config_update.
		loggers.Log.Warn().Err(err).Str("path", configPath).Msg("configpush: could not hash own config file, disabling config-push for this run")
	}

	exec := executor.New(executor.Config{
		AllowedActions:       cfg.AllowedSet(),
		HMACSecret:           cfg.Server.HMACSecret,
		CleanTempAllowedDirs: cfg.Commands.CleanTempAllowedDirs,
		RestartConfirmDelay:  cfg.Commands.RestartConfirmDelay,
		ScriptTimeout:        cfg.Commands.ScriptTimeout,
		MaxScriptBytes:       cfg.Commands.MaxScriptBytes,
		MaxScriptOutputBytes: cfg.Commands.MaxScriptOutputBytes,
	}, loggers.Log, loggers.Audit)

	client := transport.NewClient(transport.Config{
		URL:            cfg.Server.URL,
		ClientCertPath: cfg.Server.ClientCertPath,
		ClientKeyPath:  cfg.Server.ClientKeyPath,
		CACertPath:     cfg.Server.CACertPath,
		AuthToken:      cfg.Server.AuthToken,
		AgentID:        hostname,
		Version:        version.Version,
		ConfigHash:     configHash,
	}, loggers.Log, exec.Handle)

	// See internal/selfupdate's package doc for why this is a separate trust
	// path from exec.Handle above (ordinary dispatched commands) — the
	// server only ever sends a self_update on its own initiative (an
	// outdated version reported in this agent's own heartbeat), never as
	// something an operator or the AI console can trigger.
	client.SetSelfUpdateHandler(func(ctx context.Context, payload transport.SelfUpdatePayload) {
		err := selfupdate.Apply(ctx, selfupdate.Config{
			HMACSecret:     cfg.Server.HMACSecret,
			CurrentVersion: version.Version,
			ServiceName:    cfg.Service.Name,
			AuthToken:      cfg.Server.AuthToken,
			CACertPath:     cfg.Server.CACertPath,
		}, payload, loggers.Log)
		if err != nil {
			loggers.Log.Error().Err(err).Str("version", payload.Version).Msg("selfupdate: failed")
		}
	})

	// Same isolation reasoning as SetSelfUpdateHandler above — see
	// internal/configpush's package doc and ConfigUpdatePayload's comment in
	// internal/transport/protocol.go.
	client.SetConfigUpdateHandler(func(ctx context.Context, payload transport.ConfigUpdatePayload) {
		err := configpush.Apply(configpush.Config{
			HMACSecret:  cfg.Server.HMACSecret,
			CurrentHash: configHash,
			ConfigPath:  configPath,
			ServiceName: cfg.Service.Name,
		}, payload, loggers.Log)
		if err != nil {
			loggers.Log.Error().Err(err).Msg("configpush: failed")
		}
	})

	// Wired up here rather than at executor.New(...) above: the client
	// itself needs exec.Handle as a constructor argument, so it can't exist
	// yet at that point — see Executor.sendOutput's own doc comment.
	exec.SetOutputSender(func(commandID, line string, done bool, errMsg string) {
		client.SendCommandOutput(transport.CommandOutputPayload{
			CommandID: commandID,
			Line:      line,
			Done:      done,
			Error:     errMsg,
		})
	})

	go client.Run(ctx)
	go heartbeatLoop(ctx, client)

	// --- Self-Healing Engine ---
	// All three loops act only on the locally-configured allowlist/watch
	// list in cfg.SelfHeal — none of it is expandable by a remote command.
	// They report what they did to the server as "alert" messages via
	// client.SendAlert, purely for visibility; nothing here waits on a
	// server response before acting, since the whole point is to recover
	// without round-tripping to a possibly-unreachable server.
	watchdog := selfheal.NewServiceWatchdog(selfheal.ServiceWatchdogConfig{
		Services:           cfg.SelfHeal.Services.Watch,
		CheckInterval:      cfg.SelfHeal.Services.CheckInterval,
		MaxRestartsPerHour: cfg.SelfHeal.Services.MaxRestartsPerHour,
	}, selfheal.NewServiceController(), loggers.Log, loggers.Audit, func(e selfheal.Event) {
		client.SendAlert(transport.AlertPayload{
			Kind:      "service_watchdog." + e.Action,
			Message:   e.Detail,
			Fields:    map[string]string{"service": e.Target},
			Timestamp: time.Now().Unix(),
		})
	})
	go watchdog.Run(ctx)

	diskCleaner := selfheal.NewDiskCleaner(selfheal.DiskCleanupConfig{
		FreeThresholdPercent: cfg.SelfHeal.DiskCleanup.FreeThresholdPercent,
		AllowedDirs:          cfg.Commands.CleanTempAllowedDirs,
		Cooldown:             cfg.SelfHeal.DiskCleanup.Cooldown,
	}, loggers.Log, loggers.Audit, func(e selfheal.Event) {
		client.SendAlert(transport.AlertPayload{
			Kind:      "disk_cleanup." + e.Action,
			Message:   e.Detail,
			Fields:    map[string]string{"dir": e.Target},
			Timestamp: time.Now().Unix(),
		})
	})

	memMonitor := selfheal.NewMemoryMonitor(selfheal.LeakConfig{
		GrowthThresholdMB: cfg.SelfHeal.MemoryLeak.GrowthThresholdMB,
		MinSamples:        cfg.SelfHeal.MemoryLeak.MinSamples,
	}, loggers.Log, loggers.Audit, func(e selfheal.LeakEvent) {
		client.SendAlert(transport.AlertPayload{
			Kind:    "memory_leak_suspected",
			Message: fmt.Sprintf("%s (pid %d) grew %.0fMB -> %.0fMB over %d samples", e.Name, e.PID, e.StartMB, e.CurrentMB, e.Samples),
			Fields: map[string]string{
				"pid":            fmt.Sprint(e.PID),
				"process":        e.Name,
				"trim_attempted": fmt.Sprint(e.TrimAttempted),
				"trim_error":     e.TrimError,
			},
			Timestamp: time.Now().Unix(),
		})
	})

	poller := telemetry.NewPoller(telemetry.PollerConfig{
		NormalInterval: cfg.Polling.NormalInterval,
		AlertInterval:  cfg.Polling.AlertInterval,
		CPUThreshold:   cfg.Polling.CPUAlertThreshold,
		MemThreshold:   cfg.Polling.MemAlertThreshold,
		RecoveryStreak: cfg.Polling.RecoveryStreak,
		TopNProcesses:  cfg.Polling.TopNProcesses,
	}, loggers.Log, func(snap telemetry.Snapshot) {
		client.SendTelemetry(transport.TelemetryPayload{Snapshot: snap})
		diskCleaner.Observe(snap)
		memMonitor.Observe(snap)
	})

	// Wired here rather than at executor.New(...) above: the executor is
	// constructed before the poller exists (the poller's own constructor
	// needs the client, which itself needs exec.Handle) — same ordering
	// constraint as exec.SetOutputSender above.
	exec.SetStateChangeNotifier(poller.TriggerNow)

	poller.Run(ctx) // blocks until ctx is cancelled
}

// heartbeatLoop sends a lightweight liveness signal on a fixed cadence,
// independent of the telemetry poller's normal/alert mode switching.
//
// The first heartbeat fires immediately rather than waiting a full tick.
// This matters beyond liveness: the server identifies a freshly-connected
// agent (learns its agent_id) from the first heartbeat OR telemetry message
// it receives, but a TelemetryPayload carries no agent_id of its own — only
// HeartbeatPayload does. The poller sends its first snapshot immediately on
// connect (internal/telemetry.Poller uses time.NewTimer(0)), so without an
// equally-immediate first heartbeat, that first telemetry message would
// almost always win the race and arrive before any heartbeat has
// identified the connection — the server has nothing to key it on and
// drops it, leaving the agent invisible until a minute-later heartbeat
// finally arrives.
// hashFile returns a hex SHA256 of path's raw bytes — used to detect config
// drift from the server's own desired-config file, see ConfigHash's doc
// comment in internal/transport/protocol.go.
func hashFile(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func heartbeatLoop(ctx context.Context, client *transport.Client) {
	client.SendHeartbeat()

	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			client.SendHeartbeat()
		}
	}
}
