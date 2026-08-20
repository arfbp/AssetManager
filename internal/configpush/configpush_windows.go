//go:build windows

package configpush

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// runScriptEnvLine คือบรรทัด env-var ตัวเดียวที่ package นี้จะเพิ่มเข้าไปใน
// environment ของ service ดู doc comment ของ ConfigUpdatePayload ใน
// internal/transport/protocol.go ว่าทำไมนี่ถึงเป็นค่าตายตัวแทนที่จะเป็นค่าที่
// server ส่งมาแล้วเอาไปแปะใน batch script ที่ generate ขึ้น
const runScriptEnvLine = "OPTIFLEET_ENABLE_RUN_SCRIPT=true"

// applyPlatform สลับ agent.yaml ตัวใหม่เข้าไป และถ้า enableRunScript ถูก set
// ไว้ จะเพิ่ม runScriptEnvLine เข้าไปใน AppEnvironmentExtra ของ NSSM ของ
// service — ผ่าน pattern เดียวกับ batch-script ที่ยิงผ่าน Task Scheduler
// เหมือน applyPlatform ของ internal/selfupdate_windows.go และด้วยเหตุผล
// เดียวกันเป๊ะ ๆ (service ที่กำลังรันอยู่จะถือไฟล์ค้างไว้ / tree-kill
// child process ตรงของมันทันทีที่ตัว service หยุด; ดู doc comment ของไฟล์
// นั้นสำหรับบั๊กจริงสองตัวที่ pattern นี้ถูกสร้างมาเพื่อเลี่ยง)
//
// AppEnvironmentExtra เป็น NSSM parameter แบบ multi-value (REG_MULTI_SZ)
// และ `nssm set` จะ REPLACE ค่าทั้งหมดแทนที่จะ append — ดังนั้นค่าเดิมที่มี
// อยู่ (OPTIFLEET_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET ของ agent เองที่ set
// ไว้ตอน install) จะถูกอ่านกลับมาตรงนี้แล้ว merge ใน Go ก่อนที่จะเอาไปแปะ
// ในสคริปต์ที่ generate ขึ้น แทนที่จะเสี่ยงให้ batch script ไป clobber
// ทับค่าเดิม
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
	// nssm set <service> AppEnvironmentExtra รับ KEY=VALUE หนึ่งค่าต่อหนึ่ง
	// argument — แต่ละอันจะกลายเป็นหนึ่งบรรทัดใน multi-value ที่เก็บไว้ ทุก
	// ค่าตรงนี้มาจาก secret ตอน install ของเครื่องนี้เอง หรือค่าตายตัว
	// runScriptEnvLine ด้านบนเท่านั้น ไม่เคยมาจาก text ที่ server ส่งมาตรง ๆ
	// เลย การส่งเป็น argument แยกกันใน batch script เลยไม่มีความเสี่ยงเรื่อง
	// injection
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

	// เหตุผลเรื่องยิงผ่าน schtasks เดียวกับ internal/selfupdate_windows.go:
	// child process ตรงของ agent นี้จะถูกทำลายทิ้งทันทีที่ "nssm stop" หยุด
	// service จริง ๆ (ยืนยันแล้วบนเครื่องจริง) ไม่ว่าจะมี
	// CREATE_BREAKAWAY_FROM_JOB หรือไม่ก็ตาม — มีแต่ process ที่มี parent
	// เป็นตัว Task Scheduler service เองเท่านั้นที่รอดจากเรื่องนี้โดยโครงสร้าง
	// ต้องการ /ru SYSTEM เหมือนกันด้วย: agent นี้รันเป็น LocalSystem ซึ่ง
	// schtasks resolve account context แบบ implicit ให้ไม่ได้
	taskName := "OptiFleetAgentConfigPush"
	_ = exec.Command("schtasks", "/delete", "/tn", taskName, "/f").Run() // best-effort: เคลียร์ task ค้างจากความพยายามครั้งก่อน ถ้ามี
	createArgs := []string{"/create", "/tn", taskName, "/tr", scriptPath, "/sc", "once", "/st", "23:59", "/rl", "highest", "/ru", "SYSTEM", "/f"}
	if out, err := exec.Command("schtasks", createArgs...).CombinedOutput(); err != nil {
		return fmt.Errorf("configpush: schtasks create failed: %w (%s)", err, string(out))
	}
	if out, err := exec.Command("schtasks", "/run", "/tn", taskName).CombinedOutput(); err != nil {
		return fmt.Errorf("configpush: schtasks run failed: %w (%s)", err, string(out))
	}
	return nil
}

// currentEnvExtra อ่าน AppEnvironmentExtra เดิมของ service นี้กลับมา (nssm
// get พิมพ์ค่าออกมาบรรทัดละหนึ่งค่า หรือไม่พิมพ์อะไรเลยถ้ายังไม่ได้ set)
// เพื่อให้ applyPlatform merge เข้าไปได้แทนที่จะเขียนทับ
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
