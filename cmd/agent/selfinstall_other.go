//go:build !windows

// flow self-install แบบ single-file (selfinstall_windows.go) มีเฉพาะบน
// Windows เท่านั้น — การ deploy บน macOS ยังคงผ่าน
// dist-agent-deploy-macos/install.sh เหมือนเดิม stub พวกนี้แค่ทำให้
// shouldSelfInstall ไม่ทำงานบนแพลตฟอร์มอื่น พฤติกรรมเดิมของ main() ยังคง
// เหมือนเดิมทุกอย่าง
package main

func shouldSelfInstall(svcFlag string, runForeground bool) bool { return false }

func selfInstall(alreadyElevated bool) {}
