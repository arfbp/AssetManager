// Command agent คือเอเจนต์เก็บเทเลเมทรีและจัดการฟลีตของ OptiFleet AI
//
// วิธีใช้:
//
//	agent -service install   # ลงทะเบียนเป็น OS service ที่มีชื่อ (ต้องใช้สิทธิ์ admin/root)
//	agent -service start     # เริ่ม service ที่ติดตั้งไว้
//	agent -service stop      # หยุด service
//	agent -service uninstall # ถอนการติดตั้ง service
//	agent -run               # รันแบบ foreground เช่น เพื่อทดสอบในเครื่อง
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

	// การเรียกแบบเปล่า ๆ ไม่มี flag แบบ interactive — ดับเบิลคลิก หรือรัน exe
	// นี้จาก shell โดยไม่ใส่ argument เลย — จะ self-install ลงโฟลเดอร์ข้อมูล
	// ของ user นั้น ๆ ลงทะเบียนให้ auto-start ตอน login และเริ่มทำงานทันที
	// โดยใช้ config/cert/secrets ที่ฝังไว้ใน embed.go ทำให้ Windows
	// single-file distribution ไม่ต้องมีไฟล์อื่นอยู่ข้าง .exe เลย และไม่ต้อง
	// ขอสิทธิ์ admin ดู selfinstall_windows.go ว่าทำไม check นี้ถึงปลอดภัย
	// จากการที่ Service Control Manager เรียกใช้ service ที่ติดตั้งแล้วแบบ
	// zero-argument เหมือนกัน
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

	// ลงทะเบียน service แบบมาตรฐาน มองเห็นได้ปกติ — ไม่มีการซ่อน/เปลี่ยนชื่อ
	// ไบนารี ไม่มีการปรับ startup-type ไปจากค่า default ของ OS จะขึ้นให้เห็น
	// ใน Task Manager / services.msc / launchctl / systemctl ภายใต้ชื่อ
	// cfg.Service.Name เหมือน software อื่น ๆ ทั่วไป
	svcConfig := kservice.Config{
		Name:        cfg.Service.Name,
		DisplayName: cfg.Service.DisplayName,
		Description: cfg.Service.Description,
	}

	// มีความหมายเฉพาะตอน "install": เอา secret ที่ environment ของตัว
	// installer มีอยู่ตอนนั้นไป bake ลงใน env block ของ service เอง —
	// kardianos จะเขียนค่านี้ลงใน registry Environment value ต่อ service บน
	// Windows และลงใน EnvironmentVariables dict ของ launchd plist บน macOS
	// ไม่ว่าจะแพลตฟอร์มไหนก็เป็นการ copy ค่าแบบ static ตอน install ไม่ใช่การ
	// อ่านค่า environment ของเครื่องแบบสด ๆ ตอน service manager เริ่มทำงาน —
	// จุดหลังนี้เคยทำให้พังมาแล้ว: secret ที่ set ด้วย setx หรือ
	// [Environment]::SetEnvironmentVariable(Machine) ก่อนสั่ง "install" ไม่
	// นานจะมองไม่เห็นจาก Service Control Manager ของ Windows จนกว่าจะ reboot
	// รอบถัดไป เพราะ snapshot environment ของ SCM ถูกจับไปก่อนหน้านั้นแล้ว
	// การ bake ค่าไว้ตรงนี้เลยเลี่ยงปัญหานี้ได้ไม่ว่าแพลตฟอร์มไหน
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

	// resolve เป็น absolute path ครั้งเดียวตรงนี้: configpush ต้องใช้ path
	// นี้เป๊ะ ๆ เพื่อรู้ว่าจะเขียน agent.yaml.new ที่ไหน และไฟล์ agent.yaml
	// ตัวจริงที่กำลังจะถูกแทนที่อยู่ที่ไหน ส่วน *configPath เฉย ๆ นั้นถูกต้อง
	// ก็ต่อเมื่อ relative กับ CWD ของ process ตอน startup เท่านั้น (service
	// ที่ติดตั้งไว้จะส่ง absolute path มาให้เสมออยู่แล้ว — ดู
	// dist-agent-deploy-global/install.ps1's AppParameters — แต่ทำแบบนี้ก็
	// ช่วยให้การรันแบบ -run/ทดสอบในเครื่องถูกต้องด้วย)
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

