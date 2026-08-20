// Package config โหลดและตรวจสอบไฟล์ config YAML ของ agent โดยมี
// environment variables ซ้อนทับด้านบนสำหรับค่า secret
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
	AuthTokenEnvVar string `yaml:"-"` // ชื่อตายตัว ผู้ใช้ config เองไม่ได้

	// resolve ตอนโหลด ไม่ serialize กลับออกไปหรือ log ที่ไหนเลย
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

	// ขอบเขตของ action "run_script" ถ้าเปิดใช้งาน ค่าพวกนี้บังคับใช้เสมอแม้
	// จะเปิดใช้งานแล้วก็ตาม — ดู internal/executor.Config ว่าทำไมคำสั่งแต่ละ
	// อันถึงมาผ่อนปรนเองไม่ได้
	ScriptTimeout        time.Duration `yaml:"script_timeout"`
	MaxScriptBytes       int           `yaml:"max_script_bytes"`
	MaxScriptOutputBytes int           `yaml:"max_script_output_bytes"`
}

// SelfHealConfig ควบคุม self-healing engine แบบอัตโนมัติ
// (internal/selfheal) ต่างจาก Commands ตรงที่ส่วนนี้ไม่มีอะไรขยายได้จาก
// ระยะไกลตอน runtime เลย — รายชื่อ service, ไดเรกทอรีสำหรับ cleanup, และ
// threshold ของ leak ถูกกำหนดตายตัวโดยคนที่ deploy config file นี้
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

// Load อ่านไฟล์ YAML ที่ path แล้วซ้อนทับ secrets จาก environment variables
// เข้าไป คืน error แทนที่จะให้ config ที่ valid บางส่วนผ่านไป เพื่อไม่ให้
// caller รันด้วย security setting ที่ขาดหายไปแบบเงียบ ๆ
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
	// top_n_processes <= 0 (รวมถึงกรณีไม่ได้ set ซึ่งเป็น zero value ของ Go)
	// แปลว่า "ส่งทุก process ที่รันอยู่ ไม่มี cap" — ปล่อยไว้แบบนี้แทนที่จะตั้ง
	// default เป็นตัวเลขตายตัว ดู internal/telemetry/collector.go
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

// AllowedSet คืน command allowlist ในรูปแบบ lookup set
func (c *Config) AllowedSet() map[string]struct{} {
	set := make(map[string]struct{}, len(c.Commands.Allowed))
	for _, name := range c.Commands.Allowed {
		set[name] = struct{}{}
	}
	return set
}
