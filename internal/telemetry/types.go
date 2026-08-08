package telemetry

import "time"

// Mode is the current polling cadence the agent is operating under.
type Mode string

const (
	ModeNormal Mode = "normal"
	ModeAlert  Mode = "alert"
)

// Responding is only meaningful on Windows, where a top-level window that
// stops pumping its message queue gets flagged by the OS itself as hung —
// the same state Task Manager labels "(Not Responding)". Always true
// elsewhere (and true for processes with no top-level window at all, e.g.
// background services, since those were never capable of "not responding"
// in this sense to begin with) — see hungWindowPIDsWindows.
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

// PhysicalDiskInfo is one physical storage device — spec inventory ("what
// drives does this machine have, SSD or HDD, how big"), not usage. Reported
// as its own flat list rather than joined onto DiskInfo's per-mount-point
// entries: a physical disk maps to a logical drive letter through several
// layers of OS-specific association (partitions, volumes, dynamic disks/
// RAID) that don't reduce to a clean one-to-one join, so this answers "what
// physical drives exist" and DiskInfo separately answers "how full is each
// mounted volume" — related but genuinely different questions. Windows-only
// today (see collectPhysicalDisksWindows); MediaType is "SSD", "HDD", or
// "Unknown" (the OS didn't report a reliable answer either way).
type PhysicalDiskInfo struct {
	Model     string  `json:"model"`
	MediaType string  `json:"media_type"`
	SizeGB    float64 `json:"size_gb"`
}

// DeviceInfo is one currently-connected peripheral — a snapshot of "what's
// plugged in right now", not a connect/disconnect history. Type is one of
// "usb", "printer", "monitor". Detail is best-effort extra context
// (manufacturer, default-printer flag, ...) and may be empty if the OS
// didn't report one. SerialNumber/Model/Manufacturer are only populated
// where the OS exposes real identifying data for that device class (today:
// monitors, via EDID over WMI's root\wmi WmiMonitorID — see
// collectMonitorsWindows) so an operator can register the peripheral itself
// as an asset without typing its serial by hand.
type DeviceInfo struct {
	Type         string `json:"type"`
	Name         string `json:"name"`
	Detail       string `json:"detail,omitempty"`
	SerialNumber string `json:"serial_number,omitempty"`
	Model        string `json:"model,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
}

// NetworkInterface is one adapter's full configuration — the same level of
// detail Windows' own "ipconfig /all" shows, not just the bare IP address
// list IPAddresses carries (which exists separately for the simple "what's
// this machine's IP" case and predates this). DHCP/gateway/DNS/lease fields
// are Windows-only (via Win32_NetworkAdapterConfiguration) and stay empty
// elsewhere; Name/MAC/IP/Subnet come from the cross-platform net package on
// every OS.
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

// Snapshot is a single point-in-time telemetry reading.
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
	// This machine's real internet-facing address, from an external lookup
	// — see publicip.go. Empty until the background refresh completes
	// (typically within a second or two of agent startup) or if the lookup
	// has never succeeded (no internet egress, external service down, ...).
	PublicIP          string             `json:"public_ip"`
	NetworkInterfaces []NetworkInterface `json:"network_interfaces"`
	OS                string             `json:"os"`
	OSVersion         string             `json:"os_version"`
	UptimeSeconds     uint64             `json:"uptime_seconds"`
	SerialNumber      string             `json:"serial_number"`
	Model             string             `json:"model"`
	Manufacturer      string             `json:"manufacturer"`
	// CPU model name (e.g. "Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz") — via
	// gopsutil's cross-platform cpu.Info, unlike PhysicalDisks/DeviceInfo's
	// EDID data which are Windows-only WMI queries.
	CPUModel string `json:"cpu_model"`
}

// IsOverThreshold reports whether this snapshot alone justifies alert mode.
func (s Snapshot) IsOverThreshold(cpuThreshold, memThreshold float64) bool {
	return s.CPUPercent >= cpuThreshold || s.MemPercent >= memThreshold
}
