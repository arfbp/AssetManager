package telemetry

import "time"

// Mode คือรอบความถี่ในการ poll ปัจจุบันที่ agent ทำงานอยู่
type Mode string

const (
	ModeNormal Mode = "normal"
	ModeAlert  Mode = "alert"
)

// Responding มีความหมายเฉพาะบน Windows เท่านั้น ที่ top-level window ที่
// หยุด pump message queue จะถูก OS เองตีตราว่า hung — สถานะเดียวกับที่
// Task Manager แสดง "(Not Responding)" เป็น true เสมอบนแพลตฟอร์มอื่น (และ
// เป็น true สำหรับ process ที่ไม่มี top-level window เลย เช่น background
// service เพราะพวกนั้นไม่มีทาง "not responding" ในความหมายนี้ตั้งแต่แรก) —
// ดู hungWindowPIDsWindows
type ProcessInfo struct {
	PID        int32   `json:"pid"`
	Name       string  `json:"name"`
	CPUPercent float64 `json:"cpu_percent"`
	MemMB      float64 `json:"mem_mb"`
	Responding bool    `json:"responding"`
}

type DiskInfo struct {
	MountPoint  string  `json:"mount_point"`
	UsedPercent float64 `json:"used_percent"`
	FreeGB      float64 `json:"free_gb"`
	TotalGB     float64 `json:"total_gb"`
}

// PhysicalDiskInfo คืออุปกรณ์ storage จริงหนึ่งตัว — เป็น spec inventory
// ("เครื่องนี้มี drive อะไรบ้าง SSD หรือ HDD ขนาดเท่าไหร่") ไม่ใช่ข้อมูลการ
// ใช้งาน รายงานเป็น flat list ของตัวเอง แทนที่จะ join เข้ากับ entry ต่อ
// mount-point ของ DiskInfo: physical disk หนึ่งตัว map ไปเป็น drive letter
// ได้ผ่านหลายชั้นของความสัมพันธ์เฉพาะ OS (partition, volume, dynamic
// disk/RAID) ที่ไม่สามารถลดรูปเป็น one-to-one join ได้สะอาด ๆ ดังนั้น field
// นี้ตอบคำถาม "มี physical drive อะไรอยู่บ้าง" ส่วน DiskInfo ตอบคำถาม
// "แต่ละ mounted volume เต็มแค่ไหน" แยกกัน — เกี่ยวข้องกันแต่เป็นคำถามคนละ
// อย่างจริง ๆ วันนี้มีเฉพาะ Windows (ดู collectPhysicalDisksWindows);
// MediaType เป็น "SSD", "HDD", หรือ "Unknown" (OS ไม่ได้รายงานคำตอบที่
// เชื่อถือได้ทั้งสองทาง)
type PhysicalDiskInfo struct {
	Model     string  `json:"model"`
	MediaType string  `json:"media_type"`
	SizeGB    float64 `json:"size_gb"`
}

