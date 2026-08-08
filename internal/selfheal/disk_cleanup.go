package selfheal

import (
	"time"

	"github.com/rs/zerolog"

	"optifleet-agent/internal/cleanup"
	"optifleet-agent/internal/telemetry"
)

type DiskCleanupConfig struct {
	// FreeThresholdPercent triggers cleanup when a disk's free space drops
	// below this (i.e. UsedPercent >= 100-FreeThresholdPercent).
	FreeThresholdPercent float64
	// AllowedDirs is the same directory allowlist used by the remote
	// clean_temp command — auto-cleanup never touches anything outside it.
	AllowedDirs []string
	// Cooldown prevents re-running cleanup every poll tick while a disk
	// stays under threshold (e.g. because the freed space gets consumed
	// again immediately, or cleanup couldn't free enough).
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

// Observe should be called with every telemetry snapshot. It is a no-op
// unless a disk is under the configured free-space threshold and the
// cooldown has elapsed since the last cleanup run.
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
