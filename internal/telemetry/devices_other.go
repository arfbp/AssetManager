//go:build !windows && !darwin

package telemetry

// collectDevices is not implemented for this platform yet — Windows
// (devices_windows.go) uses WMI, Darwin (devices_darwin.go) shells out to
// system_profiler/lpstat; neither approach carries over to Linux without a
// different mechanism (udev/sysfs for USB, CUPS' own API for printers).
// A documented no-op, not a build failure, same pattern as
// workingset_unix.go's EmptyWorkingSet no-op.
func collectDevices() []DeviceInfo {
	return nil
}

// collectHardwareInfo: same no-op reasoning as collectDevices above.
func collectHardwareInfo() (serial, model, manufacturer string) {
	return "", "", ""
}

// collectPhysicalDisks: same no-op reasoning as collectDevices above. Empty-
// but-non-nil, not nil — a nil Go slice marshals to JSON `null`, and the
// frontend calls .length on this field unconditionally.
func collectPhysicalDisks() []PhysicalDiskInfo {
	return []PhysicalDiskInfo{}
}
