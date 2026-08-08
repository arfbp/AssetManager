//go:build windows

package selfheal

import (
	"context"
	"fmt"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// windowsServiceController talks to the Windows Service Control Manager
// directly via golang.org/x/sys/windows/svc/mgr, rather than shelling out to
// sc.exe and parsing text output — the SCM API is the robust option and the
// agent already runs with the privilege it needs (LocalSystem) to use it.
type windowsServiceController struct{}

func NewServiceController() ServiceController {
	return windowsServiceController{}
}

func (windowsServiceController) Status(_ context.Context, name string) (ServiceState, error) {
	m, err := mgr.Connect()
	if err != nil {
		return StateUnknown, fmt.Errorf("selfheal: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return StateUnknown, fmt.Errorf("selfheal: open service %q: %w", name, err)
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return StateUnknown, fmt.Errorf("selfheal: query service %q: %w", name, err)
	}

	switch status.State {
	case svc.Running:
		return StateRunning, nil
	case svc.Stopped:
		return StateStopped, nil
	default:
		// StartPending, StopPending, Paused, etc. — treat as "not our
		// business right now", the next poll will re-check.
		return StateUnknown, nil
	}
}

func (windowsServiceController) Start(_ context.Context, name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("selfheal: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("selfheal: open service %q: %w", name, err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("selfheal: start service %q: %w", name, err)
	}
	return nil
}
