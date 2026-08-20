//go:build windows

package selfupdate

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// applyPlatform ส่งการสลับไฟล์และ restart จริง ๆ ให้ batch script เล็ก ๆ
// ที่ launch แบบ detached แทนที่จะทำ inline ตรงนี้ Windows service ที่
// กำลังรันอยู่จะถือไฟล์ .exe ของตัวเองไว้ — process นี้เขียนทับหรือลบ
// ตัวเองไม่ได้ขณะที่ยังเป็นตัวที่รันอยู่ ดังนั้นการสลับไฟล์ต้องเกิดขึ้นจาก
// ภายนอก process นี้ หลังจากที่มัน (และ service รอบตัวมัน) หยุดจริงแล้ว
// ลำดับขั้นตอน:
//  1. stop service ผ่าน nssm.exe ที่แถมมาด้วย (ปลด lock ของไฟล์)
//  2. เปลี่ยนชื่อ exe ที่กำลังรันอยู่ให้พ้นทาง (เก็บไว้เป็น .old ไม่ลบทิ้ง —
//     คนสามารถ restore กลับมาเองได้ถ้า build ใหม่พังขึ้นมา; ตอนนี้ยังไม่มี
//     automatic crash-loop rollback)
//  3. เปลี่ยนชื่อ build .new ที่ download มาให้ไปแทนที่ exe ตัวจริง
//  4. start service กลับมาใหม่ — ตอนนี้รัน build ใหม่แล้ว
//
// ฟังก์ชันนี้ return ทันทีที่สคริปต์ถูก launch ไม่รอให้การสลับไฟล์เสร็จ
// เพราะขั้นตอนที่ 1 จะหยุด process ตัวเดียวกับที่ฟังก์ชันนี้กำลังรันอยู่
func applyPlatform(exePath, newPath, serviceName string) error {
	installDir := filepath.Dir(exePath)
	nssmPath := filepath.Join(installDir, "nssm.exe")
	if _, err := os.Stat(nssmPath); err != nil {
		return fmt.Errorf("selfupdate: nssm.exe not found at %s: %w", nssmPath, err)
	}

	oldPath := exePath + ".old"
	logPath := filepath.Join(installDir, "apply-update.log")
	scriptPath := filepath.Join(installDir, "apply-update.bat")
	// `ping -n 4 127.0.0.1` เป็นตัวแทนที่ตั้งใจใช้แทน `timeout /t 3` —
	// timeout.exe จะไม่ยอมรันเลยถ้าไม่มี console ที่ attach จริง ๆ
	// ("Input redirection is not supported") ซึ่งสคริปต์นี้ไม่มี (ยืนยันแล้ว
	// บนเครื่องจริง: การสลับไฟล์ค้างเงียบ ๆ ทันทีหลังบรรทัด "stop" ทุกครั้ง
	// จนกว่าจะเปลี่ยนมาใช้ตัวนี้แทน) ping ไม่ต้องการเงื่อนไขแบบนั้น output
	// ของทุกขั้นตอนถูก append ลง apply-update.log เพื่อให้ความล้มเหลวใน
	// อนาคตทิ้งร่องรอยไว้ แทนที่จะค้างเงียบ ๆ แบบที่เคยเจอ
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

	// launch ผ่าน Task Scheduler แทนที่จะเป็น direct child process
	// (exec.Command + CreationFlags) ยืนยันแล้วบนเครื่องจริงว่าแม้แต่
	// CREATE_BREAKAWAY_FROM_JOB + CREATE_NO_WINDOW ก็ยังไม่พอ: บรรทัด
	// "nssm stop" ของสคริปต์เองตายกลางคันทุกครั้งทันทีที่ service หยุดจริง
	// ๆ NSSM (และการจัดการ stop service ของ Windows โดยทั่วไป) สามารถ
	// tear down process tree ของ service ที่กำลังหยุดได้โดยไล่ตาม
	// parent-PID โดยตรง ซึ่งไม่เกี่ยวอะไรกับ Job Objects เลย —
	// CREATE_BREAKAWAY_FROM_JOB แค่หนีออกจากการเป็นสมาชิก job เท่านั้น ไม่
	// ได้เปลี่ยนว่า OS มอง parent ของ process นี้เป็นใคร process ที่ launch
	// ผ่าน task scheduler จะมี parent เป็น Task Scheduler service เอง
	// (svchost.exe) ไม่ใช่ agent นี้เลย เลยรอดจากปัญหากลุ่มนี้ได้โดยโครงสร้าง
	// ไม่ใช่แค่หาทางเลี่ยง schtasks.exe มีมาให้ในทุกเวอร์ชัน Windows ที่
	// โปรเจกต์นี้ target — ไม่ต้องเพิ่ม dependency ใหม่
	taskName := "OptiFleetAgentSelfUpdate"
	_ = exec.Command("schtasks", "/delete", "/tn", taskName, "/f").Run() // best-effort: เคลียร์ task ค้างจากความพยายามครั้งก่อน ถ้ามี
	// ระบุ /RU SYSTEM ตรง ๆ แทนที่จะปล่อยให้ schtasks เดา account เอาจาก
	// context ของ process นี้: ยืนยันแล้วบนเครื่องจริงว่าถ้าปล่อยให้เดาจะ
	// fail ตรง ๆ ("No mapping between account names and security IDs was
	// done") เมื่อ process ที่เรียกเป็น LocalSystem service ซึ่ง install.ps1
	// ทุกตัวในโปรเจกต์นี้ตั้งไว้แบบนั้น (เป็น default ของ NSSM เอง — ดู
	// dist-agent-deploy-global/install.ps1) — ไม่มี "UserId" ปกติให้ Task
	// Scheduler resolve กลับไปเป็น LocalSystem logon ได้โดย implicit
	createArgs := []string{"/create", "/tn", taskName, "/tr", scriptPath, "/sc", "once", "/st", "23:59", "/rl", "highest", "/ru", "SYSTEM", "/f"}
	if out, err := exec.Command("schtasks", createArgs...).CombinedOutput(); err != nil {
		return fmt.Errorf("selfupdate: schtasks create failed: %w (%s)", err, string(out))
	}
	if out, err := exec.Command("schtasks", "/run", "/tn", taskName).CombinedOutput(); err != nil {
		return fmt.Errorf("selfupdate: schtasks run failed: %w (%s)", err, string(out))
	}
	return nil
}
