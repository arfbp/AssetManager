//go:build darwin

package telemetry

import (
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

// collectDevices enumerates currently-connected USB devices, printers, and
// displays via the same system tools Finder/System Information use
// (system_profiler, lpstat) — best-effort, same as the Windows
// implementation: one source failing never blocks the others.
func collectDevices() []DeviceInfo {
	var devices []DeviceInfo
	devices = append(devices, collectUSBDevicesDarwin()...)
	devices = append(devices, collectPrintersDarwin()...)
	devices = append(devices, collectMonitorsDarwin()...)
	return devices
}

// collectHardwareInfo reads the Mac's own serial number and model identifier
// — asset-tracking identity, not a peripheral — via SPHardwareDataType, the
// same source "About This Mac" uses.
func collectHardwareInfo() (serial, model, manufacturer string) {
	parsed, ok := runSystemProfilerJSON("SPHardwareDataType")
	if !ok {
		return "", "", ""
	}
	top, ok := parsed["SPHardwareDataType"].([]interface{})
	if !ok || len(top) == 0 {
		return "", "", ""
	}
	m, ok := top[0].(map[string]interface{})
	if !ok {
		return "", "", ""
	}
	if v, ok := m["serial_number"].(string); ok {
		serial = strings.TrimSpace(v)
	}
	if v, ok := m["machine_model"].(string); ok {
		model = strings.TrimSpace(v)
	}
	return serial, model, "Apple"
}

func runSystemProfilerJSON(dataType string) (map[string]interface{}, bool) {
	cmd := exec.Command("system_profiler", "-json", dataType)
	cmd.WaitDelay = 10 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, false
	}
	return parsed, true
}

// collectPhysicalDisks reads SPStorageDataType, which nests each mounted
// volume's backing physical drive (device name + medium_type "SSD" or
// "Rotational") under a "physical_drive" key — deduped by device name since
// several volumes/partitions can share one physical disk. Like
// collectMonitorsDarwin, this couldn't be verified against real Mac
// hardware; system_profiler's JSON key names have shifted across macOS
// versions before, so treat this as best-effort same as everywhere else in
// this file — a parse miss just yields an empty list, not a crash.
func collectPhysicalDisks() []PhysicalDiskInfo {
	// Empty-but-non-nil on every failure path — a nil Go slice marshals to
	// JSON `null`, and the frontend calls .length on this field
	// unconditionally, same as every other array field in a snapshot.
	disks := []PhysicalDiskInfo{}
	parsed, ok := runSystemProfilerJSON("SPStorageDataType")
	if !ok {
		return disks
	}
	items, ok := parsed["SPStorageDataType"].([]interface{})
	if !ok {
		return disks
	}
	seen := map[string]bool{}
	for _, item := range items {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		pd, ok := m["physical_drive"].(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := pd["device_name"].(string)
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true

		mediaType := "Unknown"
		if mt, ok := pd["medium_type"].(string); ok {
			switch strings.ToLower(mt) {
			case "ssd":
				mediaType = "SSD"
			case "rotational":
				mediaType = "HDD"
			}
		}
		sizeGB := 0.0
		if sizeBytes, ok := m["size_in_bytes"].(float64); ok {
			sizeGB = sizeBytes / (1024 * 1024 * 1024)
		}
		disks = append(disks, PhysicalDiskInfo{Model: name, MediaType: mediaType, SizeGB: sizeGB})
	}
	return disks
}

// collectUSBDevicesDarwin walks SPUSBDataType's tree (each hub/controller
// nests its attached devices under "_items", recursively) and records every
// named node it finds. This necessarily also picks up hubs/controllers
// themselves alongside actual peripherals — system_profiler doesn't cleanly
// separate "bus infrastructure" from "thing plugged into it" the way a
// single flat device list would.
func collectUSBDevicesDarwin() []DeviceInfo {
	parsed, ok := runSystemProfilerJSON("SPUSBDataType")
	if !ok {
		return nil
	}
	top, ok := parsed["SPUSBDataType"].([]interface{})
	if !ok {
		return nil
	}
	var devices []DeviceInfo
	for _, node := range top {
		walkUSBTreeDarwin(node, &devices)
	}
	return devices
}

func walkUSBTreeDarwin(node interface{}, out *[]DeviceInfo) {
	m, ok := node.(map[string]interface{})
	if !ok {
		return
	}
	if name, ok := m["_name"].(string); ok && strings.TrimSpace(name) != "" {
		manufacturer, _ := m["manufacturer"].(string)
		*out = append(*out, DeviceInfo{Type: "usb", Name: name, Detail: manufacturer})
	}
	if children, ok := m["_items"].([]interface{}); ok {
		for _, c := range children {
			walkUSBTreeDarwin(c, out)
		}
	}
}

// collectPrintersDarwin shells out to lpstat rather than
// SPPrintersDataType — simpler output to parse, and reports what CUPS
// actually has configured rather than requiring system_profiler's own
// (slower) printer probe.
func collectPrintersDarwin() []DeviceInfo {
	cmd := exec.Command("lpstat", "-p")
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var devices []DeviceInfo
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "printer" {
			devices = append(devices, DeviceInfo{Type: "printer", Name: fields[1]})
		}
	}
	return devices
}

// collectMonitorsDarwin reads SPDisplaysDataType. The nested key
// system_profiler uses for individual displays under each GPU entry has
// shifted across macOS versions in the past (spdisplays_ndrvs is the
// current one) — this is the one part of device collection that couldn't
// be verified against real hardware; see the deploy README.
func collectMonitorsDarwin() []DeviceInfo {
	parsed, ok := runSystemProfilerJSON("SPDisplaysDataType")
	if !ok {
		return nil
	}
	gpus, ok := parsed["SPDisplaysDataType"].([]interface{})
	if !ok {
		return nil
	}
	var devices []DeviceInfo
	for _, gpu := range gpus {
		gm, ok := gpu.(map[string]interface{})
		if !ok {
			continue
		}
		displays, ok := gm["spdisplays_ndrvs"].([]interface{})
		if !ok {
			continue
		}
		for _, d := range displays {
			dm, ok := d.(map[string]interface{})
			if !ok {
				continue
			}
			if name, ok := dm["_name"].(string); ok && strings.TrimSpace(name) != "" {
				devices = append(devices, DeviceInfo{Type: "monitor", Name: name})
			}
		}
	}
	return devices
}
