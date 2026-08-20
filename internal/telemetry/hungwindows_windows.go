//go:build windows

// ตรวจว่า process ที่รันอยู่ตัวไหนเป็นเจ้าของ top-level window ที่ hung —
// สถานะเดียวกับ "(Not Responding)" ที่ Task Manager ของ Windows เองแสดง
// และสัญญาณเบื้องหลังเดียวกัน (window ที่หยุด pump message queue ตรวจด้วย
// IsHungAppWindow ของ user32) ที่มันใช้ตัดสิน เรื่องนี้ต่างจาก CPU สูง:
// process อาจใช้ CPU 100% เต็มแต่ยัง responsive สมบูรณ์ (งาน background
// compute จริง ๆ) และ process อาจ hung สนิทที่ CPU 0% ก็ได้ (deadlock รอ
// lock อยู่) มีแต่การตรวจ window-message-pump จริง ๆ เท่านั้นที่จับกรณี
// "UI ค้าง" จริง ๆ ที่ operator สนใจได้
package telemetry

import (
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32                 = syscall.NewLazyDLL("user32.dll")
	procEnumWindows        = user32.NewProc("EnumWindows")
	procGetWindowThreadPID = user32.NewProc("GetWindowThreadProcessId")
	procIsHungAppWindow    = user32.NewProc("IsHungAppWindow")
	procIsWindowVisible    = user32.NewProc("IsWindowVisible")

	// สร้างครั้งเดียว ไม่ใช่ทุกครั้งที่เรียก: syscall.NewCallback มี budget
	// ของ callback trampoline ที่ตายตัวและน้อยตลอดอายุ process (เอกสารของ
	// Go เองบอกว่าประมาณ 2000) — ฟังก์ชันนี้รันทุกครั้งที่ telemetry poll
	// (ทุก 5 นาที หรือทุก 10 วินาทีในโหมด alert) ถ้าสร้างใหม่ทุกครั้งจะทำให้
	// budget นั้นหมดในที่สุดสำหรับ agent ที่รันนาน ๆ แล้ว panic
	hungWindowCallback = syscall.NewCallback(enumWindowsCallback)
	hungWindowResults  map[int32]bool

	// guard ทั้ง hungWindowResults และรับประกันว่ามี EnumWindows call
	// ทำงานอยู่ได้ทีละตัวเท่านั้น — จำเป็นเพราะ call ที่ timeout ไป (ดู
	// hungWindowPIDs) จะปล่อยให้ goroutine ของมันรันต่อในเบื้องหลัง แทนที่จะ
	// cancel OS call ที่อยู่ข้างล่างได้จริง (ไม่มีทาง cancel มันได้เลย) ถ้า
	// poll รอบถัดไปเริ่ม call ที่สองซ้อนกันขณะที่ตัวแรกยังค้างอยู่ ทั้งสอง
	// ตัวจะเขียน hungWindowResults พร้อมกันแล้วทำให้ process crash ด้วย
	// "fatal error: concurrent map writes"
	hungWindowMu sync.Mutex
)

func enumWindowsCallback(hwnd syscall.Handle, _ uintptr) uintptr {
	visible, _, _ := procIsWindowVisible.Call(uintptr(hwnd))
	if visible == 0 {
		return 1 // ทำ enumeration ต่อ
	}
	isHung, _, _ := procIsHungAppWindow.Call(uintptr(hwnd))
	if isHung == 0 {
		return 1
	}
	var pid uint32
	procGetWindowThreadPID.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&pid)))
	if pid != 0 {
		hungWindowResults[int32(pid)] = true
	}
	return 1 // ทำ enumeration ต่อ
}

// hungWindowPIDs แจกแจง top-level window ทุกตัวบน desktop แล้วคืน set ของ
// process ID ที่เป็นเจ้าของ window ที่ hung และ visible อย่างน้อยหนึ่งตัว
// best-effort สองแบบ: ความล้มเหลวใด ๆ ให้ set ว่างเปล่า (ไม่มีอะไรถูก
// รายงานว่า hung) แทนที่จะบล็อกการเก็บ telemetry ส่วนที่เหลือ และทั้ง call
// นี้ถูกจำกัดด้วย timeout ตายตัว — ยืนยันแล้วแบบสด ๆ ว่า EnumWindows
// พฤติกรรมต่างกันมาก (และไม่ return ทันที) เมื่อ agent นี้รันเป็น Windows
// Service ภายใต้ SYSTEM ใน Session 0 ที่ไม่มี interactive desktop เทียบกับ
// process แบบ interactive/console ปกติที่ return ภายในหลักหน่วยมิลลิวินาที
// telemetry collector ที่ค้างเป็นผลลัพธ์ที่แย่กว่าการข้าม hang check ของ
// poll รอบหนึ่งเป็นครั้งคราวมาก
func hungWindowPIDs() map[int32]bool {
	if !hungWindowMu.TryLock() {
		// call ก่อนหน้ายังค้างอยู่ใน EnumWindows — ข้าม hang check ของรอบนี้
		// ไปเลย แทนที่จะเริ่ม call ที่สองซ้อนกัน
		return nil
	}

	done := make(chan map[int32]bool, 1)
	go func() {
		defer hungWindowMu.Unlock()
		hungWindowResults = make(map[int32]bool)
		_, _, _ = procEnumWindows.Call(hungWindowCallback, 0)
		done <- hungWindowResults
	}()

	select {
	case result := <-done:
		return result
	case <-time.After(2 * time.Second):
		// goroutine ด้านบนยังรันต่อไป (และถือ mutex ไว้) จนกว่า/ถ้า
		// EnumWindows จะ return จริง ๆ — ตรงนี้แค่หยุดรอมันสำหรับ poll
		// cycle นี้ แทนที่จะบล็อกการเก็บ telemetry
		return nil
	}
}
