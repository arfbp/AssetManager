//go:build darwin

package telemetry

import (
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

// collectDevices แจกแจง USB device, printer, และจอที่ต่ออยู่ตอนนี้ ผ่าน
// system tool ตัวเดียวกับที่ Finder/System Information ใช้ (system_profiler,
// lpstat) — best-effort เหมือน implementation ของ Windows: แหล่งข้อมูลหนึ่ง
// ล้มเหลวจะไม่บล็อกตัวอื่น
func collectDevices() []DeviceInfo {
	// เริ่มจากค่าที่ไม่ใช่ nil: append(nil, emptySlice...) ยังคืน nil อยู่
	// ถ้า sub-collector ทุกตัวไม่มีอะไรให้เลย ดังนั้นต้องเริ่มจาก
	// []DeviceInfo{} เท่านั้นถึงจะรับประกันผลลัพธ์ที่ไม่ใช่ nil — ดู
	// comment เดียวกันใน collectDevices ของ devices_windows.go
	devices := []DeviceInfo{}
	devices = append(devices, collectUSBDevicesDarwin()...)
	devices = append(devices, collectPrintersDarwin()...)
	devices = append(devices, collectMonitorsDarwin()...)
	return devices
}

// collectHardwareInfo อ่าน serial number และ model identifier ของ Mac เอง
// — เป็นข้อมูลระบุตัวตนสำหรับ asset-tracking ไม่ใช่ peripheral — ผ่าน
// SPHardwareDataType แหล่งข้อมูลเดียวกับที่ "About This Mac" ใช้
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

// collectPhysicalDisks อ่าน SPStorageDataType ซึ่งซ้อน physical drive ที่
// รองรับแต่ละ mounted volume (device name + medium_type "SSD" หรือ
// "Rotational") ไว้ใต้ key "physical_drive" — dedupe ด้วย device name เพราะ
// หลาย volume/partition ใช้ physical disk เดียวกันได้ เหมือนกับ
// collectMonitorsDarwin ส่วนนี้ยังไม่เคยยืนยันกับเครื่อง Mac จริง;
// ชื่อ key ของ JSON ใน system_profiler เคยเปลี่ยนไปมาข้าม macOS version
// มาแล้ว ดังนั้นถือเป็น best-effort เหมือนที่อื่นในไฟล์นี้ — parse พลาดก็
// แค่ได้ list ว่างเปล่า ไม่ crash
func collectPhysicalDisks() []PhysicalDiskInfo {
	// เป็น slice ว่างแต่ไม่ใช่ nil ทุก failure path — slice ที่เป็น nil ใน
	// Go จะ marshal เป็น JSON `null` และฝั่ง frontend เรียก .length บน
	// field นี้โดยไม่เช็คก่อน เหมือน array field อื่น ๆ ทั้งหมดใน snapshot
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

// collectLocalUsers ยังไม่ได้ implement บน macOS — Windows
// (devices_windows.go) อ่าน local account ผ่าน WMI's
// Win32_UserAccount/Win32_GroupUser; ฝั่ง macOS ที่เทียบเท่ากันต้อง shell
// out ไปเรียก `dscl . -list /Users` บวกกับเช็ค membership ด้วย
// `dseditgroup` ซึ่งยังไม่ได้เขียน เป็น no-op ที่บันทึกไว้แล้ว ไม่ใช่
// build fail เหมือน pattern ของ collectDevices บนแพลตฟอร์มที่ยังไม่รองรับ
func collectLocalUsers() []LocalUserInfo {
	return []LocalUserInfo{}
}

// collectCurrentUser ยังไม่ได้ implement บน macOS — Windows
// (devices_windows.go) อ่านเจ้าของ console session ผ่าน
// Win32_ComputerSystem.UserName; ฝั่ง macOS ที่เทียบเท่ากันต้อง shell out
// ไปเรียก `stat -f%Su /dev/console` ซึ่งยังไม่ได้เขียน เหตุผลเรื่อง no-op
// เดียวกับ collectLocalUsers ด้านบน
func collectCurrentUser() string {
	return ""
}

// collectUSBDevicesDarwin เดิน tree ของ SPUSBDataType (แต่ละ hub/controller
// ซ้อน device ที่ต่ออยู่ไว้ใต้ "_items" แบบ recursive) แล้วบันทึกทุก node
// ที่มีชื่อที่เจอ วิธีนี้จะได้ hub/controller เองปนมากับ peripheral จริงด้วย
// อย่างเลี่ยงไม่ได้ — system_profiler ไม่ได้แยก "โครงสร้าง bus" ออกจาก
// "สิ่งที่เสียบเข้าไป" อย่างชัดเจนแบบที่ device list แบบ flat เดียวจะทำได้
func collectUSBDevicesDarwin() []DeviceInfo {
	// เป็น slice ว่างแต่ไม่ใช่ nil ทุก path — slice ที่เป็น nil ใน Go จะ
	// marshal เป็น JSON `null` และฝั่ง frontend เรียก .length บน field นี้
	// โดยไม่เช็คก่อน
	parsed, ok := runSystemProfilerJSON("SPUSBDataType")
	if !ok {
		return []DeviceInfo{}
	}
	top, ok := parsed["SPUSBDataType"].([]interface{})
	if !ok {
		return []DeviceInfo{}
	}
	devices := []DeviceInfo{}
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

// collectPrintersDarwin shell out ไปเรียก lpstat แทนที่จะใช้
// SPPrintersDataType — output parse ง่ายกว่า และรายงานสิ่งที่ CUPS
// config ไว้จริง ๆ แทนที่จะต้องพึ่ง printer probe ของ system_profiler เอง
// ที่ช้ากว่า
func collectPrintersDarwin() []DeviceInfo {
	cmd := exec.Command("lpstat", "-p")
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return []DeviceInfo{}
	}
	devices := []DeviceInfo{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "printer" {
			devices = append(devices, DeviceInfo{Type: "printer", Name: fields[1]})
		}
	}
	return devices
}

// collectMonitorsDarwin อ่าน SPDisplaysDataType key ที่ system_profiler ใช้
// สำหรับจอแต่ละตัวภายใต้แต่ละ GPU entry เคยเปลี่ยนไปมาข้าม macOS version
// มาแล้ว (ตอนนี้ใช้ spdisplays_ndrvs) — นี่คือส่วนเดียวของการเก็บข้อมูล
// device ที่ยังไม่เคยยืนยันกับเครื่องจริง; ดู deploy README
func collectMonitorsDarwin() []DeviceInfo {
	parsed, ok := runSystemProfilerJSON("SPDisplaysDataType")
	if !ok {
		return []DeviceInfo{}
	}
	gpus, ok := parsed["SPDisplaysDataType"].([]interface{})
	if !ok {
		return []DeviceInfo{}
	}
	devices := []DeviceInfo{}
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
