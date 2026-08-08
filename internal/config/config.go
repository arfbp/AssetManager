// Package config loads and validates the agent's YAML configuration file,
// with environment variables layered on top for secrets.
package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Service  ServiceConfig  `yaml:"service"`
	Server   ServerConfig   `yaml:"server"`
	Polling  PollingConfig  `yaml:"polling"`
	Logging  LoggingConfig  `yaml:"logging"`
	Commands CommandsConfig `yaml:"commands"`
	SelfHeal SelfHealConfig `yaml:"self_heal"`
}

type ServiceConfig struct {
	Name        string `yaml:"name"`
	DisplayName string `yaml:"display_name"`
	Description string `yaml:"description"`
}

type ServerConfig struct {
	URL             string `yaml:"url"`
	ClientCertPath  string `yaml:"client_cert_path"`
	ClientKeyPath   string `yaml:"client_key_path"`
	CACertPath      string `yaml:"ca_cert_path"`
	HMACSecretEnv   string `yaml:"hmac_secret_env"`
	AuthTokenEnvVar string `yaml:"-"` // fixed name, not user-configurable

	// Resolved at load time, never serialized back out or logged.
	AuthToken  string `yaml:"-"`
	HMACSecret string `yaml:"-"`
}

type PollingConfig struct {
	NormalInterval    time.Duration `yaml:"normal_interval"`
	AlertInterval     time.Duration `yaml:"alert_interval"`
	CPUAlertThreshold float64       `yaml:"cpu_alert_threshold"`
	MemAlertThreshold float64       `yaml:"mem_alert_threshold"`
	RecoveryStreak    int           `yaml:"recovery_streak"`
	TopNProcesses     int           `yaml:"top_n_processes"`
}

type LoggingConfig struct {
	Dir        string `yaml:"dir"`
	Level      string `yaml:"level"`
	MaxSizeMB  int    `yaml:"max_size_mb"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAgeDays int    `yaml:"max_age_days"`
}

type CommandsConfig struct {
	Allowed              []string      `yaml:"allowed"`
	RestartConfirmDelay  time.Duration `yaml:"restart_confirm_delay"`
	CleanTempAllowedDirs []string      `yaml:"clean_temp_allowed_dirs"`

	// Bounds for the "run_script" action, if enabled. These apply even when
	// enabled — see internal/executor.Config for why they can't be relaxed
	// by an individual command.
	ScriptTimeout        time.Duration `yaml:"script_timeout"`
	MaxScriptBytes       int           `yaml:"max_script_bytes"`
	MaxScriptOutputBytes int           `yaml:"max_script_output_bytes"`
}

// SelfHealConfig drives the autonomous self-healing engine
// (internal/selfheal). Unlike Commands, none of this is remotely
// expandable at runtime — the service list, cleanup directories, and
// leak thresholds are fixed by whoever deploys this config file.
type SelfHealConfig struct {
	Services    SelfHealServicesConfig    `yaml:"services"`
	DiskCleanup SelfHealDiskCleanupConfig `yaml:"disk_cleanup"`
	MemoryLeak  SelfHealMemoryLeakConfig  `yaml:"memory_leak"`
}

type SelfHealServicesConfig struct {
	Watch              []string      `yaml:"watch"`
	CheckInterval      time.Duration `yaml:"check_interval"`
	MaxRestartsPerHour int           `yaml:"max_restarts_per_hour"`
}

type SelfHealDiskCleanupConfig struct {
	FreeThresholdPercent float64       `yaml:"free_threshold_percent"`
	Cooldown             time.Duration `yaml:"cooldown"`
}

type SelfHealMemoryLeakConfig struct {
	GrowthThresholdMB float64 `yaml:"growth_threshold_mb"`
	MinSamples        int     `yaml:"min_samples"`
}

const authTokenEnvVar = "OPTIFLEET_AUTH_TOKEN"
const runScriptEnableEnvVar = "OPTIFLEET_ENABLE_RUN_SCRIPT"

// Load reads the YAML file at path, then layers in secrets from environment
// variables. It returns an error rather than partially-valid config so
// callers never run with silently-missing security settings.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("config: parse %s: %w", path, err)
	}

	cfg.Server.AuthTokenEnvVar = authTokenEnvVar
	cfg.Server.AuthToken = os.Getenv(authTokenEnvVar)
	if cfg.Server.HMACSecretEnv != "" {
		cfg.Server.HMACSecret = os.Getenv(cfg.Server.HMACSecretEnv)
	}

	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("config: invalid: %w", err)
	}

	return &cfg, nil
}

func (c *Config) validate() error {
	if !strings.HasPrefix(c.Server.URL, "wss://") {
		return fmt.Errorf("server.url must use wss:// (got %q) — plaintext ws:// is not permitted", c.Server.URL)
	}
	if c.Server.ClientCertPath == "" && c.Server.AuthToken == "" {
		return fmt.Errorf("no auth configured: set server.client_cert_path (mTLS) or %s env var (bearer token)", authTokenEnvVar)
	}
	if c.Server.HMACSecret == "" {
		return fmt.Errorf("command signing secret missing: set %s env var", c.Server.HMACSecretEnv)
	}
	if c.Polling.NormalInterval <= 0 || c.Polling.AlertInterval <= 0 {
		return fmt.Errorf("polling intervals must be positive")
	}
	if c.Polling.AlertInterval >= c.Polling.NormalInterval {
		return fmt.Errorf("polling.alert_interval must be shorter than normal_interval")
	}
	if c.Polling.RecoveryStreak <= 0 {
		c.Polling.RecoveryStreak = 3
	}
	// top_n_processes <= 0 (including unset/0, Go's zero value) means "send
	// every running process, no cap" — left as-is rather than defaulted to
	// a fixed number. See internal/telemetry/collector.go.
	if len(c.Commands.Allowed) == 0 {
		return fmt.Errorf("commands.allowed must not be empty — refusing to run with an unbounded command surface")
	}
	for _, action := range c.Commands.Allowed {
		if action == "run_script" && os.Getenv(runScriptEnableEnvVar) != "true" {
			return fmt.Errorf(
				"commands.allowed includes %q, the highest-risk action this agent exposes "+
					"(arbitrary server-supplied script, executed as SYSTEM/root). "+
					"As a deliberate second gate beyond editing YAML, it also requires %s=true "+
					"in the environment before the agent will start",
				"run_script", runScriptEnableEnvVar,
			)
		}
	}
	if c.Service.Name == "" {
		return fmt.Errorf("service.name is required")
	}
	return nil
}

// AllowedSet returns the command allowlist as a lookup set.
func (c *Config) AllowedSet() map[string]struct{} {
	set := make(map[string]struct{}, len(c.Commands.Allowed))
	for _, name := range c.Commands.Allowed {
		set[name] = struct{}{}
	}
	return set
}
