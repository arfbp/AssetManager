//go:build !windows && !darwin

package telemetry

// collectDevices ยังไม่ได้ implement บนแพลตฟอร์มนี้ — Windows
// (devices_windows.go) ใช้ WMI, Darwin (devices_darwin.go) shell out ไป
// เรียก system_profiler/lpstat; ทั้งสองวิธีใช้กับ Linux ไม่ได้ตรง ๆ ถ้า
// ไม่มีกลไกอื่น (udev/sysfs สำหรับ USB, API ของ CUPS เองสำหรับ printer)
// เป็น no-op ที่บันทึกไว้แล้ว ไม่ใช่ build fail เหมือน pattern ของ
// EmptyWorkingSet no-op ใน workingset_unix.go เป็น slice ว่างแต่ไม่ใช่
// nil — เหตุผลเดียวกับ collectPhysicalDisks ด้านล่าง
func collectDevices() []DeviceInfo {
	return []DeviceInfo{}
}

// collectHardwareInfo: เหตุผลเรื่อง no-op เดียวกับ collectDevices ด้านบน
func collectHardwareInfo() (serial, model, manufacturer string) {
	return "", "", ""
}

// collectPhysicalDisks: เหตุผลเรื่อง no-op เดียวกับ collectDevices ด้านบน
// เป็น slice ว่างแต่ไม่ใช่ nil — slice ที่เป็น nil ใน Go จะ marshal เป็น
// JSON `null` และฝั่ง frontend เรียก .length บน field นี้โดยไม่เช็คก่อน
func collectPhysicalDisks() []PhysicalDiskInfo {
	return []PhysicalDiskInfo{}
}

// collectLocalUsers: เหตุผลเรื่อง no-op เดียวกับ collectDevices ด้านบน
func collectLocalUsers() []LocalUserInfo {
	return []LocalUserInfo{}
}

// collectCurrentUser: เหตุผลเรื่อง no-op เดียวกับ collectDevices ด้านบน
func collectCurrentUser() string {
	return ""
}
