//go:build windows

package telemetry

import (
	"fmt"
	"strings"
	"time"

	"github.com/yusufpapurcu/wmi"
)

type win32PnPEntity struct {
	Name         string
	Manufacturer string
	DeviceID     string
}

type win32Printer struct {
	Name    string
	Default bool
}

type win32DesktopMonitor struct {
	Name        string
	PNPDeviceID string
}

// wmiMonitorID สะท้อน class WmiMonitorID ของ root\wmi ซึ่งมี field ระบุ
// ตัวตนของจอแบบ raw EDID — เป็นจุดเดียวที่ Windows เปิดเผย serial number
// จริงของจอ ต่างจาก Name ของ Win32_DesktopMonitor (เป็นชื่อแสดงผลที่
// friendly ที่ resolve มาจาก INF ของ driver ไม่ใช่ตัวจอเอง) field ข้อความ
// เป็น encoding แบบ EDID เอง: หนึ่ง array element ต่อหนึ่ง ASCII character
// code เติม zero-pad — ดู decodeEDIDString
//
// ชนิด field เป็น []int32 ไม่ใช่ []uint16: นี่คือ property แบบ
// SAFEARRAY(VT_UI2) แต่ build นี้ของ yusufpapurcu/wmi's loadEntity decode
// แต่ละ array element เป็น Go int32 (ยืนยันแล้วจาก crash: มัน panic ตอน
// เรียก reflect.Value.Uint บน Value ที่เป็น int32 เมื่อประกาศ field เป็น
// []uint16)
type wmiMonitorID struct {
	InstanceName     string
	ManufacturerName []int32
	SerialNumberID   []int32
	UserFriendlyName []int32
}

// decodeEDIDString แปลง array แบบหนึ่ง char ต่อหนึ่ง element ของ
// WmiMonitorID กลับมาเป็น string ปกติ หยุดที่ค่า zero ตัวแรก (EDID เติม
// byte ที่เหลือด้วย null แทนที่จะเติม array ให้เต็มเสมอ)
func decodeEDIDString(vals []int32) string {
	b := make([]byte, 0, len(vals))
	for _, v := range vals {
		if v == 0 {
			break
		}
		b = append(b, byte(v))
	}
	return strings.TrimSpace(string(b))
}

// isJunkEDIDSerial รายงานว่า field serial-number ที่ decode จาก EDID มา
// เป็น placeholder ที่รู้จักอยู่แล้ว ไม่ใช่ตัวระบุจริงต่อเครื่อง ยืนยันแล้ว
// บนเครื่องจริง (จอในตัวของ laptop ยี่ห้อ Lenovo): EDID ของมัน encode ค่า
// "0" ตรงนี้จริง ๆ ต่างจาก serial จริงของจอ external ที่ถอดเปลี่ยนได้ —
// จอในตัวไม่เคยถูกขายหรือ service แยกจากตัว laptop เอง vendor เลยไม่สนใจ
// ใส่ค่าตรงนี้ให้มีความหมาย การถือว่ามันมีค่าจริงจะแย่กว่าการถือว่าไม่มี:
// laptop รุ่นเดียวกันทุกเครื่องจะเสนอให้ลงทะเบียน asset ด้วย "serial"
// เดียวกันหมด
func isJunkEDIDSerial(s string) bool {
	if s == "" {
		return true
	}
	for _, c := range s {
		if c != '0' {
			return false
		}
	}
	return true
}

// pnpVendorNames map PNP ID สามตัวอักษรที่ EDID ฝังไว้สำหรับ manufacturer
// ของจอ ไปเป็นชื่อแบรนด์ที่ operator น่าจะจำได้จริง ไม่ครบทุกยี่ห้อ —
// ครอบคลุมแค่ vendor ที่น่าจะเจอในฟลีตออฟฟิศทั่วไป; ยี่ห้ออื่นจะ fallback
// ไปใช้ code ดิบแทนที่จะเดา
var pnpVendorNames = map[string]string{
	"HWP": "HP", "HPN": "HP", "SEC": "Samsung", "AUS": "ASUS", "DEL": "Dell",
	"LEN": "Lenovo", "BNQ": "BenQ", "GSM": "LG", "ACR": "Acer",
	"VSC": "ViewSonic", "PHL": "Philips", "AOC": "AOC", "IVM": "Iiyama",
	"CMN": "Chimei", "MSI": "MSI", "GBT": "Gigabyte", "ENC": "Eizo",
	"APP": "Apple", "SNY": "Sony", "NEC": "NEC",
}

