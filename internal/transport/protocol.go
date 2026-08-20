// Package transport คือ control channel แบบ real-time ของ agent: WebSocket
// connection ขาออกไปยัง fleet server ที่พา heartbeat และ telemetry ไป
// และรับคำสั่งที่เซ็นมาแล้วเข้ามา
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

// MessageType ใช้แยกแยะชนิดของ Payload ใน envelope
type MessageType string

const (
	TypeHeartbeat     MessageType = "heartbeat"
	TypeTelemetry     MessageType = "telemetry"
	TypeCommand       MessageType = "command"        // server -> agent
	TypeCommandResult MessageType = "command_result" // agent -> server
	TypeCommandOutput MessageType = "command_output" // agent -> server, streamed incrementally during a long-running command
	TypeAlert         MessageType = "alert"          // agent -> server, event ของ self-healing engine
	// TypeSelfUpdate ตั้งใจไม่ให้ถูกสร้างโดยอะไรก็ตามที่อยู่ปลายทางของ AI
	// command parser/guardrail เลย (action enum ของ server/src/llm/schema.ts
	// และ CommandAction type ของ protocol.ts ทั้งคู่ไม่มีค่านี้อยู่เลย) —
	// มันมาจาก version-check logic ของ server เองใน ws/server.ts เท่านั้น
	// ไม่เคยมาจากคำสั่งที่ user สั่งหรือ AI parse มา ดู internal/selfupdate
	// ว่า agent จัดการมันยังไง
	TypeSelfUpdate MessageType = "self_update" // server -> agent
	// TypeConfigUpdate ถูกแยกออกจาก pipeline ของ AI/guardrail ด้วยวิธี
	// เดียวกับ TypeSelfUpdate เป๊ะ ๆ (ดูด้านบน) — มันมาจาก
	// config-convergence check ของ server เองใน ws/server.ts เท่านั้น ที่
	// เทียบ ConfigHash ที่รายงานมาในแต่ละ heartbeat กับไฟล์
	// desired-config ของ server เอง ดู internal/configpush
	TypeConfigUpdate MessageType = "config_update" // server -> agent
)

