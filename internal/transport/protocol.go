// Package transport implements the agent's real-time control channel: an
// outbound WebSocket connection to the fleet server carrying heartbeats and
// telemetry, and inbound signed commands.
package transport

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"optifleet-agent/internal/telemetry"
)

// MessageType discriminates the envelope's Payload.
type MessageType string

const (
	TypeHeartbeat     MessageType = "heartbeat"
	TypeTelemetry     MessageType = "telemetry"
	TypeCommand       MessageType = "command"        // server -> agent
	TypeCommandResult MessageType = "command_result" // agent -> server
	TypeCommandOutput MessageType = "command_output" // agent -> server, streamed incrementally during a long-running command
	TypeAlert         MessageType = "alert"          // agent -> server, self-healing engine events
	// TypeSelfUpdate is deliberately never produced by anything downstream of
	// the AI command parser/guardrail (server/src/llm/schema.ts's action enum
	// and protocol.ts's CommandAction type both simply never include it) — it
	// only ever comes from the server's own version-check logic in
	// ws/server.ts, never from a user-dispatched or AI-parsed command. See
	// internal/selfupdate for how the agent handles it.
	TypeSelfUpdate MessageType = "self_update" // server -> agent
	// TypeConfigUpdate is isolated from the AI/guardrail pipeline the exact
	// same way TypeSelfUpdate is (see above) — it only ever comes from the
	// server's own config-convergence check in ws/server.ts, comparing
	// ConfigHash reported in each heartbeat against the server's own
	// desired-config file. See internal/configpush.
	TypeConfigUpdate MessageType = "config_update" // server -> agent
)

