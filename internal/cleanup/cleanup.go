// Package cleanup implements directory-content deletion restricted to an
// explicit allowlist. It is shared by the remote "clean_temp" command
// (internal/executor) and the autonomous disk-space self-healing monitor
// (internal/selfheal) so both paths enforce identical safety checks.
package cleanup

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// percentVarPattern matches Windows-style %VAR% environment variable
// references. os.ExpandEnv only understands $VAR / ${VAR} (Go/shell
// syntax) — configs/agent.yaml's default clean_temp_allowed_dirs entry
// ("%TEMP%") is cmd.exe syntax and silently passes through ExpandEnv
// unexpanded, so both the allowlist entry and the target end up compared
// as the literal string "%TEMP%" (the allowlist check still "matches" by
// accident) and then os.ReadDir("%TEMP%") fails because no such directory
// exists. expandEnv below expands both syntaxes.
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

// Result summarizes one cleanup pass for logging/audit purposes.
type Result struct {
	Dir     string
	Removed int
	Failed  int
}

func (r Result) String() string {
	return fmt.Sprintf("cleaned %s: removed %d entries, %d failures", r.Dir, r.Removed, r.Failed)
}

// Directory deletes the *contents* of target (never the directory itself),
// but only if target resolves — after env-var expansion and path
// cleaning — to exactly one entry in allowedDirs. This blocks path
// traversal via a caller-supplied string (e.g. "../../Users/victim/Documents")
// and blocks operating on any directory an operator didn't explicitly
// pre-approve in config.
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

// FirstAllowed returns the first configured allowlisted directory, used as
// the default target when a caller doesn't specify one.
func FirstAllowed(allowedDirs []string) (string, error) {
	if len(allowedDirs) == 0 {
		return "", fmt.Errorf("cleanup: no allowlisted directories configured")
	}
	return allowedDirs[0], nil
}
