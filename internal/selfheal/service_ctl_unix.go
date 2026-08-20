//go:build !windows

package selfheal

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// unixServiceController shell out ไปเรียก systemctl (Linux) หรือ
// launchctl (macOS) — ไม่มี API แบบ SCM ของ Windows ให้ใช้บนทั้งสองระบบนี้
// ดังนั้น CLI tooling มาตรฐานคือทางเลือกที่ใช้งานได้จริงตรงนี้ เหมือนกับ
// management agent ส่วนใหญ่บน Linux/macOS
type unixServiceController struct{}

func NewServiceController() ServiceController {
	return unixServiceController{}
}

func (unixServiceController) Status(ctx context.Context, name string) (ServiceState, error) {
	switch runtime.GOOS {
	case "linux":
		out, err := exec.CommandContext(ctx, "systemctl", "is-active", name).Output()
		state := strings.TrimSpace(string(out))
		// systemctl is-active exit ไม่เป็น 0 สำหรับสถานะ "inactive"/"failed"
		// แต่ก็ยังพิมพ์ state ที่ valid ออกมาทาง stdout — ต้อง output ว่าง
		// เปล่าร่วมกับมี error เท่านั้นถึงจะหมายความว่าคำสั่งเองรันไม่สำเร็จ
		if state == "" && err != nil {
			return StateUnknown, fmt.Errorf("selfheal: systemctl is-active %q: %w", name, err)
		}
		switch state {
		case "active":
			return StateRunning, nil
		case "inactive", "failed":
			return StateStopped, nil
		default:
			return StateUnknown, nil
		}
	case "darwin":
		if err := exec.CommandContext(ctx, "launchctl", "list", name).Run(); err != nil {
			// launchctl list exit ไม่เป็น 0 เมื่อ label นั้นยังไม่ได้ load
			return StateStopped, nil
		}
		return StateRunning, nil
	default:
		return StateUnknown, fmt.Errorf("selfheal: unsupported GOOS=%s", runtime.GOOS)
	}
}

func (unixServiceController) Start(ctx context.Context, name string) error {
	switch runtime.GOOS {
	case "linux":
		if err := exec.CommandContext(ctx, "systemctl", "start", name).Run(); err != nil {
			return fmt.Errorf("selfheal: systemctl start %q: %w", name, err)
		}
		return nil
	case "darwin":
		if err := exec.CommandContext(ctx, "launchctl", "kickstart", "-k", "system/"+name).Run(); err != nil {
			return fmt.Errorf("selfheal: launchctl kickstart %q: %w", name, err)
		}
		return nil
	default:
		return fmt.Errorf("selfheal: unsupported GOOS=%s", runtime.GOOS)
	}
}