// Envelope is the single wire format for every message in both directions.
type Envelope struct {
	Type    MessageType     `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type HeartbeatPayload struct {
	AgentID string `json:"agent_id"`
	Uptime  int64  `json:"uptime_seconds"`
	// Version lets the server (ws/server.ts) notice an outdated agent and
	// push a self_update — see internal/version.
	Version string `json:"version"`
	// ConfigHash is a SHA256 of the agent's own currently-loaded agent.yaml
	// file bytes, computed once at startup (see cmd/agent/main.go). Lets the
	// server (ws/server.ts) notice this agent's config has drifted from the
	// fleet's desired config and push a config_update — see
	// internal/configpush.
	ConfigHash string `json:"config_hash"`
}

type TelemetryPayload struct {
	Snapshot telemetry.Snapshot `json:"snapshot"`
}

// CommandPayload is a command issued by the server. Signature is an
// HMAC-SHA256 (hex) computed by the server over ID+Action+Params+IssuedAtUnix
// using the shared secret configured out-of-band — the agent recomputes it
// locally and refuses to execute on mismatch. This stops a compromised or
// spoofed relay from injecting commands even over an otherwise-authenticated
// WebSocket session.
type CommandPayload struct {
	ID           string            `json:"id"`
	Action       string            `json:"action"` // e.g. "kill_process", "clean_temp", "restart_host"
	Params       map[string]string `json:"params"`
	IssuedAtUnix int64             `json:"issued_at_unix"`
	Signature    string            `json:"signature"`
}

// netstring encodes s as "<byte-length>:<bytes>" (Bencode-style). It is
// self-delimiting — no escaping is needed for any byte content, including a
// run_script body that might contain arbitrary shell/PowerShell text. This
// is deliberately not JSON: reproducing Go's json.Marshal byte-for-byte in
// another language means also reproducing its default HTML-escaping of
// `<`, `>`, `&`, which is a real footgun for exactly the kind of content
// run_script carries. See optifleet-server/src/crypto/commandSigner.ts for
// the matching TypeScript implementation — the two MUST stay in sync.
func netstring(s string) string {
	return strconv.Itoa(len(s)) + ":" + s
}

// CanonicalString produces a deterministic representation for signing.
// Params are sorted by key (map iteration order in Go is randomized) and
// each field is netstring-encoded so concatenation is unambiguous.
func (c CommandPayload) CanonicalString() string {
	keys := make([]string, 0, len(c.Params))
	for k := range c.Params {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var paramsBlob strings.Builder
	for _, k := range keys {
		paramsBlob.WriteString(netstring(k))
		paramsBlob.WriteString(netstring(c.Params[k]))
	}

	var b strings.Builder
	b.WriteString(netstring(c.ID))
	b.WriteString(netstring(c.Action))
	b.WriteString(netstring(strconv.FormatInt(c.IssuedAtUnix, 10)))
	b.WriteString(netstring(paramsBlob.String()))
	return b.String()
}

// VerifySignature checks the HMAC-SHA256 signature against secret.
func (c CommandPayload) VerifySignature(secret string) bool {
	if c.Signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(c.CanonicalString()))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(c.Signature))
}

// SelfUpdatePayload instructs the agent to download and install a specific
// new build of itself. Signed the same way CommandPayload is (HMAC-SHA256
// over a netstring-canonical form, same shared secret) — this is the one
// message type that makes the agent download-and-execute new code, so it
// gets exactly as much integrity protection as an operator-dispatched
// command, even though nothing about it ever passes through the guardrail.
// URL is always the agent hub's own host:port (the same TLS connection/cert
// the agent already trusts for its WebSocket — see selfupdate.Apply), not
// an arbitrary server-supplied address, precisely so a compromised signing
// secret is the only way to redirect this to somewhere else.
type SelfUpdatePayload struct {
	Version      string `json:"version"`
	URL          string `json:"url"`
	SHA256       string `json:"sha256"`
	IssuedAtUnix int64  `json:"issued_at_unix"`
	Signature    string `json:"signature"`
}

func (s SelfUpdatePayload) canonicalString() string {
	var b strings.Builder
	b.WriteString(netstring(s.Version))
	b.WriteString(netstring(s.URL))
	b.WriteString(netstring(s.SHA256))
	b.WriteString(netstring(strconv.FormatInt(s.IssuedAtUnix, 10)))
	return b.String()
}

// VerifySignature checks the HMAC-SHA256 signature against secret — same
// reasoning as CommandPayload.VerifySignature.
func (s SelfUpdatePayload) VerifySignature(secret string) bool {
	if s.Signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(s.canonicalString()))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(s.Signature))
}

// ConfigUpdatePayload instructs the agent to replace its own agent.yaml
// content and, if EnableRunScript is set, ensure
// OPTIFLEET_ENABLE_RUN_SCRIPT=true is present in the service's environment,
// then restart. Same trust model as SelfUpdatePayload — HMAC-signed over a
// netstring-canonical form, never reachable from the AI/guardrail pipeline —
// see internal/configpush and TypeConfigUpdate's doc comment above.
//
// EnableRunScript is a fixed literal flag rather than a generic
// map[string]string of env vars deliberately: internal/configpush's Windows
// apply step has to splice values into a generated batch script, and a
// generic server-supplied key/value pair sitting unescaped in generated
// batch-script text is a command-injection footgun. A closed set of known
// literals (currently exactly one) has no such surface.
type ConfigUpdatePayload struct {
	ConfigYAML      string `json:"config_yaml"`
	ConfigSHA256    string `json:"config_sha256"`
	EnableRunScript bool   `json:"enable_run_script"`
	IssuedAtUnix    int64  `json:"issued_at_unix"`
	Signature       string `json:"signature"`
}

func (c ConfigUpdatePayload) canonicalString() string {
	var b strings.Builder
	b.WriteString(netstring(c.ConfigYAML))
	b.WriteString(netstring(c.ConfigSHA256))
	b.WriteString(netstring(strconv.FormatBool(c.EnableRunScript)))
	b.WriteString(netstring(strconv.FormatInt(c.IssuedAtUnix, 10)))
	return b.String()
}

// VerifySignature checks the HMAC-SHA256 signature against secret — same
// reasoning as CommandPayload.VerifySignature.
func (c ConfigUpdatePayload) VerifySignature(secret string) bool {
	if c.Signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(c.canonicalString()))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(c.Signature))
}

type CommandResultPayload struct {
	CommandID    string `json:"command_id"`
	Success      bool   `json:"success"`
	Message      string `json:"message"`
	ExecutedUnix int64  `json:"executed_unix"`
}

// CommandOutputPayload carries one incremental chunk (typically one line)
// of a long-running command's output as it's produced — e.g. one hop of a
// tracert, or one line of ping's reply log — rather than making the caller
// wait for the whole command to finish before seeing anything. Done=true
// marks the final chunk (Line may be empty on that one); Error carries a
// failure that happened mid-stream (e.g. the command timed out), distinct
// from a merely-empty successful run.
type CommandOutputPayload struct {
	CommandID string `json:"command_id"`
	Line      string `json:"line"`
	Done      bool   `json:"done"`
	Error     string `json:"error,omitempty"`
}

// AlertPayload carries a self-healing engine event to the server: a service
// was auto-restarted, a disk was auto-cleaned, a suspected memory leak was
// found, etc. Kind is a stable machine-readable label; Fields carries
// event-specific detail for display/alerting server-side.
type AlertPayload struct {
	Kind      string            `json:"kind"`
	Message   string            `json:"message"`
	Fields    map[string]string `json:"fields,omitempty"`
	Timestamp int64             `json:"timestamp_unix"`
}

func Encode(msgType MessageType, payload any) ([]byte, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("transport: marshal payload: %w", err)
	}
	env := Envelope{Type: msgType, Payload: raw}
	return json.Marshal(env)
}
