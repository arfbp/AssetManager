package telemetry

import (
	"context"
	"time"

	"github.com/rs/zerolog"
)

// PollerConfig คุมรอบความถี่ normal/alert และ threshold ที่ใช้สลับระหว่าง
// สองโหมดนั้น
type PollerConfig struct {
	NormalInterval    time.Duration
	AlertInterval     time.Duration
	CPUThreshold      float64
	MemThreshold      float64
	RecoveryStreak    int // จำนวนค่าที่อ่านได้ปกติติดต่อกันที่ต้องมีก่อนจะออกจาก alert mode
	TopNProcesses     int
}

// Poller ขับเคลื่อนการเก็บ telemetry ด้วย interval แบบ dynamic: ปกติจะตื่น
// ตาม NormalInterval และทันทีที่ค่าที่อ่านได้ข้าม threshold ของ CPU/mem —
// จะลดลงมาเป็น AlertInterval จนกว่าจะมีค่าที่อ่านได้ปกติติดต่อกันครบ
// RecoveryStreak ครั้ง (hysteresis ช่วยไม่ให้โหมดสลับไปมาถี่ ๆ เมื่อค่า
// metric แกว่งอยู่ใกล้เส้น threshold พอดี)
type Poller struct {
	cfg       PollerConfig
	collector *Collector
	log       zerolog.Logger
	onSnapshot func(Snapshot)
	trigger    chan struct{}
}

func NewPoller(cfg PollerConfig, log zerolog.Logger, onSnapshot func(Snapshot)) *Poller {
	return &Poller{
		cfg:        cfg,
		collector:  NewCollector(cfg.TopNProcesses),
		log:        log,
		onSnapshot: onSnapshot,
		trigger:    make(chan struct{}, 1),
	}
}

// TriggerNow ขอให้เก็บ+ส่งข้อมูลนอกรอบทันทีที่ loop ของ Run ตื่นครั้งถัดไป
// แทนที่จะรอจน NormalInterval (นานได้หลายนาที) — ต่อสายให้ยิงทันทีหลัง
// คำสั่งที่เปลี่ยนสิ่งที่ snapshot รอบถัดไปจะแสดงอย่างเห็นได้ชัด
// (kill_process, clean_temp) เพื่อให้ dashboard สะท้อนผลทันที แทนที่จะดู
// ค้าง non-blocking และเรียกจาก goroutine อื่นได้อย่างปลอดภัย
// (executor.Handle รันอยู่บน read loop ของ transport): ถ้ามี trigger
// ค้างอยู่แล้ว ตรงนี้ก็แค่ no-op ไม่บล็อก caller
func (p *Poller) TriggerNow() {
	select {
	case p.trigger <- struct{}{}:
	default:
	}
}

// Run block อยู่จนกว่า ctx จะถูก cancel ใช้ timer ตัวเดียวที่ reset
// duration หลังทุกครั้งที่อ่านค่า แทนที่จะใช้ ticker สองตัวแข่งกัน เพื่อให้
// การสลับโหมดมีผลตั้งแต่การตื่นครั้งถัดไปทันที
func (p *Poller) Run(ctx context.Context) {
	mode := ModeNormal
	normalStreak := 0

	timer := time.NewTimer(0) // ยิงทันทีตอนเริ่ม
	defer timer.Stop()

	collect := func() {
		snap, err := p.collector.Collect(ctx)
		if err != nil {
			p.log.Error().Err(err).Msg("poller: collection failed, will retry next tick")
			return
		}
		snap.Mode = mode

		over := snap.IsOverThreshold(p.cfg.CPUThreshold, p.cfg.MemThreshold)
		switch {
		case over && mode == ModeNormal:
			mode = ModeAlert
			normalStreak = 0
			p.log.Warn().
				Float64("cpu_percent", snap.CPUPercent).
				Float64("mem_percent", snap.MemPercent).
				Msg("poller: threshold exceeded, entering alert mode")
		case !over && mode == ModeAlert:
			normalStreak++
			if normalStreak >= p.cfg.RecoveryStreak {
				mode = ModeNormal
				normalStreak = 0
				p.log.Info().Msg("poller: readings normalized, returning to normal polling interval")
			}
		case over && mode == ModeAlert:
			normalStreak = 0
		}

		if p.onSnapshot != nil {
			p.onSnapshot(snap)
		}
	}

	for {
		select {
		case <-ctx.Done():
			p.log.Info().Msg("poller: shutting down")
			return
		case <-p.trigger:
			// timer ปกติยังไม่ยิง — หยุดมันแล้ว drain tick ที่อาจแข่งกันอยู่
			// ก่อนเก็บข้อมูลนอกรอบ แล้วเริ่มรอบปกติใหม่จากตอนนี้ (ดู doc ของ
			// time.Timer.Reset เองว่าทำไมการ Reset เฉย ๆ โดยไม่ Stop+drain
			// ก่อนถึงไม่ปลอดภัยตรงนี้ ต่างจาก branch timer.C ด้านล่างที่การ
			// อ่าน channel ได้ drain ไปแล้ว)
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			collect()
			timer.Reset(p.intervalFor(mode))
		case <-timer.C:
			collect()
			timer.Reset(p.intervalFor(mode))
		}
	}
}

func (p *Poller) intervalFor(mode Mode) time.Duration {
	if mode == ModeAlert {
		return p.cfg.AlertInterval
	}
	return p.cfg.NormalInterval
}
