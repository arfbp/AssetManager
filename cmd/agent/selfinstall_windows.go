//go:build windows

// Path การ self-install สำหรับ single-file distribution บน Windows: แค่
// ดับเบิลคลิกเฉย ๆ (หรือรัน exe แบบไม่มี flag จาก shell) จะ copy ตัวเองลง
// โฟลเดอร์ข้อมูลของ user นั้น ลงทะเบียนให้ auto-start ตอน login ครั้งถัดไป
// และเริ่มทำงานพร้อมส่ง telemetry ทันทีใน process ปัจจุบัน — ไม่มี UAC
// prompt ไม่มี Windows Service ไม่ต้องใช้สิทธิ์ admin เลยตลอด path นี้
//
// ตั้งใจไม่ install เป็น Windows Service (โค้ดเวอร์ชันก่อนหน้าทำแบบนั้น
// ผ่านการ self-elevate) เพราะการรวมกันแบบนั้น — ไบนารีที่ไม่ได้ sign ที่
// elevate ตัวเองแล้ว install system service — เป็น pattern พฤติกรรมที่
// antivirus heuristics มักจะ flag ว่าเป็น dropper/trojan พอดี และบนเครื่อง
// จริงมันถูกลบทิ้งเงียบ ๆ ไม่กี่วินาทีหลังรัน โดยไม่มี error ให้เห็นเลย การ
// รันตรง ๆ แบบ process ระดับ user ธรรมดา แล้ว auto-start ผ่าน per-user Run
// registry key จะเลี่ยง pattern นั้นได้ทั้งหมด ข้อแลกเปลี่ยนคือ: มันจะรัน
// เฉพาะตอนที่ user คนนั้น login อยู่เท่านั้น (restart อัตโนมัติทุกครั้งที่
// login) ไม่ได้รันก่อน login หรือข้าม session ของ user คนอื่นเหมือน service
// จริง ๆ — ดู server/README.md ถ้าวันไหนต้องมาทบทวน tradeoff นี้อีกครั้ง
// พร้อมกับเรื่อง code signing ที่ถูกต้อง
//
// การเรียกใช้ปกติไม่ได้รับผลกระทบ: ทั้ง Service Control Manager ที่สั่ง
// service ที่ติดตั้งไว้ (จาก path -service install แยกต่างหาก ที่ยังรองรับ
// อยู่สำหรับใครที่อยากได้ semantics ของ service จริง ๆ) หรือการใส่ flag
// -service/-run ตรง ๆ ทั้งคู่จะข้าม path นี้ไป — ดู shouldSelfInstall
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

// runKeyName คือชื่อ value ภายใต้ Run key ของ HKCU — จะขึ้นชื่อนี้ใน
// Startup tab ของ Task Manager / msconfig เหมือน app auto-start ทั่วไป
// ไม่มีการซ่อนอะไรตรงนี้เลย
const runKeyName = "OptiFleetAgent"

func shouldSelfInstall(svcFlag string, runForeground bool) bool {
	return kservice.Interactive() && svcFlag == "" && !runForeground
}

// alreadyElevated ตอนนี้ไม่ได้ใช้แล้ว (เก็บไว้เพื่อให้ call site ใน main.go
// ไม่ต้องมี signature เฉพาะแพลตฟอร์ม) — path นี้ไม่มีการ elevate เลย
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

	// config ที่ฝังไว้มี placeholder "__INSTALL_DIR__" อยู่ (ไม่มี path
	// ตายตัวเดียวให้ bake ตอน build ได้เหมือนตอน install แบบ service ที่ใช้
	// Program Files) — ต้อง double backslash เพราะมันไปอยู่ใน YAML
	// double-quoted scalar เป็นการ escape แบบเดียวกับที่ path hardcode เดิม
	// เคยใช้
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
		// ไม่ fatal: agent ยังรันได้ปกติใน session นี้ แม้จะไม่รอดถึง login
		// ครั้งถัดไป แค่ log ไว้ (ด้านล่าง) ไม่ต้อง exit เพราะรันตอนนี้ก็ยังดี
		// กว่าไม่รันเลย
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

// registerAutostart เพิ่ม entry ใน per-user Run key — ไม่ต้องใช้สิทธิ์
// admin ต่างจาก Windows Service — ทำให้ทำงานต่อได้อัตโนมัติเมื่อ user คนนี้
// login ครั้งถัดไป
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
