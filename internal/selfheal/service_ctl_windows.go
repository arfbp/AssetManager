//go:build windows

package selfheal

import (
	"context"
	"fmt"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// windowsServiceController คุยกับ Windows Service Control Manager ตรง ๆ
// ผ่าน golang.org/x/sys/windows/svc/mgr แทนที่จะ shell out ไปเรียก sc.exe
// แล้ว parse text output — API ของ SCM เป็นทางเลือกที่ robust กว่า และ
// agent ก็รันด้วยสิทธิ์ที่ต้องใช้อยู่แล้ว (LocalSystem) เพื่อเรียกใช้ได้
type windowsServiceController struct{}

func NewServiceController() ServiceController {
	return windowsServiceController{}
}

func (windowsServiceController) Status(_ context.Context, name string) (ServiceState, error) {
	m, err := mgr.Connect()
	if err != nil {
		return StateUnknown, fmt.Errorf("selfheal: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return StateUnknown, fmt.Errorf("selfheal: open service %q: %w", name, err)
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return StateUnknown, fmt.Errorf("selfheal: query service %q: %w", name, err)
	}

	switch status.State {
	case svc.Running:
		return StateRunning, nil
	case svc.Stopped:
		return StateStopped, nil
	default:
		// StartPending, StopPending, Paused ฯลฯ — ถือว่า "ยังไม่ใช่เรื่องของ
		// เราตอนนี้" รอบ poll ถัดไปจะเช็คซ้ำเอง
		return StateUnknown, nil
	}
}

func (windowsServiceController) Start(_ context.Context, name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("selfheal: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("selfheal: open service %q: %w", name, err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("selfheal: start service %q: %w", name, err)
	}
	return nil
}
