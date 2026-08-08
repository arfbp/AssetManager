//go:build !windows

package configpush

import "fmt"

func applyPlatform(configPath, newConfigPath, serviceName string, enableRunScript bool) error {
	return fmt.Errorf("configpush: not implemented on this platform yet")
}
