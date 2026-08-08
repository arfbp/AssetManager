package telemetry

import (
	"context"
	"time"

	"github.com/rs/zerolog"
)

// PollerConfig controls the normal/alert cadence and the thresholds that
// switch between them.
type PollerConfig struct {
	NormalInterval    time.Duration
	AlertInterval     time.Duration
	CPUThreshold      float64
	MemThreshold      float64
	RecoveryStreak    int // consecutive normal readings needed to exit alert mode
	TopNProcesses     int
}

// Poller drives telemetry collection on a dynamic interval: it wakes on
// NormalInterval by default, and — the moment a reading crosses the CPU/mem
// threshold — drops to AlertInterval until RecoveryStreak consecutive
// readings come back under threshold (hysteresis avoids mode-flapping when a
// metric hovers right at the line).
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

// TriggerNow requests an out-of-cycle collection+send as soon as Run's loop
// next wakes, instead of waiting up to NormalInterval (up to several
// minutes) — wired to fire right after a command that visibly changes what
// the next snapshot would show (kill_process, clean_temp), so the dashboard
// reflects it immediately rather than looking stale. Non-blocking and safe
// to call from another goroutine (executor.Handle runs on the transport's
// read loop): if a trigger is already pending, this is just a no-op rather
// than blocking the caller.
func (p *Poller) TriggerNow() {
	select {
	case p.trigger <- struct{}{}:
	default:
	}
}

// Run blocks until ctx is cancelled. It uses a single timer whose duration is
// reset after every reading, rather than two competing tickers, so the mode
// switch takes effect on the very next wake-up.
func (p *Poller) Run(ctx context.Context) {
	mode := ModeNormal
	normalStreak := 0

	timer := time.NewTimer(0) // fire immediately on start
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
			// The regular timer hasn't fired yet — stop it and drain any
			// racing tick before collecting out-of-cycle, then restart the
			// normal cadence fresh from now (see time.Timer.Reset's own
			// docs on why a bare Reset without Stop+drain is unsafe here,
			// unlike the timer.C branch below where the channel read has
			// already drained it).
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
