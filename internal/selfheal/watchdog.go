package selfheal

import (
	"context"
	"time"

	"github.com/rs/zerolog"
)

type ServiceWatchdogConfig struct {
	// Services คือรายชื่อ service ที่ต้องจับตาดู กำหนดไว้ตายตัวในเครื่อง
	// (เช่น "Spooler", "postgresql-x64-16", "OpenVPNService") ไม่มีการขยาย
	// รายการนี้ตอน runtime ด้วยคำสั่งจากระยะไกลเลย
	Services []string
	// CheckInterval คือความถี่ในการ poll สถานะของแต่ละ service
	CheckInterval time.Duration
	// MaxRestartsPerHour จำกัดจำนวนครั้งที่ watchdog จะ restart service
	// เดียวกันภายในหนึ่งชั่วโมงแบบ rolling — เกินกว่านั้นถือว่าเป็น crash
	// loop ไม่ใช่ความล้มเหลวชั่วคราวแล้ว และการปล่อยให้ fail ต่อไปแบบเงียบ ๆ
	// ก็เป็น pattern แบบซ่อนเร้นที่ agent นี้ตั้งใจเลี่ยง: มันจะหยุดแตะ
	// service นั้นแล้ว audit-log การระงับนี้แบบดัง ๆ แทน
	MaxRestartsPerHour int
}

// Event ถูก emit สำหรับทุก self-healing action ที่ควร surface ไปให้ server
// — รูปแบบเดียวกันใช้ร่วมกันทั้ง service watchdog, disk cleaner, และ (ผ่าน
// LeakEvent) memory monitor Target คือสิ่งที่ถูกกระทำ (ชื่อ service หรือ
// path ไดเรกทอรี แล้วแต่ prefix ของ Action)
type Event struct {
	Target string
	Action string // e.g. "restarted" | "restart_failed" | "restart_suppressed" | "disk_cleanup"
	Detail string
}

type ServiceWatchdog struct {
	cfg   ServiceWatchdogConfig
	ctl   ServiceController
	log   zerolog.Logger
	audit zerolog.Logger
	onEvent func(Event)

	restartHistory map[string][]time.Time
}

func NewServiceWatchdog(cfg ServiceWatchdogConfig, ctl ServiceController, log, audit zerolog.Logger, onEvent func(Event)) *ServiceWatchdog {
	if cfg.CheckInterval <= 0 {
		cfg.CheckInterval = time.Minute
	}
	if cfg.MaxRestartsPerHour <= 0 {
		cfg.MaxRestartsPerHour = 5
	}
	return &ServiceWatchdog{
		cfg:            cfg,
		ctl:            ctl,
		log:            log.With().Str("component", "selfheal.service_watchdog").Logger(),
		audit:          audit,
		onEvent:        onEvent,
		restartHistory: make(map[string][]time.Time),
	}
}

// Run block อยู่จนกว่า ctx จะถูก cancel โดยเช็ค service ที่ config ไว้
// ทั้งหมดตาม CheckInterval (บวกอีกหนึ่งครั้งทันทีตอนเริ่ม)
func (w *ServiceWatchdog) Run(ctx context.Context) {
	if len(w.cfg.Services) == 0 {
		w.log.Info().Msg("service watchdog: no services configured, idle")
		<-ctx.Done()
		return
	}

	ticker := time.NewTicker(w.cfg.CheckInterval)
	defer ticker.Stop()

	w.checkAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.checkAll(ctx)
		}
	}
}

func (w *ServiceWatchdog) checkAll(ctx context.Context) {
	for _, name := range w.cfg.Services {
		w.checkOne(ctx, name)
	}
}

func (w *ServiceWatchdog) checkOne(ctx context.Context, name string) {
	defer func() {
		if r := recover(); r != nil {
			w.log.Error().Interface("panic", r).Str("service", name).Msg("service watchdog: check panicked, recovered")
		}
	}()

	state, err := w.ctl.Status(ctx, name)
	if err != nil {
		w.log.Warn().Err(err).Str("service", name).Msg("service watchdog: status check failed")
		return
	}
	if state != StateStopped {
		return
	}

	if !w.allowRestart(name) {
		w.audit.Warn().Str("service", name).Int("max_per_hour", w.cfg.MaxRestartsPerHour).
			Msg("service watchdog: restart suppressed — exceeded max restarts/hour, possible crash loop")
		w.emit(Event{Target: name, Action: "restart_suppressed", Detail: "exceeded max restarts per hour"})
		return
	}

	w.audit.Warn().Str("service", name).Msg("service watchdog: service found stopped, restarting")
	if err := w.ctl.Start(ctx, name); err != nil {
		w.audit.Error().Err(err).Str("service", name).Msg("service watchdog: restart failed")
		w.emit(Event{Target: name, Action: "restart_failed", Detail: err.Error()})
		return
	}
	w.audit.Info().Str("service", name).Msg("service watchdog: restarted successfully")
	w.emit(Event{Target: name, Action: "restarted", Detail: "service was stopped, agent restarted it"})
}

func (w *ServiceWatchdog) emit(e Event) {
	if w.onEvent != nil {
		w.onEvent(e)
	}
}

// allowRestart บังคับใช้ cap การ restart แบบ rolling-hour ต่อชื่อ service
func (w *ServiceWatchdog) allowRestart(name string) bool {
	now := time.Now()
	cutoff := now.Add(-time.Hour)
	history := w.restartHistory[name]

	kept := history[:0]
	for _, t := range history {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= w.cfg.MaxRestartsPerHour {
		w.restartHistory[name] = kept
		return false
	}
	w.restartHistory[name] = append(kept, now)
	return true
}
