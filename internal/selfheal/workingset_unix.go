//go:build !windows

package selfheal

import "fmt"

// TrimWorkingSet has no direct equivalent on macOS/Linux without attaching
// to the target process (ptrace-level access), which this agent does not
// do. The memory monitor still runs its alert path on these platforms — it
// just reports that the trim step was skipped.
func TrimWorkingSet(pid int32) error {
	return fmt.Errorf("selfheal: working-set trim is only implemented on windows")
}
