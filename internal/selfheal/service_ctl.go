// Package selfheal implements the agent's autonomous self-healing loops:
// restarting critical OS services that have stopped, cleaning allowlisted
// temp directories under disk pressure, and spotting/reacting to per-process
// memory growth. Everything this package acts on is bounded by local
// config, set ahead of time by whoever deploys the agent — none of it is
// dynamically expandable by a runtime server command, which keeps it a
// distinct, narrower trust boundary than internal/executor's remote
// command path.
package selfheal

import "context"

type ServiceState string

const (
	StateRunning ServiceState = "running"
	StateStopped ServiceState = "stopped"
	StateUnknown ServiceState = "unknown"
)

// ServiceController abstracts the OS service manager: Windows SCM,
// systemd, or launchd. Implementations live in service_ctl_windows.go and
// service_ctl_unix.go (build-tag separated).
type ServiceController interface {
	Status(ctx context.Context, name string) (ServiceState, error)
	Start(ctx context.Context, name string) error
}