type win32BIOS struct {
	SerialNumber string
}

type win32ComputerSystem struct {
	Model        string
	Manufacturer string
}

type win32ComputerSystemUser struct {
	UserName string
}

// collectCurrentUser รายงานว่าใคร login เข้า interactive console session
// อยู่ตอนนี้ (Win32_ComputerSystem.UserName — property เดียวกับที่ System
// Information panel ของ Windows เองอ่านสำหรับ "Logged-on user") ในรูปแบบ
// "DOMAIN\username" หรือ "COMPUTERNAME\username" สำหรับ local account
// best-effort: ผลลัพธ์ว่างเปล่าเป็นค่าที่ valid ได้ (ไม่มีใคร login อยู่
// ตอนนี้) พอ ๆ กับกรณี failure ดังนั้นแยกไม่ได้ระหว่าง "ไม่มีใคร login"
// กับ "query ล้มเหลว" — tradeoff เดียวกับที่อื่นในไฟล์นี้ เพราะการบล็อก
// snapshot ทั้งชุดเพียงเพราะ field เดียวไม่คุ้ม
func collectCurrentUser() string {
	var rows []win32ComputerSystemUser
	if err := wmi.Query("SELECT UserName FROM Win32_ComputerSystem", &rows); err != nil || len(rows) == 0 {
		return ""
	}
	return strings.TrimSpace(rows[0].UserName)
}

// collectHardwareInfo อ่าน serial number และ model ของเครื่องเอง — เป็น
// ข้อมูลระบุตัวตนสำหรับ asset-tracking ไม่ใช่ peripheral — ผ่าน WMI class
// สองตัวเดียวกับที่ System Information panel ของ Windows เองใช้
func collectHardwareInfo() (serial, model, manufacturer string) {
	var biosList []win32BIOS
	if err := wmi.Query("SELECT SerialNumber FROM Win32_BIOS", &biosList); err == nil && len(biosList) > 0 {
		serial = strings.TrimSpace(biosList[0].SerialNumber)
	}
	var csList []win32ComputerSystem
	if err := wmi.Query("SELECT Model, Manufacturer FROM Win32_ComputerSystem", &csList); err == nil && len(csList) > 0 {
		model = strings.TrimSpace(csList[0].Model)
		manufacturer = strings.TrimSpace(csList[0].Manufacturer)
	}
	return serial, model, manufacturer
}

// collectDevices แจกแจง USB device, printer, และจอที่ต่ออยู่ตอนนี้ผ่าน WMI
// แต่ละ query แยกอิสระจากกันและเป็น best-effort — ตัวหนึ่งล้มเหลว (เช่น
// ไม่มี printer ตั้งค่าไว้) จะไม่บล็อกตัวอื่น
func collectDevices() []DeviceInfo {
	// เป็น slice ว่างแต่ไม่ใช่ nil — slice ที่เป็น nil ใน Go จะ marshal เป็น
	// JSON `null` และฝั่ง frontend เรียก .length บน field นี้โดยไม่เช็คก่อน
	// การเริ่มจาก []DeviceInfo{} แทนตัวแปร nil ยังสำคัญอยู่ แม้
	// sub-collector ทั้งสามตัวจะแก้ให้ไม่คืน nil เองแล้วก็ตาม:
	// append(nil, emptySlice...) ยังคืน nil อยู่ดีถ้า sub-collector ทุกตัว
	// ไม่มีอะไรให้เลย (เช่น ไม่มี USB device, ไม่มี printer, ไม่มีจอ พร้อม
	// กันทั้งหมด) — มีแต่ slice เริ่มต้นที่ไม่ใช่ nil เท่านั้นที่รับประกัน
	// ผลลัพธ์ที่ไม่ใช่ nil
	devices := []DeviceInfo{}
	devices = append(devices, collectUSBDevicesWindows()...)
	devices = append(devices, collectPrintersWindows()...)
	devices = append(devices, collectMonitorsWindows()...)
	return devices
}

