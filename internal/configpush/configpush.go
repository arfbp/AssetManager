// Package configpush ใช้ ConfigUpdatePayload ที่เซ็นมาแล้ว (ดู doc comment
// ใน internal/transport/protocol.go ว่าทำไมนี่ถึงเป็น trust path แยกและ
// จำกัดขอบเขตแคบ ๆ เหตุผลเดียวกับ internal/selfupdate): ตรวจสอบ payload
// เขียน agent.yaml ตัวใหม่ไว้ข้าง ๆ ตัวที่กำลังรันอยู่ แล้วส่งต่อให้ขั้นตอน
// swap-and-restart เฉพาะแพลตฟอร์ม (applyPlatform ที่ implement ไว้ใน
// configpush_windows.go — เป็น stub เปล่า ๆ บนแพลตฟอร์มอื่น ดู
// configpush_other.go)
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
	CurrentHash string // sha256 ของ agent.yaml ที่ agent โหลดอยู่ตอนนี้ ดู cmd/agent/main.go
	ConfigPath  string // absolute path ของ agent.yaml ตัวจริง (ค่าจาก flag -config)
	ServiceName string
}

// Apply ตรวจสอบ signature และความสดใหม่ของ payload, ตรวจว่า YAML ตัวใหม่
// อย่างน้อยก็ syntactically ถูกต้อง แล้วส่งต่อให้ applyPlatform สลับไฟล์เข้า
// ไป ปรับ environment ของ service ถ้าถูกร้องขอ แล้ว restart คืนค่า nil
// โดยไม่ทำอะไรเลยถ้า payload.ConfigSHA256 ตรงกับที่โหลดอยู่แล้ว (push ซ้ำที่
// มาถึงสองครั้งถือเป็น no-op ไม่ใช่ error) — เหตุผลเรื่อง convergence
// เดียวกับ internal/selfupdate.Apply
func Apply(cfg Config, payload transport.ConfigUpdatePayload, log zerolog.Logger) error {
	if !payload.VerifySignature(cfg.HMACSecret) {
		return fmt.Errorf("configpush: signature verification failed")
	}
	// ใช้ freshness window เดียวกับที่ internal/executor และ
	// internal/selfupdate ใช้กับ payload ที่เซ็นแล้วของตัวเอง
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

	// ตรวจแค่ syntax เท่านั้น — ตั้งใจไม่ใช้ validation เต็มรูปแบบของ
	// internal/config.Load (ซึ่งต้องการให้ OPTIFLEET_ENABLE_RUN_SCRIPT ถูก
	// set ไว้แล้วใน environment ของ process นี้ ถ้า YAML ตัวใหม่เปิด
	// run_script ไว้ ซึ่งตามนิยามแล้วยังไม่จริงจนกว่า applyPlatform จะไป set
	// ให้กับ service) ตรงนี้มีไว้แค่ดักจับ YAML ที่เสีย/ผิดรูปแบบชัด ๆ ก่อนที่
	// จะไปสั่งหยุด service เพราะมัน
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
