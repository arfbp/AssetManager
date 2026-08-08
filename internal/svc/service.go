// Package svc wraps kardianos/service so the agent installs and runs as a
// standard, named OS service — Windows Service, launchd on macOS, systemd on
// Linux — visible in Task Manager / services.msc / launchctl / systemctl
// like any other managed software. It intentionally does nothing to hide
// itself from the OS's own service tooling.
package svc

import (
	"context"

	"github.com/kardianos/service"
	"github.com/rs/zerolog"
)

// RunFunc contains the agent's actual work loop. It must return promptly
// once ctx is cancelled.
type RunFunc func(ctx context.Context)

type program struct {
	runFunc RunFunc
	log     zerolog.Logger
	cancel  context.CancelFunc
}

// Start is called by the service manager. It must return quickly, so the
// real work runs in a background goroutine.
func (p *program) Start(s service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	go func() {
		defer func() {
			if r := recover(); r != nil {
				p.log.Error().Interface("panic", r).Msg("svc: run loop panicked, recovered")
			}
		}()
		p.runFunc(ctx)
	}()
	p.log.Info().Msg("svc: started")
	return nil
}

// Stop is called by the service manager on shutdown/stop request. It signals
// the run loop via context cancellation and returns immediately — kardianos
// gives services a limited window to exit before the OS force-kills them.
func (p *program) Stop(s service.Service) error {
	p.log.Info().Msg("svc: stop requested")
	if p.cancel != nil {
		p.cancel()
	}
	return nil
}

// New builds the OS service wrapper. cfg.Name is what shows up in Task
// Manager / services.msc / launchctl — keep it human-identifiable.
func New(cfg service.Config, log zerolog.Logger, runFunc RunFunc) (service.Service, error) {
	prg := &program{runFunc: runFunc, log: log}
	return service.New(prg, &cfg)
}
