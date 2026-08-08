//go:build !windows

// The single-file self-install flow (selfinstall_windows.go) is Windows-only
// — macOS deployment still goes through dist-agent-deploy-macos/install.sh.
// These stubs just mean shouldSelfInstall never fires on other platforms;
// main()'s existing behavior is otherwise unchanged.
package main

func shouldSelfInstall(svcFlag string, runForeground bool) bool { return false }

func selfInstall(alreadyElevated bool) {}
