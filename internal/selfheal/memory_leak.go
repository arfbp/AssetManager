package selfheal

import (
	"sync"
	"time"

	"optifleet-agent/internal/telemetry"
)

type LeakConfig struct {
	// GrowthThresholdMB คือปริมาณที่ RSS ของ process ต้องโตขึ้นตลอด tracking
	// window ก่อนจะถูก flag
	GrowthThresholdMB float64
	// MinSamples คือจำนวน telemetry snapshot ติดต่อกันที่ process ต้อง
	// ปรากฏอยู่ — แต่ละครั้งต้องไม่ลดลงจากครั้งก่อน — ก่อนจะ flag นี่คือ
	// สิ่งที่แยก "leak" ออกจาก "spike โผล่มาครั้งเดียว"
	MinSamples int
	// WindowSize จำกัดจำนวน sample ต่อ PID ที่เก็บไว้; ถ้าไม่ set จะ default
	// เป็น MinSamples+2
	WindowSize int
}

type memSample struct {
	at    time.Time
	memMB float64
}

// LeakAlert อธิบาย leak ที่ต้องสงสัยหนึ่งรายการ ตรวจพบครั้งแรกเท่านั้น —
// PID หนึ่งตัวจะถูกรายงานแค่ครั้งเดียวต่อการปรากฏต่อเนื่องหนึ่งช่วงใน
// process set ที่ track อยู่
type LeakAlert struct {
	PID       int32
	Name      string
	StartMB   float64
	CurrentMB float64
	Samples   int
}

// Detector track RSS ของแต่ละ process ข้าม telemetry snapshot เพื่อจับ
// process ที่หน่วยความจำโตขึ้นแบบ monotonic แทนที่จะแกว่งขึ้นลง — ลักษณะ
// เฉพาะของ leak มากกว่าความแปรผันปกติของ workload เก็บ sample ไม่เกิน
// WindowSize ต่อ PID ที่กำลัง track อยู่ ทำให้การใช้หน่วยความจำคงที่ไม่ว่า
// uptime จะนานแค่ไหนก็ตาม
type Detector struct {
	cfg     LeakConfig
	mu      sync.Mutex
	history map[int32][]memSample
	names   map[int32]string
	flagged map[int32]bool
}

func NewDetector(cfg LeakConfig) *Detector {
	if cfg.GrowthThresholdMB <= 0 {
		cfg.GrowthThresholdMB = 500
	}
	if cfg.MinSamples <= 0 {
		cfg.MinSamples = 5
	}
	if cfg.WindowSize <= 0 {
		cfg.WindowSize = cfg.MinSamples + 2
	}
	return &Detector{
		cfg:     cfg,
		history: make(map[int32][]memSample),
		names:   make(map[int32]string),
		flagged: make(map[int32]bool),
	}
}

// Observe ป้อน top-process list ของ snapshot หนึ่งอันเข้าไป แล้วคืน leak
// candidate ที่เพิ่งตรวจพบใหม่ (ถ้ามี)
func (d *Detector) Observe(snap telemetry.Snapshot) []LeakAlert {
	d.mu.Lock()
	defer d.mu.Unlock()

	seen := make(map[int32]bool, len(snap.TopProcs))
	var alerts []LeakAlert

	for _, p := range snap.TopProcs {
		seen[p.PID] = true
		d.names[p.PID] = p.Name

		hist := append(d.history[p.PID], memSample{at: snap.Timestamp, memMB: p.MemMB})
		if len(hist) > d.cfg.WindowSize {
			hist = hist[len(hist)-d.cfg.WindowSize:]
		}
		d.history[p.PID] = hist

		if d.flagged[p.PID] {
			continue
		}
		if alert, ok := d.evaluate(p.PID, hist); ok {
			d.flagged[p.PID] = true
			alerts = append(alerts, alert)
		}
	}

	// process ที่หลุดออกจาก top-N list จะไม่ track ต่ออีก — อาจจะเพราะ exit
	// ไปแล้ว หรือไม่น่ากังวลเรื่องหน่วยความจำแล้ว
	for pid := range d.history {
		if !seen[pid] {
			delete(d.history, pid)
			delete(d.names, pid)
			delete(d.flagged, pid)
		}
	}

	return alerts
}

func (d *Detector) evaluate(pid int32, hist []memSample) (LeakAlert, bool) {
	if len(hist) < d.cfg.MinSamples {
		return LeakAlert{}, false
	}

	const noiseToleranceMB = 1.0
	for i := 1; i < len(hist); i++ {
		if hist[i].memMB < hist[i-1].memMB-noiseToleranceMB {
			return LeakAlert{}, false // ลดลง — ไม่ใช่ pattern leak แบบ monotonic
		}
	}

	growth := hist[len(hist)-1].memMB - hist[0].memMB
	if growth < d.cfg.GrowthThresholdMB {
		return LeakAlert{}, false
	}

	return LeakAlert{
		PID:       pid,
		Name:      d.names[pid],
		StartMB:   hist[0].memMB,
		CurrentMB: hist[len(hist)-1].memMB,
		Samples:   len(hist),
	}, true
}