// collectUSBDevicesWindows query PnP entity ทุกตัวที่แจกแจงอยู่ใต้ USB
// bus — วิธีนี้จับได้ทุกอย่างที่เสียบเข้า USB port จริง ๆ (storage, mouse,
// keyboard, webcam, ...) ไม่ว่า driver class จะเป็นอะไร ต่างจากการ filter
// ด้วย PNPClass='USB' ที่จับได้แค่ hub/controller เองเท่านั้น
func collectUSBDevicesWindows() []DeviceInfo {
	var entities []win32PnPEntity
	if err := wmi.Query("SELECT Name, Manufacturer, DeviceID FROM Win32_PnPEntity WHERE DeviceID LIKE 'USB%'", &entities); err != nil {
		return []DeviceInfo{}
	}
	devices := make([]DeviceInfo, 0, len(entities))
	for _, e := range entities {
		if strings.TrimSpace(e.Name) == "" {
			continue
		}
		devices = append(devices, DeviceInfo{Type: "usb", Name: e.Name, Detail: e.Manufacturer})
	}
	return devices
}

func collectPrintersWindows() []DeviceInfo {
	var printers []win32Printer
	if err := wmi.Query("SELECT Name, Default FROM Win32_Printer", &printers); err != nil {
		return []DeviceInfo{}
	}
	devices := make([]DeviceInfo, 0, len(printers))
	for _, p := range printers {
		if strings.TrimSpace(p.Name) == "" {
			continue
		}
		detail := ""
		if p.Default {
			detail = "default"
		}
		devices = append(devices, DeviceInfo{Type: "printer", Name: p.Name, Detail: detail})
	}
	return devices
}

// ไม่ filter ด้วย Availability: ยืนยันแล้วกับเครื่องจริงว่า property
// Availability ของ Win32_DesktopMonitor ไม่ถูกเติมค่าอย่างน่าเชื่อถือ
// สำหรับจอจริง (จอ external ที่ต่ออยู่และเปิดเครื่องอยู่วัดได้
// Availability=8 "Off Line" ตรงนี้ ไม่ใช่ "Running/Full Power" ตามที่ชื่อ
// enum บอก) — class นี้แจกแจงแค่จอที่ Windows มี device entry อยู่จริง ณ
// ตอนนี้เท่านั้น ซึ่งตัวมันเองก็ถือว่า "เชื่อมต่ออยู่" อยู่แล้ว
func collectMonitorsWindows() []DeviceInfo {
	var monitors []win32DesktopMonitor
	if err := wmi.Query("SELECT Name, PNPDeviceID FROM Win32_DesktopMonitor", &monitors); err != nil {
		return []DeviceInfo{}
	}

	// ข้อมูลระบุตัวตนของ EDID อยู่คนละ WMI namespace กับ query อื่น ๆ ในไฟล์
	// นี้ best-effort: ถ้า fail (เครื่องเก่า, driver มีปัญหา) จอยังคงถูก
	// รายงานด้วยแค่ friendly name แทนที่จะถูกตัดทิ้งไปเลย
	var ids []wmiMonitorID
	_ = wmi.QueryNamespace(
		"SELECT InstanceName, ManufacturerName, SerialNumberID, UserFriendlyName FROM WmiMonitorID",
		&ids, `root\wmi`,
	)

	devices := make([]DeviceInfo, 0, len(monitors))
	for _, m := range monitors {
		if strings.TrimSpace(m.Name) == "" {
			continue
		}
		device := DeviceInfo{Type: "monitor", Name: m.Name}
		// เทียบด้วย prefix ไม่ใช่ equality: ยืนยันแล้วบนเครื่องจริงว่า
		// WmiMonitorID.InstanceName มี suffix แบบ "_0" เพิ่มมา ซึ่ง
		// Win32_DesktopMonitor.PNPDeviceID ไม่มี (เช่น PNPDeviceID
		// "...UID12337" เทียบกับ InstanceName "...UID12337_0") — ถ้า join
		// แบบ exact-match จะไม่ match กันเลยแบบเงียบ ๆ
		pnpUpper := strings.ToUpper(m.PNPDeviceID)
		for _, id := range ids {
			if pnpUpper == "" || !strings.HasPrefix(strings.ToUpper(id.InstanceName), pnpUpper) {
				continue
			}
			if serial := decodeEDIDString(id.SerialNumberID); !isJunkEDIDSerial(serial) {
				device.SerialNumber = serial
			}
			vendorCode := decodeEDIDString(id.ManufacturerName)
			if vendor, known := pnpVendorNames[vendorCode]; known {
				device.Manufacturer = vendor
			} else {
				device.Manufacturer = vendorCode
			}
			if friendly := decodeEDIDString(id.UserFriendlyName); friendly != "" {
				device.Model = friendly
			}
			break
		}
		devices = append(devices, device)
	}
	return devices
}

