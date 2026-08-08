package selfheal

import (
	"context"
	"time"

	"github.com/rs/zerolog"
)

type ServiceWatchdogConfig struct {
	// Services is the fixed, locally-configured list of service names to
	// watch (e.g. "Spooler", "postgresql-x64-16", "OpenVPNService"). This is
	// never expanded at runtime by a remote command.
	Services []string
	// CheckInterval is how often to poll each service's status.
	CheckInterval time.Duration
	// MaxRestartsPerHour caps how many times the watchdog will restart the
	// same service within a rolling hour — beyond that it's a crash loop,
	// not a transient failure, and keeps failing quietly is a stealth
	// pattern this agent explicitly avoids: it stops touching the service
	// and audit-logs the suppression loudly instead.
	MaxRestartsPerHour int
}

// Event is emitted for every self-healing action worth surfacing to the
// server — shared shape across the service watchdog, disk cleaner, and
// (via LeakEvent) memory monitor. Target is the thing acted on (a service
// name or a directory path, depending on Action's prefix).
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

// Run blocks until ctx is cancelled, checking all configured services on
// CheckInterval (plus once immediately on start).
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

// allowRestart enforces the rolling-hour restart cap per service name.
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
