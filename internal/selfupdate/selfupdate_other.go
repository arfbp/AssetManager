//go:build !windows

package selfupdate

import "fmt"

// applyPlatform: self-update isn't implemented on this platform yet — the
// swap-a-running-executable dance is inherently OS-specific (see
// selfupdate_windows.go), and this project's macOS/Linux support doesn't
// need it as urgently as the primarily-Windows fleet this was built for.
// Returns an error rather than silently no-op-ing so Apply's caller logs a
// real failure instead of the agent looking like it "accepted" an update it
// never actually installed.
func applyPlatform(exePath, newPath, serviceName string) error {
	return fmt.Errorf("selfupdate: not implemented on this platform yet")
}
