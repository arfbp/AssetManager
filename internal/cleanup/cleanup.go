// Package cleanup คือการลบเนื้อหาในไดเรกทอรีแบบจำกัดด้วย allowlist ที่
// กำหนดไว้ชัดเจน ใช้ร่วมกันระหว่างคำสั่ง "clean_temp" จากระยะไกล
// (internal/executor) และตัว self-healing monitor ที่คอยดูพื้นที่ดิสก์แบบ
// อัตโนมัติ (internal/selfheal) เพื่อให้ทั้งสอง path บังคับใช้ safety check
// ชุดเดียวกัน
package cleanup

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// percentVarPattern จับ environment variable แบบ %VAR% สไตล์ Windows
// os.ExpandEnv รู้จักแค่ $VAR / ${VAR} (syntax แบบ Go/shell) — entry
// default ของ clean_temp_allowed_dirs ใน configs/agent.yaml ("%TEMP%")
// เป็น syntax ของ cmd.exe ซึ่งผ่าน ExpandEnv ไปเฉย ๆ โดยไม่ถูก expand ทำ
// ให้ทั้ง allowlist entry และ target จบลงที่การเทียบกันเป็น string
// "%TEMP%" ตรง ๆ (allowlist check เลย "match" โดยบังเอิญ) แล้ว
// os.ReadDir("%TEMP%") ก็ fail เพราะไม่มีไดเรกทอรีชื่อนี้จริง expandEnv
// ด้านล่างนี้เลย expand ทั้งสอง syntax
var percentVarPattern = regexp.MustCompile(`%([A-Za-z_][A-Za-z0-9_]*)%`)

func expandEnv(s string) string {
	s = percentVarPattern.ReplaceAllStringFunc(s, func(m string) string {
		name := m[1 : len(m)-1]
		if v, ok := os.LookupEnv(name); ok {
			return v
		}
		return m
	})
	return os.ExpandEnv(s)
}

// Result สรุปผลการ cleanup หนึ่งรอบ ไว้ใช้สำหรับ logging/audit
type Result struct {
	Dir     string
	Removed int
	Failed  int
}

func (r Result) String() string {
	return fmt.Sprintf("cleaned %s: removed %d entries, %d failures", r.Dir, r.Removed, r.Failed)
}

// Directory ลบ *เนื้อหา* ของ target (ไม่ลบตัวไดเรกทอรีเอง) แต่จะทำก็ต่อเมื่อ
// target resolve แล้ว — หลัง expand env-var และ clean path — ตรงกับ entry
// ใน allowedDirs พอดีหนึ่งรายการเท่านั้น ป้องกัน path traversal จาก string
// ที่ caller ส่งมา (เช่น "../../Users/victim/Documents") และป้องกันการ
// ทำงานกับไดเรกทอรีใด ๆ ที่ operator ไม่ได้ pre-approve ไว้ใน config
// ล่วงหน้า
func Directory(allowedDirs []string, target string) (Result, error) {
	if target == "" {
		return Result{}, fmt.Errorf("cleanup: no target directory specified")
	}
	if len(allowedDirs) == 0 {
		return Result{}, fmt.Errorf("cleanup: no allowlisted directories configured")
	}

	resolved := filepath.Clean(expandEnv(target))
	allowed := false
	for _, dir := range allowedDirs {
		if resolved == filepath.Clean(expandEnv(dir)) {
			allowed = true
			break
		}
	}
	if !allowed {
		return Result{}, fmt.Errorf("cleanup: %q is not in the allowlisted directory set", target)
	}

	entries, err := os.ReadDir(resolved)
	if err != nil {
		return Result{}, fmt.Errorf("cleanup: read %s: %w", resolved, err)
	}

	res := Result{Dir: resolved}
	for _, entry := range entries {
		full := filepath.Join(resolved, entry.Name())
		if err := os.RemoveAll(full); err != nil {
			res.Failed++
			continue
		}
		res.Removed++
	}
	return res, nil
}

// FirstAllowed คืนไดเรกทอรีแรกที่อยู่ใน allowlist ใช้เป็น target default
// เมื่อ caller ไม่ได้ระบุมา
func FirstAllowed(allowedDirs []string) (string, error) {
	if len(allowedDirs) == 0 {
		return "", fmt.Errorf("cleanup: no allowlisted directories configured")
	}
	return allowedDirs[0], nil
}