// DeviceInfo คือ peripheral ที่ต่ออยู่ตอนนี้หนึ่งตัว — เป็น snapshot ของ
// "ตอนนี้เสียบอะไรอยู่บ้าง" ไม่ใช่ประวัติ connect/disconnect Type เป็นหนึ่ง
// ใน "usb", "printer", "monitor" Detail คือ context เพิ่มเติมแบบ
// best-effort (manufacturer, flag ว่าเป็น default-printer, ...) อาจว่างได้
// ถ้า OS ไม่รายงานมา SerialNumber/Model/Manufacturer จะถูกเติมก็ต่อเมื่อ OS
// เปิดเผยข้อมูลระบุตัวตนจริงสำหรับ device class นั้น (วันนี้มีแค่: monitor
// ผ่าน EDID บน WMI's root\wmi WmiMonitorID — ดู collectMonitorsWindows)
// เพื่อให้ operator ลงทะเบียน peripheral นั้นเป็น asset ได้โดยไม่ต้องพิมพ์
// serial เอง
type DeviceInfo struct {
	Type         string `json:"type"`
	Name         string `json:"name"`
	Detail       string `json:"detail,omitempty"`
	SerialNumber string `json:"serial_number,omitempty"`
	Model        string `json:"model,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
}

// NetworkInterface คือ config เต็มรูปแบบของ adapter หนึ่งตัว — รายละเอียด
// ระดับเดียวกับที่ "ipconfig /all" ของ Windows แสดง ไม่ใช่แค่ IP address
// list เปล่า ๆ ที่ IPAddresses มี (ซึ่งมีแยกไว้อยู่แล้วสำหรับกรณีง่าย ๆ
// "IP เครื่องนี้คืออะไร" และมีมาก่อนอันนี้) field
// DHCP/gateway/DNS/lease มีเฉพาะ Windows (ผ่าน
// Win32_NetworkAdapterConfiguration) และว่างเปล่าบนแพลตฟอร์มอื่น;
// Name/MAC/IP/Subnet มาจาก net package แบบ cross-platform บนทุก OS
type NetworkInterface struct {
	Name           string   `json:"name"`
	Description    string   `json:"description,omitempty"`
	MACAddress     string   `json:"mac_address,omitempty"`
	IPAddresses    []string `json:"ip_addresses"`
	SubnetMasks    []string `json:"subnet_masks,omitempty"`
	DHCPEnabled    bool     `json:"dhcp_enabled"`
	DHCPServer     string   `json:"dhcp_server,omitempty"`
	DefaultGateway []string `json:"default_gateway,omitempty"`
	DNSServers     []string `json:"dns_servers,omitempty"`
	LeaseObtained  string   `json:"lease_obtained,omitempty"`
	LeaseExpires   string   `json:"lease_expires,omitempty"`
}

// LocalUserInfo คือ local (non-domain) OS user account หนึ่งบัญชี — ข้อมูล
// เดียวกับที่ "net user" แสดง บวกกับว่าบัญชีนั้นอยู่ใน built-in
// Administrators group หรือไม่ ซึ่ง "net user" เฉย ๆ ไม่แสดงถ้าไม่เรียก
// "net user <name>" ซ้ำอีกครั้งต่อบัญชี วันนี้มีเฉพาะ Windows; แพลตฟอร์ม
// อื่นรายงาน list ว่างเปล่า (ดู collectLocalUsers ใน
// devices_other.go/devices_darwin.go)
type LocalUserInfo struct {
	Username string `json:"username"`
	FullName string `json:"full_name,omitempty"`
	IsAdmin  bool   `json:"is_admin"`
	Disabled bool   `json:"disabled"`
}

// Snapshot คือค่า telemetry ณ จุดเวลาหนึ่งจุด
type Snapshot struct {
	Timestamp         time.Time          `json:"timestamp"`
	Mode              Mode               `json:"mode"`
	CPUPercent        float64            `json:"cpu_percent"`
	MemPercent        float64            `json:"mem_percent"`
	MemUsedMB         float64            `json:"mem_used_mb"`
	MemTotalMB        float64            `json:"mem_total_mb"`
	Disks             []DiskInfo         `json:"disks"`
	PhysicalDisks     []PhysicalDiskInfo `json:"physical_disks"`
	TopProcs          []ProcessInfo      `json:"top_processes"`
	Devices           []DeviceInfo       `json:"connected_devices"`
	Hostname          string             `json:"hostname"`
	IPAddresses       []string           `json:"ip_addresses"`
	// address ที่หันหน้าออกอินเทอร์เน็ตจริงของเครื่องนี้ มาจากการ lookup
	// ภายนอก — ดู publicip.go ว่างเปล่าจนกว่าการ refresh เบื้องหลังจะเสร็จ
	// (ปกติภายในหนึ่งถึงสองวินาทีหลัง agent เริ่มทำงาน) หรือถ้าการ lookup
	// ยังไม่เคยสำเร็จเลย (ไม่มี internet egress, external service ล่ม, ...)
	PublicIP          string             `json:"public_ip"`
	NetworkInterfaces []NetworkInterface `json:"network_interfaces"`
	OS                string             `json:"os"`
	OSVersion         string             `json:"os_version"`
	UptimeSeconds     uint64             `json:"uptime_seconds"`
	SerialNumber      string             `json:"serial_number"`
	Model             string             `json:"model"`
	Manufacturer      string             `json:"manufacturer"`
	LocalUsers        []LocalUserInfo    `json:"local_users"`
	// CurrentUser แยก "ใคร login เข้า interactive (console) session อยู่
	// ตอนนี้" ออกจาก "มี account อะไรอยู่บนเครื่องนี้บ้าง" ของ LocalUsers —
	// เป็นคำถามคนละอย่างจริง ๆ ("ใครกำลังใช้เครื่องนี้อยู่") ที่ account
	// list เฉย ๆ ตอบไม่ได้ วันนี้มีเฉพาะ Windows ผ่าน
	// Win32_ComputerSystem.UserName (ดู collectCurrentUser); แพลตฟอร์มอื่น
	// รายงาน string ว่างเปล่า ค่าว่างก็แปลว่าไม่มีใคร login อยู่ตอนนี้ (เช่น
	// ค้างอยู่ที่หน้า lock/login) ไม่ใช่การเก็บข้อมูลล้มเหลว รายงานเฉพาะ
	// console/active session เท่านั้น — session อื่นของ Fast User Switching
	// ที่ switch เข้าไปแต่ไม่ active ไม่ถูกจับ เป็นข้อจำกัดเดียวกับที่ tab
	// "Users" ของ Task Manager เองแสดงเป็น default
	CurrentUser string `json:"current_user"`
	// ชื่อรุ่น CPU (เช่น "Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz") — ผ่าน
	// cpu.Info แบบ cross-platform ของ gopsutil ต่างจากข้อมูล EDID ของ
	// PhysicalDisks/DeviceInfo ที่เป็น WMI query เฉพาะ Windows
	CPUModel string `json:"cpu_model"`
}

// IsOverThreshold รายงานว่า snapshot นี้ตัวเดียวควรเข้า alert mode หรือไม่
func (s Snapshot) IsOverThreshold(cpuThreshold, memThreshold float64) bool {
	return s.CPUPercent >= cpuThreshold || s.MemPercent >= memThreshold
}
