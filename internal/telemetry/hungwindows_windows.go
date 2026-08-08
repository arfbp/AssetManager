//go:build windows

// Detects which running processes own a hung top-level window — the same
// "(Not Responding)" state Windows' own Task Manager shows, and the same
// underlying signal (a window that's stopped pumping its message queue,
// checked via user32's IsHungAppWindow) it uses to determine that. This is
// distinct from high CPU usage: a process can be pegged at 100% CPU and
// still be perfectly responsive (a real background compute task), and a
// process can be completely hung at 0% CPU (deadlocked waiting on a lock).
// Only a real window-message-pump check catches the actual "frozen UI" case
// operators care about.
package telemetry

import (
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32                 = syscall.NewLazyDLL("user32.dll")
	procEnumWindows        = user32.NewProc("EnumWindows")
	procGetWindowThreadPID = user32.NewProc("GetWindowThreadProcessId")
	procIsHungAppWindow    = user32.NewProc("IsHungAppWindow")
	procIsWindowVisible    = user32.NewProc("IsWindowVisible")

	// Created once, not per call: syscall.NewCallback has a small fixed
	// budget of callback trampolines for the whole process lifetime (Go's
	// own docs put it at roughly 2000) — this function runs on every
	// telemetry poll (every 5 minutes, or every 10s in alert mode), so
	// allocating a fresh one each time would eventually exhaust that budget
	// on a long-running agent and panic.
	hungWindowCallback = syscall.NewCallback(enumWindowsCallback)
	hungWindowResults  map[int32]bool

	// Guards hungWindowResults AND ensures only one EnumWindows call is ever
	// in flight — necessary because a timed-out call (see hungWindowPIDs)
	// leaves its goroutine running in the background rather than actually
	// cancelling the underlying OS call (there's no way to cancel it). If a
	// later poll started a second overlapping call while the first was still
	// stuck, both would write hungWindowResults concurrently and crash the
	// process with "fatal error: concurrent map writes".
	hungWindowMu sync.Mutex
)

func enumWindowsCallback(hwnd syscall.Handle, _ uintptr) uintptr {
	visible, _, _ := procIsWindowVisible.Call(uintptr(hwnd))
	if visible == 0 {
		return 1 // continue enumeration
	}
	isHung, _, _ := procIsHungAppWindow.Call(uintptr(hwnd))
	if isHung == 0 {
		return 1
	}
	var pid uint32
	procGetWindowThreadPID.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&pid)))
	if pid != 0 {
		hungWindowResults[int32(pid)] = true
	}
	return 1 // continue enumeration
}

// hungWindowPIDs enumerates every top-level window on the desktop and
// returns the set of process IDs that own at least one hung, visible
// window. Best-effort in two ways: any failure yields an empty set (nothing
// reported as hung) rather than blocking the rest of telemetry collection,
// and the whole call is bounded by a hard timeout — verified live that
// EnumWindows can behave very differently (and not return promptly) when
// this agent runs as a Windows Service under SYSTEM in Session 0, which has
// no interactive desktop, versus a normal interactive/console process where
// this returns in low single-digit milliseconds. A hung telemetry collector
// is a much worse outcome than occasionally skipping one poll's hang check.
func hungWindowPIDs() map[int32]bool {
	if !hungWindowMu.TryLock() {
		// A previous call is still stuck inside EnumWindows — skip this
		// cycle's hang check entirely rather than starting a second
		// overlapping call.
		return nil
	}

	done := make(chan map[int32]bool, 1)
	go func() {
		defer hungWindowMu.Unlock()
		hungWindowResults = make(map[int32]bool)
		_, _, _ = procEnumWindows.Call(hungWindowCallback, 0)
		done <- hungWindowResults
	}()

	select {
	case result := <-done:
		return result
	case <-time.After(2 * time.Second):
		// The goroutine above keeps running (and holds the mutex) until/if
		// EnumWindows ever actually returns — this just stops waiting on it
		// for this poll cycle instead of blocking telemetry collection.
		return nil
	}
}
