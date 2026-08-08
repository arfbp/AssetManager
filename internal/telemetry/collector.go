package telemetry

import (
	"context"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"

	cpuutil "github.com/shirou/gopsutil/v3/cpu"
	diskutil "github.com/shirou/gopsutil/v3/disk"
	hostutil "github.com/shirou/gopsutil/v3/host"
	memutil "github.com/shirou/gopsutil/v3/mem"
	processutil "github.com/shirou/gopsutil/v3/process"
)

const bytesPerMB = 1024 * 1024
const bytesPerGB = 1024 * 1024 * 1024

type Collector struct {
	// topN <= 0 means "no cap — report every running process". A positive
	// value caps the report to that many, sorted by CPU descending.
	topN int
}

func NewCollector(topN int) *Collector {
	return &Collector{topN: topN}
}

// Collect gathers one telemetry snapshot. It never returns a partial error
// for a single subsystem failure (e.g. one inaccessible process) — those are
// skipped individually so a full snapshot still reaches the server.
func (c *Collector) Collect(ctx context.Context) (Snapshot, error) {
	snap := Snapshot{Timestamp: time.Now().UTC()}

	// cpu.Percent with a short blocking interval gives a real sampled value
	// rather than a since-boot average.
	cpuPercents, err := cpuutil.PercentWithContext(ctx, 200*time.Millisecond, false)
	if err != nil {
		return snap, fmt.Errorf("telemetry: cpu percent: %w", err)
	}
	if len(cpuPercents) > 0 {
		snap.CPUPercent = cpuPercents[0]
	}

	vm, err := memutil.VirtualMemoryWithContext(ctx)
	if err != nil {
		return snap, fmt.Errorf("telemetry: virtual memory: %w", err)
	}
	snap.MemPercent = vm.UsedPercent
	snap.MemUsedMB = float64(vm.Used) / bytesPerMB
	snap.MemTotalMB = float64(vm.Total) / bytesPerMB

	snap.Disks = c.collectDisks(ctx)
	snap.PhysicalDisks = collectPhysicalDisks()
	snap.TopProcs = c.collectTopProcesses(ctx)
	snap.Devices = collectDevices()
	c.collectHostInfo(ctx, &snap)

	if infos, err := cpuutil.InfoWithContext(ctx); err == nil && len(infos) > 0 {
		snap.CPUModel = strings.TrimSpace(infos[0].ModelName)
	}

	return snap, nil
}

// collectHostInfo fills in hostname/IP/OS/uptime — best-effort like every
// other sub-collector here: a failure in one field never blocks the rest of
// the snapshot. This is what backs read-only "what's this device's IP /
// uptime / OS version" questions asked through the AI console
// (server/src/llm/queryAnswerer.ts) without needing a dedicated round-trip
// command to the agent for information it already reports every snapshot.
func (c *Collector) collectHostInfo(ctx context.Context, snap *Snapshot) {
	if info, err := hostutil.InfoWithContext(ctx); err == nil {
		snap.Hostname = info.Hostname
		snap.OS = info.Platform
		snap.OSVersion = info.PlatformVersion
		snap.UptimeSeconds = info.Uptime
	}
	snap.SerialNumber, snap.Model, snap.Manufacturer = collectHardwareInfo()
	snap.IPAddresses = collectIPAddresses()
	snap.PublicIP = collectPublicIP()
	snap.NetworkInterfaces = collectNetworkInterfaces()
}

// collectIPAddresses lists non-loopback IPv4 addresses across all
// interfaces that are actually up — the "what's this machine's IP" answer
// for a LAN-deployed fleet. A machine with several NICs (Wi-Fi + Ethernet +
// a VPN adapter) legitimately has more than one; all are reported rather
// than guessing which is "the" address.
func collectIPAddresses() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var ips []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil {
				continue // skip IPv6 — noisier and rarely what "what's the IP" means here
			}
			ips = append(ips, ip4.String())
		}
	}
	return ips
}

func (c *Collector) collectDisks(ctx context.Context) []DiskInfo {
	parts, err := diskutil.PartitionsWithContext(ctx, false)
	if err != nil {
		return nil
	}
	disks := make([]DiskInfo, 0, len(parts))
	for _, p := range parts {
		usage, err := diskutil.UsageWithContext(ctx, p.Mountpoint)
		if err != nil {
			continue // e.g. removable media not ready — skip, don't fail the snapshot
		}
		disks = append(disks, DiskInfo{
			MountPoint:  p.Mountpoint,
			UsedPercent: usage.UsedPercent,
			FreeGB:      float64(usage.Free) / bytesPerGB,
			TotalGB:     float64(usage.Total) / bytesPerGB,
		})
	}
	return disks
}

func (c *Collector) collectTopProcesses(ctx context.Context) []ProcessInfo {
	procs, err := processutil.ProcessesWithContext(ctx)
	if err != nil {
		return nil
	}

	hung := hungWindowPIDs()

	infos := make([]ProcessInfo, 0, len(procs))
	for _, p := range procs {
		name, err := p.NameWithContext(ctx)
		if err != nil {
			continue // process likely exited between listing and read — skip it
		}
		cpuPct, _ := p.CPUPercentWithContext(ctx)
		memMB := 0.0
		if mi, err := p.MemoryInfoWithContext(ctx); err == nil && mi != nil {
			memMB = float64(mi.RSS) / bytesPerMB
		}
		infos = append(infos, ProcessInfo{
			PID:        p.Pid,
			Name:       name,
			CPUPercent: cpuPct,
			MemMB:      memMB,
			Responding: !hung[p.Pid],
		})
	}

	sort.Slice(infos, func(i, j int) bool {
		return infos[i].CPUPercent > infos[j].CPUPercent
	})
	if c.topN > 0 && len(infos) > c.topN {
		infos = infos[:c.topN]
	}
	return infos
}
