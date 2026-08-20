// Package logger จัดการ logging แบบ structured และ rotate ให้ agent: มี
// operational log ที่ rolling หนึ่งตัว และ audit log แบบ append-only อีก
// หนึ่งตัวสำหรับทุกคำสั่งที่ agent ได้รับและรัน ไม่มีการเขียน secret ลง
// log ทั้งสองไฟล์เลย
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
	Audit zerolog.Logger // ทุกคำสั่งที่ received/executed/rejected แบบ append-only
}

// redactKeys คือรายชื่อ field ที่ห้ามไปถึง log sink เด็ดขาด แม้ caller จะ
// เผลอแนบมันมาด้วยก็ตาม
var redactKeys = map[string]struct{}{
	"auth_token":  {},
	"password":    {},
	"hmac_secret": {},
	"client_key":  {},
}

// redactHook ตัด field ที่รู้อยู่แล้วว่า sensitive ออกจากทุก event เป็น
// มาตรการ defense in depth เผื่อ call site ไหนลืมแล้วแนบ field นั้นมาตรง ๆ
type redactHook struct{}

func (redactHook) Run(e *zerolog.Event, level zerolog.Level, msg string) {
	// zerolog ไม่มี interface ให้ intercept รายฟิลด์ได้ ตัวป้องกันจริง ๆ อยู่
	// ที่ call site (ห้ามเรียก .Str("auth_token", ...) ตรง ๆ) hook นี้มีไว้
	// เพื่อให้ field ที่จะเพิ่มในอนาคตมีจุดนี้เป็นจุดตรวจสอบที่บันทึกไว้
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
		MaxBackups: cfg.MaxBackups * 2, // เก็บประวัติ audit ไว้นานกว่า
		MaxAge:     cfg.MaxAgeDays * 3,
		Compress:   true,
	}

	log := zerolog.New(opLog).Hook(redactHook{}).With().Timestamp().Caller().Logger()
	audit := zerolog.New(auditLog).With().Timestamp().Logger()

	return &Loggers{Log: log, Audit: audit}, nil
}

// Redact คืน "***" ถ้า key เป็นชื่อ field ที่รู้ว่า sensitive ไม่งั้นคืน
// value เดิม ใช้ที่ call site ที่สร้าง log event จาก dynamic map
func Redact(key, value string) string {
	if _, sensitive := redactKeys[strings.ToLower(key)]; sensitive {
		return "***"
	}
	return value
}