// runAgent ต่อสาย pipeline collector -> poller -> transport -> executor
// เข้าด้วยกัน และ block อยู่จนกว่า ctx จะถูก cancel (service stop /
// foreground Ctrl-C)
func runAgent(ctx context.Context, cfg *config.Config, loggers *logger.Loggers, configPath string) {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown-host"
	}

	configHash, err := hashFile(configPath)
	if err != nil {
		// ไม่ fatal — agent ยังทำงานได้ปกติแม้ไม่มี config-push convergence
		// แค่จะไม่มี hash ให้ server เทียบ ทำให้ไม่มีวันได้รับ config_update
		// เท่านั้นเอง
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

	// ดู package doc ของ internal/selfupdate ว่าทำไมนี่ถึงเป็น trust path
	// แยกจาก exec.Handle ด้านบน (คำสั่งปกติที่ถูก dispatch) — server จะส่ง
	// self_update เองเท่านั้นตามที่เห็นสมควร (จากเวอร์ชันที่ล้าสมัยที่รายงาน
	// มาใน heartbeat ของ agent เอง) ไม่ใช่สิ่งที่ operator หรือ AI console
	// สั่งได้
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

	// เหตุผลเรื่อง isolation เดียวกันกับ SetSelfUpdateHandler ด้านบน — ดู
	// package doc ของ internal/configpush และ comment ของ
	// ConfigUpdatePayload ใน internal/transport/protocol.go
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

	// ต้องมาต่อสายตรงนี้แทนที่จะทำใน executor.New(...) ด้านบน: client เองก็
	// ต้องใช้ exec.Handle เป็น constructor argument ตอนนั้น client ยังไม่มี
	// อยู่ — ดู doc comment ของ Executor.sendOutput
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
	// ทั้งสาม loop ทำงานตาม allowlist/watch list ที่ config ไว้ในเครื่อง
	// (cfg.SelfHeal) เท่านั้น — ไม่มีส่วนไหนขยายได้ด้วยคำสั่งจากระยะไกล มันจะ
	// รายงานสิ่งที่ทำไปให้ server ในรูป "alert" message ผ่าน client.SendAlert
	// เพื่อความ visibility ล้วน ๆ ไม่มีจุดไหนรอ response จาก server ก่อนลงมือ
	// ทำ เพราะจุดประสงค์หลักคือ recover ได้เองโดยไม่ต้อง round-trip ไปหา
	// server ที่อาจจะติดต่อไม่ได้อยู่แล้ว
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

	// ต่อสายตรงนี้แทนที่จะทำใน executor.New(...) ด้านบน: executor ถูกสร้าง
	// ก่อนที่ poller จะมีอยู่ (constructor ของ poller เองก็ต้องใช้ client ซึ่ง
	// ต้องใช้ exec.Handle) — ข้อจำกัดเรื่องลำดับการสร้างเดียวกับ
	// exec.SetOutputSender ด้านบน
	exec.SetStateChangeNotifier(poller.TriggerNow)

	poller.Run(ctx) // block ไว้จนกว่า ctx จะถูก cancel
}

// heartbeatLoop ส่งสัญญาณ liveness แบบเบา ๆ ตามรอบเวลาที่ตายตัว โดยไม่
// เกี่ยวกับการสลับโหมด normal/alert ของ telemetry poller
//
// heartbeat แรกจะยิงทันทีแทนที่จะรอ tick เต็มรอบ เรื่องนี้สำคัญกว่าแค่เรื่อง
// liveness: server จะรู้จัก agent ที่เพิ่ง connect เข้ามา (เรียนรู้
// agent_id ของมัน) จาก heartbeat แรก หรือ telemetry message แรกที่ได้รับ
// แต่ TelemetryPayload ไม่มี agent_id ของตัวเองเลย มีแต่ HeartbeatPayload
// เท่านั้นที่มี ส่วน poller จะส่ง snapshot แรกทันทีตอน connect
// (internal/telemetry.Poller ใช้ time.NewTimer(0)) ดังนั้นถ้าไม่มี
// heartbeat แรกที่ยิงทันทีเหมือนกัน telemetry message แรกนั้นแทบจะชนะการ
// แข่งขันเสมอและมาถึงก่อนที่ heartbeat ไหนจะระบุตัวตนของ connection ได้ —
// server จะไม่มีอะไรให้ key แล้วก็ drop มันทิ้ง ทำให้ agent มองไม่เห็นจน
// กว่า heartbeat รอบถัดไปอีกนาทีจะมาถึง
// hashFile คืนค่า hex SHA256 ของไบต์ดิบในไฟล์ path — ใช้ตรวจ config drift
// จากไฟล์ desired-config ของ server เอง ดู doc comment ของ ConfigHash ใน
// internal/transport/protocol.go
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
