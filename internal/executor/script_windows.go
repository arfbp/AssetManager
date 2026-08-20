//go:build windows

package executor

import (
	"os/exec"
	"syscall"
)

// hideWindow ทำให้ script process ที่ spawn ขึ้นมาไม่มีหน้าต่าง console
// กระพริบขึ้นมาเลย เป็นสุขอนามัยมาตรฐานสำหรับ Windows service ใด ๆ ที่
// shell out — service เองก็รันอยู่ใน Session 0 ที่ไม่มี desktop แบบ
// interactive อยู่แล้ว ดังนั้นตรงนี้แค่ระงับการจอง console buffer เท่านั้น
// ไม่ได้ไปซ่อนจาก OS tooling, Task Manager, หรือ audit log ของ agent เอง
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
