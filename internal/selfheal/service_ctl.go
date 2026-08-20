// Package selfheal คือ self-healing loop แบบอัตโนมัติของ agent: restart OS
// service สำคัญที่หยุดทำงาน, เคลียร์ temp directory ที่อยู่ใน allowlist
// เมื่อดิสก์ตึง, และคอยจับ/ตอบสนองต่อการใช้หน่วยความจำที่โตขึ้นของแต่ละ
// process ทุกอย่างที่ package นี้ทำถูกจำกัดด้วย config ในเครื่อง ที่ตั้งไว้
// ล่วงหน้าโดยคนที่ deploy agent — ไม่มีอะไรขยายได้แบบ dynamic ด้วยคำสั่งจาก
// server ตอน runtime เลย ทำให้เป็น trust boundary ที่แยกและแคบกว่า path
// คำสั่งระยะไกลของ internal/executor
package selfheal

import "context"

type ServiceState string

const (
	StateRunning ServiceState = "running"
	StateStopped ServiceState = "stopped"
	StateUnknown ServiceState = "unknown"
)

// ServiceController คือ abstraction ของ OS service manager: Windows SCM,
// systemd, หรือ launchd ตัว implementation อยู่ใน service_ctl_windows.go
// และ service_ctl_unix.go (แยกด้วย build-tag)
type ServiceController interface {
	Status(ctx context.Context, name string) (ServiceState, error)
	Start(ctx context.Context, name string) error
}
