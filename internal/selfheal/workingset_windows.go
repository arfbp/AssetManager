//go:build windows

package selfheal

import (
	"fmt"

	"golang.org/x/sys/windows"
)

var (
	modpsapi            = windows.NewLazySystemDLL("psapi.dll")
	procEmptyWorkingSet = modpsapi.NewProc("EmptyWorkingSet")
)

// TrimWorkingSet ขอให้ Windows trim working set ของ process เป้าหมาย
// (หน้า RAM จริงที่รองรับมันอยู่) บังคับให้หน้าที่ไม่ค่อยถูกแตะออกไปอยู่ใน
// page file แทน ไม่ได้คืนหน่วยความจำที่ leak ที่ process เองยังถืออยู่ —
// แค่ลด footprint ทาง *physical* ที่แสดงใน Task Manager จนกว่า process จะ
// กลับมาแตะหน้าเหล่านั้นอีก ตรงกับคำขอ "clean working set" พอดี: เป็นการ
// ตอบสนองแรกที่ปลอดภัยและย้อนกลับได้ ต่างจากการ kill process ไปเลย
func TrimWorkingSet(pid int32) error {
	const desiredAccess = windows.PROCESS_QUERY_INFORMATION | windows.PROCESS_SET_QUOTA
	handle, err := windows.OpenProcess(desiredAccess, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("selfheal: open process %d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)

	r1, _, callErr := procEmptyWorkingSet.Call(uintptr(handle))
	if r1 == 0 {
		return fmt.Errorf("selfheal: EmptyWorkingSet for pid %d: %w", pid, callErr)
	}
	return nil
}
