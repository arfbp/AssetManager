//go:build !windows

package executor

import "os/exec"

// hideWindow is a no-op on macOS/Linux: a service/daemon process has no
// console to attach to in the first place, so there is nothing to suppress.
func hideWindow(cmd *exec.Cmd) {}
