//go:build !windows

package telemetry

// No equivalent "hung window" OS signal is wired up for non-Windows targets
// yet — every process just reports Responding=true, same as before this
// field existed.
func hungWindowPIDs() map[int32]bool {
	return nil
}
