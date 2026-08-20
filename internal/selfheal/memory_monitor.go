package selfheal

import (
	"github.com/rs/zerolog"

	"optifleet-agent/internal/telemetry"
)

// LeakEvent คือสิ่งที่ถูกรายงานขึ้นไปเมื่อพบ leak ที่ต้องสงสัย
type LeakEvent struct {
	LeakAlert
	TrimAttempted bool
	TrimError     string
}

type MemoryMonitor struct {
	detector *Detector
	log      zerolog.Logger
	audit    zerolog.Logger
	onLeak   func(LeakEvent)
}

func NewMemoryMonitor(cfg LeakConfig, log, audit zerolog.Logger, onLeak func(LeakEvent)) *MemoryMonitor {
	return &MemoryMonitor{
		detector: NewDetector(cfg),
		log:      log.With().Str("component", "selfheal.memory_monitor").Logger(),
		audit:    audit,
		onLeak:   onLeak,
	}
}

// Observe ควรถูกเรียกทุกครั้งที่มี telemetry snapshot — ต่อสายเข้ากับ
// poller callback ตัวเดียวกับที่ forward snapshot ไปให้ server เมื่อพบ leak
// ที่ต้องสงสัย จะพยายาม trim working-set (เฉพาะ Windows; แพลตฟอร์มอื่นจะได้
// error แบบ no-op) และรายงาน event ขึ้นไปเสมอ
//
// ตั้งใจไม่ kill หรือ restart process ที่มีปัญหาเอง: สัญญาณ heuristic แบบ
// growth เป็น monotonic ยังไม่น่าเชื่อถือพอที่จะเอาไปทำลายงานที่ user ยังไม่
// ได้ save แบบเงียบ ๆ ได้ ตรงนี้แค่ surface alert ออกไป แล้วปล่อยให้คนที่ดูแล
// policy ฝั่ง server เป็นคนตัดสินใจ — ซึ่งจะ push คำสั่ง kill_process ที่
// เซ็นแล้วชัดเจนได้ถ้าตัดสินใจแบบนั้น
func (m *MemoryMonitor) Observe(snap telemetry.Snapshot) {
	defer func() {
		if r := recover(); r != nil {
			m.log.Error().Interface("panic", r).Msg("memory monitor: observe panicked, recovered")
		}
	}()

	for _, a := range m.detector.Observe(snap) {
		event := LeakEvent{LeakAlert: a}

		m.audit.Warn().
			Int32("pid", a.PID).
			Str("process", a.Name).
			Float64("start_mb", a.StartMB).
			Float64("current_mb", a.CurrentMB).
			Int("samples", a.Samples).
			Msg("memory monitor: suspected leak detected")

		if err := TrimWorkingSet(a.PID); err != nil {
			event.TrimError = err.Error()
			m.log.Warn().Err(err).Int32("pid", a.PID).Msg("memory monitor: working-set trim failed or unsupported on this platform")
		} else {
			event.TrimAttempted = true
			m.audit.Info().Int32("pid", a.PID).Msg("memory monitor: working set trimmed")
		}

		if m.onLeak != nil {
			m.onLeak(event)
		}
	}
}
