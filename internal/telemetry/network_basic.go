//go:build !windows

package telemetry

import "net"

// collectNetworkInterfaces ให้รายละเอียด adapter แบบ cross-platform
// พื้นฐาน (name, MAC, IP address) ผ่าน net package ของ Go เอง รายละเอียด
// DHCP server/lease, gateway, และ DNS server — ที่ฝั่ง Windows ได้จาก
// Win32_NetworkAdapterConfiguration ดู devices_windows.go — ไม่มี portable
// API ให้ใช้ และยังไม่ได้ต่อสายไว้สำหรับแพลตฟอร์มนี้
func collectNetworkInterfaces() []NetworkInterface {
	ifaces, err := net.Interfaces()
	if err != nil {
		// เป็น slice ว่างแต่ไม่ใช่ nil — slice ที่เป็น nil ใน Go จะ marshal
		// เป็น JSON `null` และฝั่ง frontend เรียก .length บน field นี้โดย
		// ไม่เช็คก่อน
		return []NetworkInterface{}
	}
	result := make([]NetworkInterface, 0, len(ifaces))
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		var ips []string
		for _, a := range addrs {
			if ipNet, ok := a.(*net.IPNet); ok {
				ips = append(ips, ipNet.IP.String())
			}
		}
		if len(ips) == 0 {
			continue
		}
		result = append(result, NetworkInterface{
			Name:        iface.Name,
			MACAddress:  iface.HardwareAddr.String(),
			IPAddresses: ips,
		})
	}
	return result
}
