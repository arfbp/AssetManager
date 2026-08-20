//go:build !windows

package executor

import "os/exec"

// hideWindow ไม่ทำอะไรเลยบน macOS/Linux: process แบบ service/daemon ไม่มี
// console ให้แนบตั้งแต่แรกอยู่แล้ว จึงไม่มีอะไรต้องซ่อน
func hideWindow(cmd *exec.Cmd) {}
