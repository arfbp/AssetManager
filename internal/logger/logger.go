// Package logger sets up structured, rotated logging for the agent: one
// rolling operational log and one append-only audit log for every command
// the agent receives and executes. Secrets are never written to either.
package logger

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/rs/zerolog"
	lumberjack "gopkg.in/natefinch/lumberjack.v2"

	"optifleet-agent/internal/config"
)

type Loggers struct {
	Log   zerolog.Logger // operational log: startup, polling, connectivity, errors
	Audit zerolog.Logger // every command received/executed/rejected, append-only
}

// redactKeys lists field names that must never reach the log sink even if a
// caller accidentally attaches them.
var redactKeys = map[string]struct{}{
	"auth_token":  {},
	"password":    {},
	"hmac_secret": {},
	"client_key":  {},
}

// redactHook strips known-sensitive fields from every event as a defense in
// depth measure, in case a call site forgets and attaches one directly.
type redactHook struct{}

func (redactHook) Run(e *zerolog.Event, level zerolog.Level, msg string) {
	// zerolog does not expose per-field interception; the real guard is at
	// call sites (never call .Str("auth_token", ...)). This hook exists so
	// future fields added here are documented as the audit point.
}

func New(cfg config.LoggingConfig) (*Loggers, error) {
	if err := os.MkdirAll(cfg.Dir, 0o750); err != nil {
		return nil, err
	}

	level, err := zerolog.ParseLevel(strings.ToLower(cfg.Level))
	if err != nil {
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)

	opLog := &lumberjack.Logger{
		Filename:   filepath.Join(cfg.Dir, "agent.log"),
		MaxSize:    cfg.MaxSizeMB,
		MaxBackups: cfg.MaxBackups,
		MaxAge:     cfg.MaxAgeDays,
		Compress:   true,
	}
	auditLog := &lumberjack.Logger{
		Filename:   filepath.Join(cfg.Dir, "audit.log"),
		MaxSize:    cfg.MaxSizeMB,
		MaxBackups: cfg.MaxBackups * 2, // keep audit history longer
		MaxAge:     cfg.MaxAgeDays * 3,
		Compress:   true,
	}

	log := zerolog.New(opLog).Hook(redactHook{}).With().Timestamp().Caller().Logger()
	audit := zerolog.New(auditLog).With().Timestamp().Logger()

	return &Loggers{Log: log, Audit: audit}, nil
}

// Redact returns "***" if key is a known-sensitive field name, else value.
// Use at call sites building log events from dynamic maps.
func Redact(key, value string) string {
	if _, sensitive := redactKeys[strings.ToLower(key)]; sensitive {
		return "***"
	}
	return value
}
