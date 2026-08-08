//go:build windows

package selfheal

import (
	"fmt"

	"golang.org/x/sys/windows"
)

var (
	modpsapi            = windows.NewLazySystemDLL("psapi.dll")
	procEmptyWorkingSet = modpsapi.NewProc("EmptyWorkingSet")
)

// TrimWorkingSet asks Windows to trim the target process's working set
// (physical RAM pages backing it), forcing infrequently-touched pages out to
// the page file. It does not free leaked memory the process itself is still
// holding onto — it only reduces the *physical* footprint reported in Task
// Manager until the process touches those pages again. That matches the
// "clean working set" request: a safe, reversible first response, distinct
// from killing the process outright.
func TrimWorkingSet(pid int32) error {
	const desiredAccess = windows.PROCESS_QUERY_INFORMATION | windows.PROCESS_SET_QUOTA
	handle, err := windows.OpenProcess(desiredAccess, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("selfheal: open process %d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)

	r1, _, callErr := procEmptyWorkingSet.Call(uintptr(handle))
	if r1 == 0 {
		return fmt.Errorf("selfheal: EmptyWorkingSet for pid %d: %w", pid, callErr)
	}
	return nil
}