// msftPhysicalDisk สะท้อนมุมมองของ Storage Management API สมัยใหม่ที่มีต่อ
// physical drive (namespace root\Microsoft\Windows\Storage) — ต่างจาก
// Win32_DiskDrive.MediaType รุ่นเก่า ที่ยืนยันแล้วบนเครื่องจริงว่าบอกแค่
// "Fixed hard disk media" ทั้ง SSD และจานหมุนเหมือนกันหมด
// MSFT_PhysicalDisk.MediaType แยกความต่างได้จริง
type msftPhysicalDisk struct {
	FriendlyName string
	MediaType    uint16
	Size         uint64
}

// mediaTypeNames สะท้อน enum MediaType ของ MSFT_PhysicalDisk (ค่าที่
// Microsoft เอกสารไว้เอง — มี 0/1/2 อยู่ด้วยแต่ไม่เคยเจอในดิสก์จริง มีแต่
// 3/4/5 เท่านั้นที่เจอ): 3=HDD, 4=SSD, 5=SCM (storage-class memory ถือว่า
// เหมือน SSD แต่หายากพอที่จะไม่ต้องแยก label ของตัวเอง)
var mediaTypeNames = map[uint16]string{3: "HDD", 4: "SSD", 5: "SSD"}

// collectPhysicalDisks แจกแจงอุปกรณ์ storage จริง — เป็น spec inventory
// (มี drive อะไรบ้าง SSD หรือ HDD ขนาดเท่าไหร่) แยกจากเปอร์เซ็นต์การใช้งาน
// ต่อ mount-point ของ collectDisks best-effort: root\Microsoft\Windows\
// Storage เป็นส่วนหนึ่งของ Storage Management API มีตั้งแต่ Windows
// 8/2012 เป็นต้นไป — ถ้า query fail ไม่ว่าเหตุผลอะไร (OS เก่า, driver มี
// ปัญหา) จะลดรูปเหลือ list ว่างเปล่าแทนที่จะทำให้ snapshot ทั้งชุดล้มเหลว
func collectPhysicalDisks() []PhysicalDiskInfo {
	var raw []msftPhysicalDisk
	if err := wmi.QueryNamespace(
		"SELECT FriendlyName, MediaType, Size FROM MSFT_PhysicalDisk",
		&raw, `root\Microsoft\Windows\Storage`,
	); err != nil {
		// slice ที่เป็น nil ใน Go จะ marshal เป็น JSON `null` ไม่ใช่ `[]` —
		// ฝั่ง frontend เรียก .length บน field นี้โดยไม่เช็คก่อน (สมมติฐาน
		// เดียวกับที่ array field อื่น ๆ ทั้งหมดใน snapshot ใช้อยู่แล้ว)
		// ดังนั้นตรงนี้คืน slice ว่างแต่ไม่ใช่ nil ตอน fail แทนที่จะคืน nil
		return []PhysicalDiskInfo{}
	}
	disks := make([]PhysicalDiskInfo, 0, len(raw))
	for _, d := range raw {
		mediaType, known := mediaTypeNames[d.MediaType]
		if !known {
			mediaType = "Unknown"
		}
		disks = append(disks, PhysicalDiskInfo{
			Model:     strings.TrimSpace(d.FriendlyName),
			MediaType: mediaType,
			SizeGB:    float64(d.Size) / bytesPerGB,
		})
	}
	return disks
}

