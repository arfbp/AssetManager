// Package configpush applies a signed ConfigUpdatePayload (see
// internal/transport/protocol.go's doc comment on why this is a separate,
// tightly-scoped trust path, same reasoning as internal/selfupdate):
// verifies it, writes the new agent.yaml alongside the running one, then
// hands off to a platform-specific swap-and-restart step (applyPlatform,
// implemented in configpush_windows.go — a no-op stub elsewhere, see
// configpush_other.go).
package configpush

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
	"gopkg.in/yaml.v3"

	"optifleet-agent/internal/transport"
)

type Config struct {
	HMACSecret  string
	CurrentHash string // sha256 of the agent's own currently-loaded agent.yaml, see cmd/agent/main.go
	ConfigPath  string // absolute path to the live agent.yaml (the -config flag value)
	ServiceName string
}

// Apply verifies payload's signature and freshness, validates the new YAML
// is at least syntactically well-formed, then hands off to applyPlatform to
// swap it in, adjust the service environment if requested, and restart.
// Returns nil without doing anything if payload.ConfigSHA256 already matches
// what's currently loaded (a duplicate push landing twice is a no-op, not an
// error) — same convergence reasoning as internal/selfupdate.Apply.
func Apply(cfg Config, payload transport.ConfigUpdatePayload, log zerolog.Logger) error {
	if !payload.VerifySignature(cfg.HMACSecret) {
		return fmt.Errorf("configpush: signature verification failed")
	}
	// Same freshness window internal/executor and internal/selfupdate use for
	// their own signed payloads.
	if age := time.Since(time.Unix(payload.IssuedAtUnix, 0)); age > 2*time.Minute || age < -30*time.Second {
		return fmt.Errorf("configpush: stale or future-dated update instruction (age %s)", age)
	}
	if payload.ConfigSHA256 == cfg.CurrentHash {
		log.Info().Msg("configpush: already running this config, ignoring")
		return nil
	}
	if got := sha256sum(payload.ConfigYAML); !strings.EqualFold(got, payload.ConfigSHA256) {
		return fmt.Errorf("configpush: config_sha256 does not match config_yaml content (got %s, want %s) — refusing", got, payload.ConfigSHA256)
	}

	// Syntax-only check — deliberately not the full internal/config.Load
	// validation (which requires OPTIFLEET_ENABLE_RUN_SCRIPT to already be
	// set in THIS process's environment if the new YAML enables run_script,
	// which by definition isn't true yet before applyPlatform sets it on the
	// service). This only exists to catch outright corrupt/malformed YAML
	// before we ever stop the service over it.
	var probe map[string]any
	if err := yaml.Unmarshal([]byte(payload.ConfigYAML), &probe); err != nil {
		return fmt.Errorf("configpush: new config_yaml is not valid YAML, refusing: %w", err)
	}

	newPath := cfg.ConfigPath + ".new"
	if err := os.WriteFile(newPath, []byte(payload.ConfigYAML), 0o600); err != nil {
		return fmt.Errorf("configpush: write %s: %w", newPath, err)
	}

	log.Info().Bool("enable_run_script", payload.EnableRunScript).Msg("configpush: new config staged, handing off to updater script")
	return applyPlatform(cfg.ConfigPath, newPath, cfg.ServiceName, payload.EnableRunScript)
}

func sha256sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
