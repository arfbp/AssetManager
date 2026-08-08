//go:build windows

package telemetry

import (
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

// wmiMonitorID mirrors the root\wmi WmiMonitorID class, which carries a
// monitor's raw EDID identity fields — the only place Windows exposes a
// monitor's real serial number, unlike Win32_DesktopMonitor's Name (a
// friendly display name resolved from the driver's INF, not the panel
// itself). Text fields are EDID's own encoding: one ASCII character code
// per array element, zero-padded — see decodeEDIDString.
//
// Field type is []int32, not []uint16: these are SAFEARRAY(VT_UI2)
// properties, but this build of yusufpapurcu/wmi's loadEntity decodes each
// array element into a Go int32 (verified by crash: it panics calling
// reflect.Value.Uint on an int32 Value when the field is declared []uint16).
type wmiMonitorID struct {
	InstanceName     string
	ManufacturerName []int32
	SerialNumberID   []int32
	UserFriendlyName []int32
}

// decodeEDIDString converts one of WmiMonitorID's char-per-element arrays
// back into a normal string, stopping at the first zero (EDID pads unused
// trailing bytes with nulls rather than always filling the array).
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

// isJunkEDIDSerial reports whether a decoded EDID serial-number field is a
// known placeholder rather than a real per-unit identifier. Verified on real
// hardware (a Lenovo laptop's built-in panel): its EDID literally encodes
// "0" here, unlike a swappable external monitor's genuine serial — the
// panel is never sold or serviced independently of the laptop, so the
// vendor never bothered to populate this meaningfully. Treating it as
// present would be worse than treating it as absent: every laptop of the
// same model would offer to register an asset under the identical "serial".
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

// pnpVendorNames maps the 3-letter PNP ID EDID embeds for a monitor's
// manufacturer to the brand name an operator would actually recognize.
// Not exhaustive — covers vendors likely to show up in an office fleet;
// anything else falls back to the raw code rather than guessing.
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

// collectHardwareInfo reads the machine's own serial number and model —
// asset-tracking identity, not a peripheral — via the same two WMI classes
// Windows' own System Information panel uses.
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

// collectDevices enumerates currently-connected USB devices, printers, and
// monitors via WMI. Each query is independent and best-effort — a failure
// in one (e.g. no printers configured) never blocks the others.
func collectDevices() []DeviceInfo {
	var devices []DeviceInfo
	devices = append(devices, collectUSBDevicesWindows()...)
	devices = append(devices, collectPrintersWindows()...)
	devices = append(devices, collectMonitorsWindows()...)
	return devices
}

// collectUSBDevicesWindows queries every PnP entity enumerated under the USB
// bus — this catches anything actually plugged into a USB port (storage,
// mice, keyboards, webcams, ...) regardless of its driver class, unlike
// filtering by PNPClass='USB' which only catches hubs/controllers themselves.
func collectUSBDevicesWindows() []DeviceInfo {
	var entities []win32PnPEntity
	if err := wmi.Query("SELECT Name, Manufacturer, DeviceID FROM Win32_PnPEntity WHERE DeviceID LIKE 'USB%'", &entities); err != nil {
		return nil
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
		return nil
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

// No Availability filter: verified against real hardware that
// Win32_DesktopMonitor's Availability property is not reliably populated
// for actual monitors (a connected, powered-on external display measured
// Availability=8 "Off Line" here, not the "Running/Full Power" the enum
// name implies) — the class only enumerates monitors Windows currently has
// a device entry for at all, which is itself already "is it connected".
func collectMonitorsWindows() []DeviceInfo {
	var monitors []win32DesktopMonitor
	if err := wmi.Query("SELECT Name, PNPDeviceID FROM Win32_DesktopMonitor", &monitors); err != nil {
		return nil
	}

	// EDID identity data lives in a separate WMI namespace from the rest of
	// this file's queries. Best-effort: if it fails (older hardware, driver
	// quirks), monitors still get reported with just their friendly name
	// rather than being dropped entirely.
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
		// Matched by prefix, not equality: verified on real hardware that
		// WmiMonitorID.InstanceName carries an extra "_0"-style suffix
		// Win32_DesktopMonitor.PNPDeviceID doesn't have (e.g. PNPDeviceID
		// "...UID12337" vs InstanceName "...UID12337_0") — an exact-match
		// join would silently never fire.
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

// msftPhysicalDisk mirrors the modern Storage Management API's own view of a
// physical drive (root\Microsoft\Windows\Storage namespace) — unlike the
// older Win32_DiskDrive.MediaType, which was verified on real hardware to
// just say "Fixed hard disk media" for both an SSD and a spinning disk,
// MSFT_PhysicalDisk.MediaType actually distinguishes them.
type msftPhysicalDisk struct {
	FriendlyName string
	MediaType    uint16
	Size         uint64
}

// mediaTypeNames mirrors MSFT_PhysicalDisk's MediaType enum (Microsoft's own
// documented values — 0/1/2 exist too but never show up on real disks, only
// 3/4/5 do): 3=HDD, 4=SSD, 5=SCM (storage-class memory, treated as SSD-like
// but rare enough not to bother with its own label).
var mediaTypeNames = map[uint16]string{3: "HDD", 4: "SSD", 5: "SSD"}

// collectPhysicalDisks enumerates physical storage devices — spec inventory
// (what drives exist, SSD or HDD, how big), separate from collectDisks'
// per-mount-point usage percentages. Best-effort: root\Microsoft\Windows\
// Storage is part of the Storage Management API, present on Windows 8/2012
// and later — if the query fails for any reason (older OS, driver quirk),
// this degrades to an empty list rather than failing the whole snapshot.
func collectPhysicalDisks() []PhysicalDiskInfo {
	var raw []msftPhysicalDisk
	if err := wmi.QueryNamespace(
		"SELECT FriendlyName, MediaType, Size FROM MSFT_PhysicalDisk",
		&raw, `root\Microsoft\Windows\Storage`,
	); err != nil {
		// A nil Go slice marshals to JSON `null`, not `[]` — the frontend
		// calls .length on this field unconditionally (same assumption every
		// other array field in a snapshot already makes), so this returns an
		// empty-but-non-nil slice on failure rather than nil.
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

// win32NetworkAdapterConfiguration mirrors the WMI class ipconfig.exe itself
// is built on — this is what actually backs a detailed "ipconfig /all"-style
// answer (DHCP server/lease, gateway, DNS), not just the bare IP list
// collectIPAddresses already provides for the simpler "what's this machine's
// IP" case.
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

// parseWMIDateTime converts WMI's own datetime encoding
// ("yyyymmddHHMMSS.ffffff+UUU", the +UUU being a UTC offset in minutes, not
// used here) into a plain readable string. Falls back to the raw value if
// it doesn't parse — better a slightly odd string reaches an operator than
// this silently drops the lease dates entirely.
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

// collectNetworkInterfaces gets the same level of adapter detail Windows'
// own "ipconfig /all" shows. WHERE IPEnabled=TRUE skips adapters with no
// active IP configuration (disabled/disconnected virtual adapters), same
// idea as filtering out empty entries elsewhere in this file.
func collectNetworkInterfaces() []NetworkInterface {
	var cfgs []win32NetworkAdapterConfiguration
	if err := wmi.Query(
		"SELECT Description, MACAddress, IPAddress, IPSubnet, DHCPEnabled, DHCPServer, DefaultIPGateway, DNSServerSearchOrder, DHCPLeaseObtained, DHCPLeaseExpires FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE",
		&cfgs,
	); err != nil {
		return nil
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
