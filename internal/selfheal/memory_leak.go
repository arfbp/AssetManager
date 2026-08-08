package selfheal

import (
	"sync"
	"time"

	"optifleet-agent/internal/telemetry"
)

type LeakConfig struct {
	// GrowthThresholdMB is how much a process's RSS must have grown across
	// the tracking window before it's flagged.
	GrowthThresholdMB float64
	// MinSamples is how many consecutive telemetry snapshots a process must
	// appear in — each non-decreasing versus the last — before flagging.
	// This is what separates "leak" from "one noisy spike".
	MinSamples int
	// WindowSize bounds how many samples per PID are retained; defaults to
	// MinSamples+2 if unset.
	WindowSize int
}

type memSample struct {
	at    time.Time
	memMB float64
}

// LeakAlert describes one suspected leak, first detection only — a given PID
// is reported once per continuous appearance in the tracked process set.
type LeakAlert struct {
	PID       int32
	Name      string
	StartMB   float64
	CurrentMB float64
	Samples   int
}

// Detector tracks per-process RSS across telemetry snapshots to spot
// processes whose memory grows monotonically rather than fluctuating —
// characteristic of a leak rather than normal workload variance. It holds
// no more than WindowSize samples per currently-tracked PID, so memory use
// stays flat regardless of uptime.
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

// Observe feeds one snapshot's top-process list in and returns any
// newly-detected leak candidates.
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

	// Processes that dropped out of the top-N list are no longer tracked —
	// either they exited or they're no longer a memory concern.
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
			return LeakAlert{}, false // dipped — not a monotonic leak pattern
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
