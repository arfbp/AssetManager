//go:build !windows

package telemetry

import "net"

// collectNetworkInterfaces gives the basic cross-platform adapter details
// (name, MAC, IP addresses) via Go's own net package. DHCP server/lease,
// gateway, and DNS server detail — what Windows' version gets via
// Win32_NetworkAdapterConfiguration, see devices_windows.go — isn't
// available through a portable API and isn't wired up for this platform yet.
func collectNetworkInterfaces() []NetworkInterface {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
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
