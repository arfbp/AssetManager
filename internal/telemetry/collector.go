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
	// topN <= 0 แปลว่า "ไม่มี cap — รายงานทุก process ที่รันอยู่" ค่าที่เป็น
	// บวกจะ cap รายงานไว้เท่านั้น เรียงจาก CPU มากไปน้อย
	topN int
}

func NewCollector(topN int) *Collector {
	return &Collector{topN: topN}
}

// Collect เก็บ telemetry snapshot หนึ่งชุด จะไม่คืน error บางส่วนแค่เพราะ
// subsystem เดียวล้มเหลว (เช่น process ที่เข้าถึงไม่ได้ตัวหนึ่ง) — ตัวที่
// พังจะถูกข้ามไปทีละตัว เพื่อให้ snapshot เต็มชุดยังส่งถึง server ได้
func (c *Collector) Collect(ctx context.Context) (Snapshot, error) {
	snap := Snapshot{Timestamp: time.Now().UTC()}

	// cpu.Percent ที่ใช้ interval สั้น ๆ แบบ blocking ให้ค่าที่ sample จริง
	// แทนที่จะเป็นค่าเฉลี่ยนับตั้งแต่ boot
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

// collectHostInfo เติมข้อมูล hostname/IP/OS/uptime — best-effort เหมือน
// sub-collector อื่น ๆ ทั้งหมดตรงนี้: field หนึ่งล้มเหลวจะไม่บล็อกส่วนที่
// เหลือของ snapshot นี่คือสิ่งที่รองรับคำถาม read-only แบบ "IP / uptime /
// เวอร์ชัน OS ของเครื่องนี้คืออะไร" ที่ถามผ่าน AI console
// (server/src/llm/queryAnswerer.ts) โดยไม่ต้องมีคำสั่ง round-trip แยก
// เฉพาะไปหา agent สำหรับข้อมูลที่มันรายงานอยู่แล้วทุก snapshot
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
	snap.LocalUsers = collectLocalUsers()
	snap.CurrentUser = collectCurrentUser()
}

// collectIPAddresses แสดง IPv4 address ที่ไม่ใช่ loopback ของทุก interface
// ที่ up อยู่จริง — คำตอบของ "IP เครื่องนี้คืออะไร" สำหรับฟลีตที่ deploy
// อยู่ใน LAN เครื่องที่มีหลาย NIC (Wi-Fi + Ethernet + VPN adapter) มี IP
// มากกว่าหนึ่งอันได้จริง ๆ เลยรายงานทั้งหมดแทนที่จะเดาว่าอันไหนคือ "ตัว
// จริง"
func collectIPAddresses() []string {
	// เป็น slice ว่างแต่ไม่ใช่ nil ทุก path — slice ที่เป็น nil ใน Go จะ
	// marshal เป็น JSON `null` และฝั่ง frontend เรียก .length บน field นี้
	// โดยไม่เช็คก่อน ใช้ convention เดียวกับ
	// collectPhysicalDisks/collectLocalUsers
	ips := []string{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return ips
	}
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
				continue // ข้าม IPv6 — รกกว่าและแทบไม่ใช่สิ่งที่คำถาม "IP คืออะไร" ต้องการที่นี่
			}
			ips = append(ips, ip4.String())
		}
	}
	return ips
}

func (c *Collector) collectDisks(ctx context.Context) []DiskInfo {
	parts, err := diskutil.PartitionsWithContext(ctx, false)
	if err != nil {
		// เป็น slice ว่างแต่ไม่ใช่ nil — slice ที่เป็น nil ใน Go จะ marshal
		// เป็น JSON `null` และฝั่ง frontend เรียก .length บน field นี้โดยไม่
		// เช็คก่อน
		return []DiskInfo{}
	}
	disks := make([]DiskInfo, 0, len(parts))
	for _, p := range parts {
		usage, err := diskutil.UsageWithContext(ctx, p.Mountpoint)
		if err != nil {
			continue // เช่น removable media ยังไม่พร้อม — ข้ามไป ไม่ต้องทำให้ snapshot ทั้งชุดล้มเหลว
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
		// เป็น slice ว่างแต่ไม่ใช่ nil — slice ที่เป็น nil ใน Go จะ marshal
		// เป็น JSON `null` และฝั่ง frontend เรียก .length บน field นี้โดยไม่
		// เช็คก่อน
		return []ProcessInfo{}
	}

	hung := hungWindowPIDs()

	infos := make([]ProcessInfo, 0, len(procs))
	for _, p := range procs {
		name, err := p.NameWithContext(ctx)
		if err != nil {
			continue // process น่าจะ exit ไปแล้วระหว่างช่วง listing กับ read — ข้ามไป
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
