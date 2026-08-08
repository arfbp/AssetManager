//go:build windows

package executor

import (
	"os/exec"
	"syscall"
)

// hideWindow ensures a spawned script process never flashes a console
// window. This is standard hygiene for any Windows service that shells out
// — a service already runs in Session 0 with no interactive desktop, so
// this only suppresses the console buffer allocation, not visibility to any
// OS tooling, Task Manager, or this agent's own audit log.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
