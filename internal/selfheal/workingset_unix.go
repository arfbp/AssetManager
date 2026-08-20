//go:build !windows

package selfheal

import "fmt"

// TrimWorkingSet ไม่มีสิ่งที่เทียบเท่ากันตรง ๆ บน macOS/Linux ถ้าไม่ attach
// เข้าไปที่ process เป้าหมาย (ระดับสิทธิ์แบบ ptrace) ซึ่ง agent นี้ไม่ทำ
// memory monitor ยังคงรัน alert path บนแพลตฟอร์มพวกนี้ตามปกติ — แค่รายงาน
// ว่าขั้นตอน trim ถูกข้ามไปเท่านั้น
func TrimWorkingSet(pid int32) error {
	return fmt.Errorf("selfheal: working-set trim is only implemented on windows")
}