// win32NetworkAdapterConfiguration สะท้อน WMI class ที่ ipconfig.exe เอง
// สร้างอยู่บนนั้น — นี่คือสิ่งที่รองรับคำตอบแบบละเอียดสไตล์
// "ipconfig /all" จริง ๆ (DHCP server/lease, gateway, DNS) ไม่ใช่แค่
// IP list เปล่า ๆ ที่ collectIPAddresses ให้ไว้อยู่แล้วสำหรับกรณีง่าย ๆ
// "IP เครื่องนี้คืออะไร"
type win32NetworkAdapterConfiguration struct {
	Description          string
	MACAddress           string
	IPAddress            []string
	IPSubnet             []string
	DHCPEnabled          bool
	DHCPServer           string
	DefaultIPGateway     []string
	DNSServerSearchOrder []string
	DHCPLeaseObtained    string
	DHCPLeaseExpires     string
}

// parseWMIDateTime แปลง encoding datetime ของ WMI เอง
// ("yyyymmddHHMMSS.ffffff+UUU" โดย +UUU คือ UTC offset เป็นนาที ซึ่งไม่ได้
// ใช้ตรงนี้) ให้กลายเป็น string ที่อ่านง่าย ถ้า parse ไม่ได้จะ fallback
// กลับไปใช้ค่าดิบ — ให้ operator เห็น string แปลก ๆ นิดหน่อยยังดีกว่าตัด
// วันที่ lease ทิ้งไปเงียบ ๆ ทั้งหมด
func parseWMIDateTime(s string) string {
	if len(s) < 14 {
		return s
	}
	t, err := time.Parse("20060102150405", s[:14])
	if err != nil {
		return s
	}
	return t.Format("2006-01-02 15:04:05")
}

type win32UserAccount struct {
	Name     string
	FullName string
	Disabled bool
}

type win32GroupUser struct {
	PartComponent string
}

type win32GroupDomain struct {
	Domain string
}

