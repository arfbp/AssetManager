//go:build !windows

package selfheal

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// unixServiceController shells out to systemctl (Linux) or launchctl
// (macOS) — there is no equivalent of Windows' SCM API for either, so the
// standard CLI tooling is the practical option here, same as most Linux/macOS
// management agents.
type unixServiceController struct{}

func NewServiceController() ServiceController {
	return unixServiceController{}
}

func (unixServiceController) Status(ctx context.Context, name string) (ServiceState, error) {
	switch runtime.GOOS {
	case "linux":
		out, err := exec.CommandContext(ctx, "systemctl", "is-active", name).Output()
		state := strings.TrimSpace(string(out))
		// systemctl is-active exits non-zero for "inactive"/"failed" but
		// still prints a valid state to stdout — only empty output plus an
		// error means the command itself failed to run.
		if state == "" && err != nil {
			return StateUnknown, fmt.Errorf("selfheal: systemctl is-active %q: %w", name, err)
		}
		switch state {
		case "active":
			return StateRunning, nil
		case "inactive", "failed":
			return StateStopped, nil
		default:
			return StateUnknown, nil
		}
	case "darwin":
		if err := exec.CommandContext(ctx, "launchctl", "list", name).Run(); err != nil {
			// launchctl list exits non-zero when the label isn't loaded.
			return StateStopped, nil
		}
		return StateRunning, nil
	default:
		return StateUnknown, fmt.Errorf("selfheal: unsupported GOOS=%s", runtime.GOOS)
	}
}

func (unixServiceController) Start(ctx context.Context, name string) error {
	switch runtime.GOOS {
	case "linux":
		if err := exec.CommandContext(ctx, "systemctl", "start", name).Run(); err != nil {
			return fmt.Errorf("selfheal: systemctl start %q: %w", name, err)
		}
		return nil
	case "darwin":
		if err := exec.CommandContext(ctx, "launchctl", "kickstart", "-k", "system/"+name).Run(); err != nil {
			return fmt.Errorf("selfheal: launchctl kickstart %q: %w", name, err)
		}
		return nil
	default:
		return fmt.Errorf("selfheal: unsupported GOOS=%s", runtime.GOOS)
	}
}
