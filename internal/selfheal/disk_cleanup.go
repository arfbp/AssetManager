package selfheal

import (
	"time"

	"github.com/rs/zerolog"

	"optifleet-agent/internal/cleanup"
	"optifleet-agent/internal/telemetry"
)

type DiskCleanupConfig struct {
	// FreeThresholdPercent สั่ง trigger cleanup เมื่อพื้นที่ว่างของดิสก์ต่ำ
	// กว่านี้ (คือ UsedPercent >= 100-FreeThresholdPercent)
	FreeThresholdPercent float64
	// AllowedDirs คือ allowlist ไดเรกทอรีชุดเดียวกับที่คำสั่ง clean_temp จาก
	// ระยะไกลใช้ — auto-cleanup ไม่แตะอะไรนอกเหนือจากนี้เลย
	AllowedDirs []string
	// Cooldown ป้องกันไม่ให้ cleanup รันซ้ำทุก poll tick ขณะที่ดิสก์ยังต่ำ
	// กว่า threshold อยู่ (เช่น เพราะพื้นที่ที่เพิ่งเคลียร์ไปถูกใช้จนเต็มอีก
	// ทันที หรือ cleanup เคลียร์พื้นที่ได้ไม่พอ)
	Cooldown time.Duration
}

type DiskCleaner struct {
	cfg       DiskCleanupConfig
	log       zerolog.Logger
	audit     zerolog.Logger
	onEvent   func(Event)
	lastRunAt time.Time
}

func NewDiskCleaner(cfg DiskCleanupConfig, log, audit zerolog.Logger, onEvent func(Event)) *DiskCleaner {
	if cfg.FreeThresholdPercent <= 0 {
		cfg.FreeThresholdPercent = 10
	}
	if cfg.Cooldown <= 0 {
		cfg.Cooldown = 15 * time.Minute
	}
	return &DiskCleaner{
		cfg:     cfg,
		log:     log.With().Str("component", "selfheal.disk_cleanup").Logger(),
		audit:   audit,
		onEvent: onEvent,
	}
}

// Observe ควรถูกเรียกทุกครั้งที่มี telemetry snapshot จะไม่ทำอะไรเลย เว้น
// แต่ดิสก์ตัวใดตัวหนึ่งจะต่ำกว่า free-space threshold ที่ตั้งไว้ และ
// cooldown ผ่านไปแล้วนับจากการรัน cleanup ครั้งล่าสุด
func (d *DiskCleaner) Observe(snap telemetry.Snapshot) {
	defer func() {
		if r := recover(); r != nil {
			d.log.Error().Interface("panic", r).Msg("disk cleaner: observe panicked, recovered")
		}
	}()

	if len(d.cfg.AllowedDirs) == 0 {
		return
	}

	lowSpaceThreshold := 100 - d.cfg.FreeThresholdPercent
	var trigger *telemetry.DiskInfo
	for i := range snap.Disks {
		if snap.Disks[i].UsedPercent >= lowSpaceThreshold {
			trigger = &snap.Disks[i]
			break
		}
	}
	if trigger == nil {
		return
	}

	if time.Since(d.lastRunAt) < d.cfg.Cooldown {
		return
	}
	d.lastRunAt = time.Now()

	d.audit.Warn().
		Str("mount_point", trigger.MountPoint).
		Float64("used_percent", trigger.UsedPercent).
		Float64("free_gb", trigger.FreeGB).
		Msg("disk cleaner: free space below threshold, running auto-cleanup")

	for _, dir := range d.cfg.AllowedDirs {
		res, err := cleanup.Directory(d.cfg.AllowedDirs, dir)
		if err != nil {
			d.audit.Error().Err(err).Str("dir", dir).Msg("disk cleaner: cleanup failed")
			d.emit(Event{Target: dir, Action: "disk_cleanup_failed", Detail: err.Error()})
			continue
		}
		d.audit.Info().Str("dir", dir).Str("result", res.String()).Msg("disk cleaner: cleanup completed")
		d.emit(Event{Target: dir, Action: "disk_cleanup", Detail: res.String()})
	}
}

func (d *DiskCleaner) emit(e Event) {
	if d.onEvent != nil {
		d.onEvent(e)
	}
}