// collectLocalUsers แจกแจง local (non-domain) Windows user account —
// คำตอบเดียวกับที่ "net user" ให้ — และ flag ว่าแต่ละบัญชีอยู่ใน built-in
// Administrators group หรือไม่ ซึ่ง "net user" เฉย ๆ ไม่แสดงถ้าไม่ lookup
// ต่อบัญชีเป็นครั้งที่สอง best-effort เหมือน collector อื่น ๆ ทั้งหมดในไฟล์
// นี้: query ตัวไหน fail ก็ลดรูปลงอย่างนุ่มนวลแทนที่จะตัด snapshot ทั้งชุด
// ทิ้ง — group lookup ที่ fail แค่ทำให้ทุกบัญชีรายงาน IsAdmin=false แทนที่
// จะบล็อก user list ทั้งหมด
func collectLocalUsers() []LocalUserInfo {
	var accounts []win32UserAccount
	if err := wmi.Query("SELECT Name, FullName, Disabled FROM Win32_UserAccount WHERE LocalAccount = TRUE", &accounts); err != nil {
		return []LocalUserInfo{}
	}

	// Domain ของ Win32_Group สำหรับ built-in Administrators group ไม่ใช่
	// string ตายตัว "BUILTIN" — ยืนยันแล้วบนเครื่องจริงว่ามันคือชื่อ
	// computer name ของเครื่องเอง (เช่น "DESKTOP-1NH0P21") ซึ่งต่างกันไปแต่
	// ละเครื่อง ดังนั้นจึง lookup SID ที่รู้จักกันดี S-1-5-32-544
	// (Administrators เหมือนกันทุก Windows install) ก่อน เพื่อเอาค่า Domain
	// ของเครื่องนี้เองมา แทนที่จะสมมติ string ตายตัวที่สุดท้ายผิด —
	// hardcode "BUILTIN" ตรงนี้จะ match ได้ศูนย์แถวแบบเงียบ ๆ แล้วทุกบัญชี
	// จะรายงาน IsAdmin=false ไม่ว่า membership จริงจะเป็นยังไง
	admins := make(map[string]bool)
	var groupInfo []win32GroupDomain
	if err := wmi.Query(`SELECT Domain FROM Win32_Group WHERE SID = 'S-1-5-32-544'`, &groupInfo); err != nil || len(groupInfo) == 0 {
		users := make([]LocalUserInfo, 0, len(accounts))
		for _, a := range accounts {
			name := strings.TrimSpace(a.Name)
			if name == "" {
				continue
			}
			users = append(users, LocalUserInfo{Username: name, FullName: strings.TrimSpace(a.FullName), Disabled: a.Disabled})
		}
		return users
	}

	// GroupComponent/PartComponent เป็น object reference แบบข้อความของ WMI
	// ไม่ใช่ column ธรรมดา — PartComponent จะได้กลับมาเป็นอะไรแบบ
	// `\\HOST\root\cimv2:Win32_UserAccount.Domain="HOST",Name="jdoe"` เลย
	// ต้อง parse membership ออกจาก string นั้นแทนที่จะ join แบบปกติ
	groupComponent := fmt.Sprintf(`Win32_Group.Domain='%s',Name='Administrators'`, groupInfo[0].Domain)
	var members []win32GroupUser
	if err := wmi.Query(fmt.Sprintf(`SELECT PartComponent FROM Win32_GroupUser WHERE GroupComponent = "%s"`, groupComponent), &members); err == nil {
		for _, m := range members {
			const marker = `Name="`
			idx := strings.Index(m.PartComponent, marker)
			if idx == -1 {
				continue
			}
			rest := m.PartComponent[idx+len(marker):]
			if end := strings.Index(rest, `"`); end != -1 {
				admins[rest[:end]] = true
			}
		}
	}

	users := make([]LocalUserInfo, 0, len(accounts))
	for _, a := range accounts {
		name := strings.TrimSpace(a.Name)
		if name == "" {
			continue
		}
		users = append(users, LocalUserInfo{
			Username: name,
			FullName: strings.TrimSpace(a.FullName),
			IsAdmin:  admins[name],
			Disabled: a.Disabled,
		})
	}
	return users
}

// collectNetworkInterfaces ให้รายละเอียดของ adapter ระดับเดียวกับที่
// "ipconfig /all" ของ Windows เองแสดง WHERE IPEnabled=TRUE ข้าม adapter
// ที่ไม่มี IP configuration ที่ active อยู่ (virtual adapter ที่ปิดหรือไม่
// ได้เชื่อมต่อ) แนวคิดเดียวกับการกรอง entry ว่างเปล่าออกที่อื่นในไฟล์นี้
func collectNetworkInterfaces() []NetworkInterface {
	var cfgs []win32NetworkAdapterConfiguration
	if err := wmi.Query(
		"SELECT Description, MACAddress, IPAddress, IPSubnet, DHCPEnabled, DHCPServer, DefaultIPGateway, DNSServerSearchOrder, DHCPLeaseObtained, DHCPLeaseExpires FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE",
		&cfgs,
	); err != nil {
		return []NetworkInterface{}
	}

	ifaces := make([]NetworkInterface, 0, len(cfgs))
	for _, c := range cfgs {
		iface := NetworkInterface{
			Name:           c.Description,
			Description:    c.Description,
			MACAddress:     c.MACAddress,
			IPAddresses:    c.IPAddress,
			SubnetMasks:    c.IPSubnet,
			DHCPEnabled:    c.DHCPEnabled,
			DHCPServer:     c.DHCPServer,
			DefaultGateway: c.DefaultIPGateway,
			DNSServers:     c.DNSServerSearchOrder,
		}
		if c.DHCPLeaseObtained != "" {
			iface.LeaseObtained = parseWMIDateTime(c.DHCPLeaseObtained)
		}
		if c.DHCPLeaseExpires != "" {
			iface.LeaseExpires = parseWMIDateTime(c.DHCPLeaseExpires)
		}
		ifaces = append(ifaces, iface)
	}
	return ifaces
}