// Envelope คือ wire format แบบเดียวที่ใช้กับทุก message ทั้งสองทิศทาง
type Envelope struct {
	Type    MessageType     `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type HeartbeatPayload struct {
	AgentID string `json:"agent_id"`
	Uptime  int64  `json:"uptime_seconds"`
	// Version ให้ server (ws/server.ts) สังเกตได้ว่า agent เวอร์ชันเก่าแล้ว
	// จะได้ push self_update — ดู internal/version
	Version string `json:"version"`
	// ConfigHash คือ SHA256 ของไบต์ไฟล์ agent.yaml ที่ agent โหลดอยู่ตอนนี้
	// คำนวณครั้งเดียวตอน startup (ดู cmd/agent/main.go) ให้ server
	// (ws/server.ts) สังเกตได้ว่า config ของ agent นี้ drift ไปจาก desired
	// config ของฟลีตแล้ว จะได้ push config_update — ดู internal/configpush
	ConfigHash string `json:"config_hash"`
}

type TelemetryPayload struct {
	Snapshot telemetry.Snapshot `json:"snapshot"`
}

// CommandPayload คือคำสั่งที่ server ออกมา Signature เป็น HMAC-SHA256
// (hex) ที่ server คำนวณจาก ID+Action+Params+IssuedAtUnix โดยใช้ shared
// secret ที่ config ไว้แบบ out-of-band — agent คำนวณซ้ำในเครื่องแล้วปฏิเสธ
// ไม่รันถ้าไม่ตรงกัน ป้องกันไม่ให้ relay ที่ถูก compromise หรือปลอมแปลง
// injection คำสั่งเข้ามาได้ แม้จะผ่าน WebSocket session ที่
// authenticate แล้วก็ตาม
type CommandPayload struct {
	ID           string            `json:"id"`
	Action       string            `json:"action"` // e.g. "kill_process", "clean_temp", "restart_host"
	Params       map[string]string `json:"params"`
	IssuedAtUnix int64             `json:"issued_at_unix"`
	Signature    string            `json:"signature"`
}

// netstring encode s เป็น "<byte-length>:<bytes>" (สไตล์ Bencode) เป็นแบบ
// self-delimiting — ไม่ต้อง escape byte content อะไรเลย รวมถึง body ของ
// run_script ที่อาจมีข้อความ shell/PowerShell แบบไหนก็ได้ ตั้งใจไม่ใช้
// JSON: การทำ json.Marshal ของ Go ให้ตรงกัน byte-ต่อ-byte ในภาษาอื่น
// หมายถึงต้อง reproduce การ HTML-escape ค่า default ของมันสำหรับ `<`, `>`,
// `&` ด้วย ซึ่งเป็น footgun จริง ๆ สำหรับเนื้อหาแบบที่ run_script พาไปพอดี
// ดู optifleet-server/src/crypto/commandSigner.ts สำหรับ TypeScript
// implementation ที่ตรงกัน — ทั้งสองฝั่งต้องซิงค์กันเสมอ
func netstring(s string) string {
	return strconv.Itoa(len(s)) + ":" + s
}

// CanonicalString สร้าง representation แบบ deterministic สำหรับเซ็น
// Params เรียงตาม key (ลำดับการ iterate map ใน Go เป็นแบบสุ่ม) และแต่ละ
// field encode ด้วย netstring เพื่อให้การต่อ string ไม่กำกวม
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

// VerifySignature ตรวจ HMAC-SHA256 signature เทียบกับ secret
func (c CommandPayload) VerifySignature(secret string) bool {
	if c.Signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(c.CanonicalString()))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(c.Signature))
}

// SelfUpdatePayload สั่งให้ agent download และติดตั้ง build ใหม่ของ
// ตัวเองที่ระบุไว้ เซ็นด้วยวิธีเดียวกับ CommandPayload (HMAC-SHA256 บน
// netstring-canonical form, shared secret เดียวกัน) — นี่คือ message type
// เดียวที่ทำให้ agent download-and-execute โค้ดใหม่ จึงได้รับการปกป้อง
// เรื่อง integrity เท่ากับคำสั่งที่ operator สั่งเป๊ะ ๆ แม้จะไม่มีส่วนไหน
// เลยที่ผ่าน guardrail ก็ตาม URL เป็น host:port ของ agent hub เองเสมอ
// (TLS connection/cert ตัวเดียวกับที่ agent ไว้ใจอยู่แล้วสำหรับ WebSocket
// ของมัน — ดู selfupdate.Apply) ไม่ใช่ address ที่ server ส่งมาแบบไหนก็ได้
// เพื่อให้ secret ที่ใช้เซ็นถูก compromise เป็นทางเดียวเท่านั้นที่จะ
// redirect ไปที่อื่นได้
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

// VerifySignature ตรวจ HMAC-SHA256 signature เทียบกับ secret — เหตุผล
// เดียวกับ CommandPayload.VerifySignature
func (s SelfUpdatePayload) VerifySignature(secret string) bool {
	if s.Signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(s.canonicalString()))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(s.Signature))
}

// ConfigUpdatePayload สั่งให้ agent แทนที่เนื้อหา agent.yaml ของตัวเอง และ
// ถ้า EnableRunScript ถูก set ไว้ ให้แน่ใจว่า
// OPTIFLEET_ENABLE_RUN_SCRIPT=true มีอยู่ใน environment ของ service แล้ว
// restart trust model เดียวกับ SelfUpdatePayload — เซ็นด้วย HMAC บน
// netstring-canonical form ไม่มีทางเข้าถึงได้จาก pipeline ของ
// AI/guardrail เลย — ดู internal/configpush และ doc comment ของ
// TypeConfigUpdate ด้านบน
//
// EnableRunScript ตั้งใจให้เป็น flag literal ตายตัวแทนที่จะเป็น
// map[string]string ของ env var แบบทั่วไป: ขั้นตอน apply บน Windows ของ
// internal/configpush ต้องแปะค่าลงใน batch script ที่ generate ขึ้น และ
// คู่ key/value ที่ server ส่งมาแบบทั่วไปโดยไม่ escape อยู่ใน batch-script
// text ที่ generate ขึ้นเป็น footgun เรื่อง command-injection ชัด ๆ ชุด
// literal ที่รู้จักแบบปิด (ตอนนี้มีอยู่ตัวเดียวพอดี) ไม่มีช่องโหว่แบบนั้น
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

// VerifySignature ตรวจ HMAC-SHA256 signature เทียบกับ secret — เหตุผล
// เดียวกับ CommandPayload.VerifySignature
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

// CommandOutputPayload พา output ของคำสั่งที่รันนานทีละ chunk (ปกติทีละ
// บรรทัด) ตามที่มันถูกผลิตออกมา — เช่น หนึ่ง hop ของ tracert หรือหนึ่ง
// บรรทัด reply log ของ ping — แทนที่จะให้ caller รอทั้งคำสั่งจบก่อนถึงจะ
// เห็นอะไร Done=true คือ chunk สุดท้าย (Line อาจว่างเปล่าในตัวนั้น);
// Error พา failure ที่เกิดกลาง stream (เช่น คำสั่ง timeout) แยกจากการรัน
// สำเร็จที่แค่ไม่มี output
type CommandOutputPayload struct {
	CommandID string `json:"command_id"`
	Line      string `json:"line"`
	Done      bool   `json:"done"`
	Error     string `json:"error,omitempty"`
}

// AlertPayload พา event ของ self-healing engine ไปให้ server: service
// ถูก auto-restart, ดิสก์ถูก auto-clean, เจอ memory leak ที่ต้องสงสัย
// ฯลฯ Kind เป็น label ที่เครื่องอ่านได้แบบ stable; Fields พารายละเอียด
// เฉพาะของแต่ละ event ไว้แสดงผล/alert ฝั่ง server
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
