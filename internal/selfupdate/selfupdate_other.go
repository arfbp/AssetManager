//go:build !windows

package selfupdate

import "fmt"

// applyPlatform: self-update ยังไม่ได้ implement บนแพลตฟอร์มนี้ — ขั้นตอน
// สลับไบนารีที่กำลังรันอยู่นั้นขึ้นกับ OS โดยธรรมชาติ (ดู
// selfupdate_windows.go) และ macOS/Linux ของโปรเจกต์นี้ยังไม่จำเป็นต้องมี
// เร่งด่วนเท่ากับฟลีต Windows เป็นหลักที่สร้างมาเพื่อรองรับ คืน error
// แทนที่จะแค่ no-op เงียบ ๆ เพื่อให้ caller ของ Apply log ความล้มเหลวจริง
// แทนที่ agent จะดูเหมือน "รับ" update ไปแล้วทั้งที่ไม่ได้ติดตั้งจริง
func applyPlatform(exePath, newPath, serviceName string) error {
	return fmt.Errorf("selfupdate: not implemented on this platform yet")
}
