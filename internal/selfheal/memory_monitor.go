package selfheal

import (
	"github.com/rs/zerolog"

	"optifleet-agent/internal/telemetry"
)

// LeakEvent is what gets reported upstream when a suspected leak is found.
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

// Observe should be called with every telemetry snapshot — wire it into the
// same poller callback that forwards snapshots to the server. On a
// suspected leak it attempts a working-set trim (Windows only; a no-op
// error on other platforms) and always reports the event upstream.
//
// It deliberately does not kill or restart the offending process itself: a
// heuristic monotonic-growth signal isn't reliable enough to justify
// silently destroying a user's unsaved work. This surfaces the alert and
// leaves the decision to whoever owns policy on the server side — which can
// then push an explicit, signed kill_process command if it decides to.
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
