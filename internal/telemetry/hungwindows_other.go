//go:build !windows

package telemetry

// ยังไม่มีสัญญาณ "hung window" ของ OS ที่เทียบเท่ากันต่อสายไว้สำหรับ
// แพลตฟอร์มที่ไม่ใช่ Windows — ทุก process แค่รายงาน Responding=true เหมือน
// ก่อนที่ field นี้จะมี
func hungWindowPIDs() map[int32]bool {
	return nil
}
