// Package executor แปลงคำสั่งจาก server ที่ authenticate แล้วให้กลายเป็น
// action ในเครื่อง ทุกคำสั่งจะถูก (1) ตรวจสอบ signature, (2) เช็คกับ
// allowlist ที่กำหนดไว้ชัดเจน, (3) รันด้วย safety check เฉพาะของแต่ละ
// action, และ (4) audit-log ไม่ว่าผลจะออกมาแบบไหน — accepted, rejected,
// หรือ failed
package executor

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog"
	processutil "github.com/shirou/gopsutil/v3/process"

	"optifleet-agent/internal/cleanup"
	"optifleet-agent/internal/transport"
)

// protectedProcessNames ห้าม kill จากระยะไกลเด็ดขาด — ถ้า kill พวกนี้เข้า
// อาจทำให้เครื่อง crash หรือเข้าเครื่องไม่ได้อีก ซึ่งขัดกับจุดประสงค์ของ
// management agent เอง
var protectedProcessNames = map[string]struct{}{
	"system":       {},
	"csrss.exe":    {},
	"wininit.exe":  {},
	"winlogon.exe": {},
	"services.exe": {},
	"smss.exe":     {},
	"lsass.exe":    {},
	"init":         {},
	"launchd":      {},
	"systemd":      {},
	"kernel_task":  {},
}

type Config struct {
	AllowedActions       map[string]struct{}
	HMACSecret           string
	CleanTempAllowedDirs []string
	RestartConfirmDelay  time.Duration

	// run_script คือ action ที่เสี่ยงที่สุดที่ agent นี้เปิดให้ใช้: มันรัน
	// เนื้อหาสคริปต์ที่ server ส่งมาตรง ๆ (เป็น SYSTEM/root ไม่มีหน้าต่าง
	// interactive) จะเรียกใช้ได้ก็ต่อเมื่อ "run_script" มีอยู่ใน
	// AllowedActions อย่างชัดเจนเท่านั้น — ปิดไว้เป็น default ใน
	// configs/agent.yaml ขอบเขตพวกนี้บังคับใช้เสมอแม้เปิดใช้งานแล้ว จะปิดไม่
	// ได้ ทำได้แค่บีบให้แคบลง
	ScriptTimeout        time.Duration // kill ทันทีถ้าสคริปต์รันนานเกินนี้
	MaxScriptBytes       int           // ปฏิเสธ script body ที่ใหญ่กว่านี้
	MaxScriptOutputBytes int           // stdout+stderr ที่เก็บ/audit ต่อการรันหนึ่งครั้ง ตัดทิ้งถ้าเกินนี้
}

type Executor struct {
	cfg   Config
	log   zerolog.Logger
	audit zerolog.Logger

	// set ผ่าน SetOutputSender หลังสร้าง object แล้ว — main.go ต่อสายอันนี้
	// เข้ากับ transport.Client.SendCommandOutput เมื่อ client ถูกสร้างแล้ว
	// ซึ่ง client เองก็ถูกสร้าง *หลัง* executor (constructor ของ client เอง
	// ต้องใช้ Executor.Handle เป็น argument) จึงทำเป็น constructor
	// parameter ตรง ๆ ไม่ได้ ไม่งั้นจะเกิด circular dependency ระหว่างสอง
	// ตัวนี้
	sendOutput func(commandID, line string, done bool, errMsg string)

	// set ผ่าน SetStateChangeNotifier — เหตุผลเรื่อง deferred-wiring
	// เดียวกับ sendOutput (poller ถูกสร้างหลัง executor) จะถูกเรียกหลังคำสั่ง
	// ใน stateChangingActions สำเร็จ เพื่อให้รายการ process บน dashboard
	// สะท้อนการ kill ทันที แทนที่จะรอ snapshot รอบถัดไปตาม NormalInterval
	// (เป็นนาที)
	notifyStateChanged func()
}

// stateChangingActions คือคำสั่งที่สำเร็จแล้วเปลี่ยนสิ่งที่ telemetry
// snapshot *รอบถัดไป* จะแสดงอย่างเห็นได้ชัด — kill_process ลบแถวออกจาก
// top_processes, clean_temp เปลี่ยนพื้นที่ว่างของดิสก์ ส่วน restart_host กับ
// run_script ตั้งใจไม่รวมไว้: reboot ไม่มี "snapshot รอบถัดไป" ให้เร่งอยู่
// แล้ว (เครื่องกำลังจะดับ) ส่วนผลของ run_script นั้นเปิดกว้างเกินกว่าที่การ
// refresh แบบทั่วไปจะเล็งเป้าได้
var stateChangingActions = map[string]struct{}{
	"kill_process": {},
	"clean_temp":   {},
}

func New(cfg Config, log, audit zerolog.Logger) *Executor {
	return &Executor{cfg: cfg, log: log.With().Str("component", "executor").Logger(), audit: audit}
}

// SetOutputSender ต่อสาย streaming output สำหรับคำสั่งที่รันนาน
// (network_diagnostic) — ดู field comment ของ Executor.sendOutput ไม่ set
// ก็ปลอดภัย (เช่นตอน test): networkDiagnostic แค่ข้ามการส่งแบบ incremental
// ไป แล้ว caller จะเห็นแค่ CommandResultPayload สรุปตอนจบเท่านั้น
func (e *Executor) SetOutputSender(fn func(commandID, line string, done bool, errMsg string)) {
	e.sendOutput = fn
}

// SetStateChangeNotifier ต่อสายการ refresh telemetry นอกรอบปกติ — ดู field
// comment ของ notifyStateChanged ไม่ set ก็ปลอดภัย (เช่นตอน test):
// dashboard จะกลับไปเห็นการเปลี่ยนแปลงในรอบ poll ถัดไปตามปกติแทน
func (e *Executor) SetStateChangeNotifier(fn func()) {
	e.notifyStateChanged = fn
}

// Handle implement transport.CommandHandler เป็นจุดคอขวดจุดเดียวที่ทุก
// คำสั่งขาเข้าต้องผ่าน
func (e *Executor) Handle(ctx context.Context, cmd transport.CommandPayload) (result transport.CommandResultPayload) {
	result = transport.CommandResultPayload{CommandID: cmd.ID, ExecutedUnix: time.Now().Unix()}

	// handler ของคำสั่งที่พังต้องไม่ดึงเอา agent ทั้งตัวล้มไปด้วย
	defer func() {
		if r := recover(); r != nil {
			e.log.Error().Interface("panic", r).Str("command_id", cmd.ID).Str("action", cmd.Action).Msg("command handler panicked, recovered")
			result.Success = false
			result.Message = fmt.Sprintf("internal error executing command: %v", r)
		}
	}()

	auditEvt := e.audit.Info().Str("command_id", cmd.ID).Str("action", cmd.Action).Interface("params", cmd.Params)

	if !cmd.VerifySignature(e.cfg.HMACSecret) {
		auditEvt.Bool("accepted", false).Str("reason", "signature_invalid").Msg("command rejected")
		result.Success = false
		result.Message = "signature verification failed"
		return result
	}

	// ปฏิเสธคำสั่งที่เก่าเกินไป เพื่อลดคุณค่าของ replay attack จาก envelope
	// ที่ถูกดักจับไว้
	if age := time.Since(time.Unix(cmd.IssuedAtUnix, 0)); age > 2*time.Minute || age < -30*time.Second {
		auditEvt.Bool("accepted", false).Str("reason", "stale_or_future_timestamp").Dur("age", age).Msg("command rejected")
		result.Success = false
		result.Message = "command timestamp outside acceptable window"
		return result
	}

	if _, ok := e.cfg.AllowedActions[cmd.Action]; !ok {
		auditEvt.Bool("accepted", false).Str("reason", "not_in_allowlist").Msg("command rejected")
		result.Success = false
		result.Message = fmt.Sprintf("action %q is not in the allowlist", cmd.Action)
		return result
	}

	auditEvt.Bool("accepted", true).Msg("command accepted, executing")

	var msg string
	var err error
	switch cmd.Action {
	case "kill_process":
		msg, err = e.killProcess(ctx, cmd.Params)
	case "clean_temp":
		msg, err = e.cleanTemp(cmd.Params)
	case "restart_host":
		msg, err = e.restartHost(cmd.Params)
	case "shutdown_host":
		msg, err = e.shutdownHost(cmd.Params)
	case "run_script":
		msg, err = e.runScript(ctx, cmd)
	case "network_diagnostic":
		msg, err = e.networkDiagnostic(ctx, cmd.ID, cmd.Params)
	default:
		err = fmt.Errorf("no handler implemented for allowlisted action %q", cmd.Action)
	}

	if err != nil {
		e.audit.Error().Str("command_id", cmd.ID).Str("action", cmd.Action).Err(err).Msg("command execution failed")
		result.Success = false
		result.Message = err.Error()
		return result
	}

	e.audit.Info().Str("command_id", cmd.ID).Str("action", cmd.Action).Str("result", msg).Msg("command executed")
	result.Success = true
	result.Message = msg

	if _, ok := stateChangingActions[cmd.Action]; ok && e.notifyStateChanged != nil {
		e.notifyStateChanged()
	}

	return result
}

// killProcess รับได้ทั้ง params["pid"] (แม่นยำ ไม่กำกวม) หรือ
// params["name"] (resolve กับ process list ที่รันอยู่จริง ณ เวลา execute
// — ไม่ใช่ telemetry snapshot เก่า) การค้นหาด้วยชื่อมีไว้เพราะคำสั่งแบบ
// natural language ("ปิดตัวสแกนแอนตี้ไวรัสที่ค้างอยู่") ระบุชื่อโปรแกรม ไม่
// ใช่ PID; LLM parser และ guardrail ฝั่ง server ไม่เคยสร้าง PID ขึ้นมาเอง
// ถ้าชื่อ match กับ process ที่รันอยู่มากกว่าหนึ่งตัว ฟังก์ชันนี้จะปฏิเสธ
// แทนที่จะ kill ทั้งหมด — การขยาย blast radius จาก kill หนึ่ง process ไป
// เป็นหลายตัวโดยไม่บอกใคร จาก fuzzy name match แบบนี้ เป็นสิ่งที่ design
// ของ agent นี้พยายามเลี่ยงในทุกจุด (ดู doc comment ของ package executor)
func (e *Executor) killProcess(ctx context.Context, params map[string]string) (string, error) {
	if pidStr, ok := params["pid"]; ok {
		pid, err := strconv.ParseInt(pidStr, 10, 32)
		if err != nil {
			return "", fmt.Errorf("kill_process: invalid pid %q: %w", pidStr, err)
		}
		return e.killByPID(ctx, int32(pid))
	}

	name := strings.TrimSpace(params["name"])
	if name == "" {
		return "", fmt.Errorf("kill_process: requires either params.pid or params.name")
	}
	return e.killByName(ctx, name)
}

func (e *Executor) killByPID(ctx context.Context, pid int32) (string, error) {
	if pid <= 4 { // 0 กับ 4 (System) บน Windows, 1 (init/launchd) บน Unix
		return "", fmt.Errorf("kill_process: refusing to touch protected low-numbered pid %d", pid)
	}

	proc, err := processutil.NewProcessWithContext(ctx, pid)
	if err != nil {
		return "", fmt.Errorf("kill_process: pid %d not found: %w", pid, err)
	}
	name, _ := proc.NameWithContext(ctx)
	if _, protected := protectedProcessNames[strings.ToLower(name)]; protected {
		return "", fmt.Errorf("kill_process: refusing to kill protected process %q (pid %d)", name, pid)
	}

	if err := proc.KillWithContext(ctx); err != nil {
		return "", fmt.Errorf("kill_process: pid %d: %w", pid, err)
	}
	return fmt.Sprintf("killed pid %d (%s)", pid, name), nil
}

type processMatch struct {
	proc       *processutil.Process
	createTime int64
}

func (e *Executor) killByName(ctx context.Context, name string) (string, error) {
	if _, protected := protectedProcessNames[strings.ToLower(name)]; protected {
		return "", fmt.Errorf("kill_process: refusing to kill protected process %q", name)
	}

	procs, err := processutil.ProcessesWithContext(ctx)
	if err != nil {
		return "", fmt.Errorf("kill_process: list processes: %w", err)
	}

	var matches []processMatch
	for _, p := range procs {
		pName, err := p.NameWithContext(ctx)
		if err != nil {
			continue
		}
		if strings.EqualFold(pName, name) {
			createTime, _ := p.CreateTimeWithContext(ctx)
			matches = append(matches, processMatch{proc: p, createTime: createTime})
		}
	}

	switch len(matches) {
	case 0:
		return "", fmt.Errorf("kill_process: no running process named %q", name)
	case 1:
		return e.killVerified(ctx, matches[0], name)
	default:
		pids := make([]string, len(matches))
		for i, m := range matches {
			pids[i] = strconv.FormatInt(int64(m.proc.Pid), 10)
		}
		return "", fmt.Errorf(
			"kill_process: %d processes named %q are running (pids: %s) — retry with params.pid to pick one",
			len(matches), name, strings.Join(pids, ", "),
		)
	}
}

// killVerified เช็คชื่อและเวลาเริ่มของ process ซ้ำอีกครั้งทันทีก่อน kill
// ต่อจากการค้นหาด้วยชื่อใน killByName ด้านบน OS สามารถ recycle PID ให้
// process ที่ไม่เกี่ยวข้องกันได้ระหว่างช่วง "list process ทั้งหมด" กับ
// "kill PID นี้" — การอ่านทั้งชื่อและ creation time ซ้ำด้วย PID ก่อน kill
// ช่วยบีบช่องโหว่นี้จาก "การสแกน process list ทั้งหมด" ให้เหลือแค่ syscall
// เดียว จะปิดให้เป็นศูนย์เลยในระดับ userspace ไม่ได้ (ต้องใช้ kernel handle
// ไม่ใช่แค่อ่านซ้ำด้วย PID) แต่การที่ PID ถูก recycle ไปเป็น process ชื่อ
// เดียวกันพร้อม timestamp เริ่มต้นเดียวกันภายในช่วง syscall เดียวนั้น ไม่ใช่
// สถานการณ์ที่สมจริงพอจะต้องป้องกันเพิ่มอีก
func (e *Executor) killVerified(ctx context.Context, m processMatch, expectedName string) (string, error) {
	freshName, err := m.proc.NameWithContext(ctx)
	if err != nil || !strings.EqualFold(freshName, expectedName) {
		return "", fmt.Errorf("kill_process: pid %d no longer matches %q (now %q) — not killing, likely pid reuse", m.proc.Pid, expectedName, freshName)
	}
	if m.createTime != 0 {
		if freshCreateTime, err := m.proc.CreateTimeWithContext(ctx); err == nil && freshCreateTime != m.createTime {
			return "", fmt.Errorf("kill_process: pid %d process identity changed since lookup — not killing, likely pid reuse", m.proc.Pid)
		}
	}
	return e.killByPID(ctx, m.proc.Pid)
}

// cleanTemp ลบเนื้อหา (ไม่ลบตัวไดเรกทอรี) ของไดเรกทอรีที่อยู่ใน allowlist
// หนึ่งรายการ โดยส่งต่อ safety check จริง ๆ (path traversal, การเป็นสมาชิก
// ของ allowlist) ให้ package internal/cleanup ที่ใช้ร่วมกับ self-healing
// monitor ของดิสก์แบบอัตโนมัติด้วย
func (e *Executor) cleanTemp(params map[string]string) (string, error) {
	target := params["dir"]
	if target == "" {
		var err error
		target, err = cleanup.FirstAllowed(e.cfg.CleanTempAllowedDirs)
		if err != nil {
			return "", fmt.Errorf("clean_temp: %w", err)
		}
	}

	res, err := cleanup.Directory(e.cfg.CleanTempAllowedDirs, target)
	if err != nil {
		return "", fmt.Errorf("clean_temp: %w", err)
	}
	return res.String(), nil
}

// restartHost ตั้งเวลา restart เครื่องหลังจาก cfg.RestartConfirmDelay
// เพื่อไม่ให้คำสั่งเดียวที่ผิดพลาดหรือมุ่งร้ายดึงเครื่องออกจากมือ user โดยไม่
// มีการเตือนล่วงหน้าเลย ต้องมี params["confirm"] == "true" เป็นสัญญาณ
// ชัดเจนอันที่สอง นอกเหนือจาก allowlist+signature check ที่ Handle บังคับ
// ใช้อยู่แล้ว
//
// ตัว delay เองถูก track โดยคำสั่ง shutdown ของ OS เอง (Windows ใช้
// "/t <seconds>", Unix ใช้ "shutdown -r +<minutes>") ไม่ใช่การ sleep อยู่ใน
// process นี้ — goroutine ที่ sleep เฉย ๆ ตรงนี้จะลืมการ restart ที่ตั้งไว้
// แบบเงียบ ๆ ถ้า agent service เองถูกหยุดหรือ crash ระหว่างช่วง delay แม้
// audit log จะบันทึกไว้แล้วว่า "scheduled" ก็ตาม กลไก delayed-shutdown ของ
// OS เองรอดจากสถานการณ์นั้นได้
func (e *Executor) restartHost(params map[string]string) (string, error) {
	if params["confirm"] != "true" {
		return "", fmt.Errorf("restart_host: requires params.confirm == \"true\"")
	}

	delay := e.cfg.RestartConfirmDelay
	if delay <= 0 {
		delay = 30 * time.Second
	}

	cmd, err := restartCommand(delay)
	if err != nil {
		return "", fmt.Errorf("restart_host: %w", err)
	}

	e.audit.Warn().Dur("delay", delay).Msg("restart_host: scheduled via OS delayed-shutdown")

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("restart_host: failed to invoke OS restart: %w", err)
	}

	return fmt.Sprintf("restart scheduled in %s (tracked by the OS, survives agent restarts)", delay), nil
}

func restartCommand(delay time.Duration) (*exec.Cmd, error) {
	switch runtime.GOOS {
	case "windows":
		secs := int(delay.Seconds())
		if secs < 0 {
			secs = 0
		}
		return exec.Command("shutdown", "/r", "/t", strconv.Itoa(secs)), nil
	case "darwin", "linux":
		// argument เวลาของ shutdown บน Unix เป็นนาที (หรือ "now"/"hh:mm")
		// ไม่ใช่วินาที — ปัดขึ้นเพื่อให้ delay ที่สั้นกว่าหนึ่งนาทียังได้
		// คำเตือนที่ OS track อย่างน้อยหนึ่งนาที แทนที่จะถูกปัดลงเหลือ 0
		// แบบเงียบ ๆ
		mins := int((delay + time.Minute - time.Nanosecond) / time.Minute)
		if mins < 1 {
			mins = 1
		}
		return exec.Command("shutdown", "-r", fmt.Sprintf("+%d", mins)), nil
	default:
		return nil, fmt.Errorf("no restart command for GOOS=%s", runtime.GOOS)
	}
}

// shutdownHost เป็นคู่กับ restartHost สำหรับการปิดเครื่องจริง ๆ — เพิ่มเข้า
// มาหลังจากคำขอของ operator จริง ("ปิดเครื่องนี้") ถูกตีความผิดเป็น
// restart_host เพราะแต่ก่อนนั้นเป็น action ระดับทั้งเครื่องตัวเดียวที่ agent
// นี้มี Reboot (restart_host) เปิดเครื่องกลับมาเองได้; shutdown_host ปิด
// เครื่องแล้วปล่อยให้ดับไป — ต่างกันในทางปฏิบัติมากพอ (ต้องมีคนไปกดปุ่ม
// power จริง ๆ หรือใช้ remote power-on แบบ out-of-band ถึงจะเปิดกลับมาได้)
// จนการปนกันระหว่างสองอย่างนี้ถือเป็นความผิดพลาดจริง ๆ ไม่ใช่แค่คำพูดต่างกัน
// ใช้เหตุผลเรื่อง confirm-gate และ OS-tracked-delay เดียวกับ restartHost
// ทุกประการ
func (e *Executor) shutdownHost(params map[string]string) (string, error) {
	if params["confirm"] != "true" {
		return "", fmt.Errorf("shutdown_host: requires params.confirm == \"true\"")
	}

	delay := e.cfg.RestartConfirmDelay
	if delay <= 0 {
		delay = 30 * time.Second
	}

	cmd, err := shutdownCommand(delay)
	if err != nil {
		return "", fmt.Errorf("shutdown_host: %w", err)
	}

	e.audit.Warn().Dur("delay", delay).Msg("shutdown_host: scheduled via OS delayed-shutdown")

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("shutdown_host: failed to invoke OS shutdown: %w", err)
	}

	return fmt.Sprintf("shutdown scheduled in %s (tracked by the OS, survives agent restarts) — the device will power off and stay off", delay), nil
}

func shutdownCommand(delay time.Duration) (*exec.Cmd, error) {
	switch runtime.GOOS {
	case "windows":
		secs := int(delay.Seconds())
		if secs < 0 {
			secs = 0
		}
		return exec.Command("shutdown", "/s", "/t", strconv.Itoa(secs)), nil
	case "darwin", "linux":
		mins := int((delay + time.Minute - time.Nanosecond) / time.Minute)
		if mins < 1 {
			mins = 1
		}
		return exec.Command("shutdown", "-h", fmt.Sprintf("+%d", mins)), nil
	default:
		return nil, fmt.Errorf("no shutdown command for GOOS=%s", runtime.GOOS)
	}
}

// runScript รันสคริปต์ที่ server ส่งมาโดยไม่มีหน้าต่าง interactive —
// เป็นความสามารถที่เสี่ยงที่สุดของ agent นี้ ทุกชั้นตรงนี้จึงมีไว้เพื่อจำกัด
// ขอบเขตและตรวจสอบย้อนกลับได้ ไม่ใช่เพื่อให้มันทรงพลังขึ้น:
//
//   - เรียกใช้ได้ก็ต่อเมื่อ "run_script" อยู่ใน allowlist ของ config ในเครื่อง
//     (ปิดไว้เป็น default) และผ่าน signature+timestamp check เดียวกับที่
//     คำสั่งอื่นทุกตัวผ่านใน Handle มาแล้วเท่านั้น;
//   - ขนาด script body และเวลารันรวมถูกจำกัดตายตัว (cfg.MaxScriptBytes /
//     cfg.ScriptTimeout) และ params ของคำสั่งเอง override ไม่ได้;
//   - script body เต็ม (hash + log ไว้) และ stdout/stderr ที่ capture มา
//     (ตัดที่ cfg.MaxScriptOutputBytes) ถูกเขียนลง audit.log ทุกครั้งที่
//     พยายามรัน ไม่ว่าจะสำเร็จหรือล้มเหลว — "ไม่มีหน้าต่าง" แปลว่ามองไม่เห็น
//     จาก interactive user session เท่านั้น ไม่เคยหมายถึงมองไม่เห็นใน audit
//     trail;
//   - child process ถูก spawn ด้วย CREATE_NO_WINDOW บน Windows (ดู
//     script_windows.go) ซึ่งเป็นสุขอนามัยมาตรฐานสำหรับ service ใด ๆ ที่ shell
//     out — Windows service เองก็ไม่มี desktop ให้แสดงหน้าต่างอยู่แล้ว
//
// agent ตรวจ *เนื้อหา* สคริปต์แบบใด ๆ ก็ได้ไม่ได้เหมือนตรวจ action รูปแบบ
// ตายตัวอย่าง kill_process — ความรับผิดชอบตรงนั้นเป็นของ workflow
// approval/RBAC ที่คุมว่าใครจะ push คำสั่ง run_script ได้ฝั่ง server ให้ถือว่า
// การเปิด action นี้เท่ากับให้สิทธิ์ SYSTEM/root เต็มรูปแบบบนทุกเครื่องที่
// ลงทะเบียนไว้ กับใครก็ตามที่คุม workflow ฝั่ง server นั้นอยู่
func (e *Executor) runScript(ctx context.Context, cmd transport.CommandPayload) (string, error) {
	interpreter := cmd.Params["interpreter"]
	script := cmd.Params["script"]
	if script == "" {
		return "", fmt.Errorf("run_script: missing required param 'script'")
	}

	maxBytes := e.cfg.MaxScriptBytes
	if maxBytes <= 0 {
		maxBytes = 32 * 1024
	}
	if len(script) > maxBytes {
		return "", fmt.Errorf("run_script: script body %d bytes exceeds limit %d", len(script), maxBytes)
	}

	exePath, args, ext, err := scriptCommand(interpreter)
	if err != nil {
		return "", fmt.Errorf("run_script: %w", err)
	}

	hash := sha256.Sum256([]byte(script))
	scriptHash := hex.EncodeToString(hash[:])
	e.audit.Info().
		Str("command_id", cmd.ID).
		Str("interpreter", interpreter).
		Str("script_sha256", scriptHash).
		Str("script_body", script).
		Msg("run_script: content recorded prior to execution")

	tmpFile, err := writeTempScript(script, ext)
	if err != nil {
		return "", fmt.Errorf("run_script: stage script: %w", err)
	}
	defer os.Remove(tmpFile)

	timeout := e.cfg.ScriptTimeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	outLimit := e.cfg.MaxScriptOutputBytes
	if outLimit <= 0 {
		outLimit = 16 * 1024
	}

	execCmd := exec.CommandContext(runCtx, exePath, append(args, tmpFile)...)
	stdout, err := execCmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("run_script: %w", err)
	}
	execCmd.Stderr = execCmd.Stdout // error output ของสคริปต์เองควรอยู่ใน stream เดียวกับที่ caller เฝ้าดูแบบ live
	hideWindow(execCmd)

	if err := execCmd.Start(); err != nil {
		return "", fmt.Errorf("run_script: start: %w", err)
	}

	// stream ออกไปทีละบรรทัดผ่าน e.sendOutput ทันทีที่ผลิตออกมา — pattern
	// เดียวกับที่ networkDiagnostic ใช้ และด้วยเหตุผลเดียวกัน: การติดตั้งที่
	// ใช้เวลาหลายนาที (download + silent-install ตัวติดตั้งจริง) เคยทำให้
	// operator มองไม่เห็นอะไรเลยว่ามีอะไรเกิดขึ้นหรือไม่จนกว่าทุกอย่างจะจบ
	// ซึ่งอ่านไม่ออกว่าต่างจากคำสั่งที่ค้างยังไง หน้า Software Deploy บน
	// dashboard parse บรรทัด PROGRESS:/STATUS: ที่สคริปต์ที่ generate ขึ้น
	// ส่งออกมาให้กลายเป็น progress bar; บรรทัดอื่น ๆ ก็แสดงเป็น raw output
	// เฉย ๆ
	var full strings.Builder
	truncated := false
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if full.Len() < outLimit {
			full.WriteString(line)
			full.WriteString("\n")
		} else {
			truncated = true
		}
		if e.sendOutput != nil {
			e.sendOutput(cmd.ID, line, false, "")
		}
	}

	runErr := execCmd.Wait()

	output := full.String()
	if truncated {
		output += "\n...[output truncated]"
	}

	e.audit.Info().
		Str("command_id", cmd.ID).
		Str("script_sha256", scriptHash).
		Str("output", output).
		Bool("timed_out", runCtx.Err() == context.DeadlineExceeded).
		Msg("run_script: execution finished")

	var note string
	if runCtx.Err() == context.DeadlineExceeded {
		note = fmt.Sprintf("timed out after %s", timeout)
	} else if runErr != nil {
		note = fmt.Sprintf("exited with error: %v", runErr)
	}
	if e.sendOutput != nil {
		e.sendOutput(cmd.ID, "", true, note)
	}

	if note != "" {
		return "", fmt.Errorf("run_script: %s; output: %s", note, output)
	}
	return fmt.Sprintf("script exited 0; output: %s", output), nil
}

// scriptCommand map interpreter ที่ร้องขอไปเป็น executable, base args, และ
// นามสกุลไฟล์ staged จำกัดไว้เป็นชุดตายตัวต่อแพลตฟอร์ม — ไม่มีการรับ
// interpreter path แบบใด ๆ จากคำสั่งเลย
func scriptCommand(interpreter string) (exePath string, args []string, ext string, err error) {
	switch runtime.GOOS {
	case "windows":
		switch interpreter {
		case "", "powershell":
			return "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"}, ".ps1", nil
		case "cmd":
			return "cmd.exe", []string{"/C"}, ".bat", nil
		default:
			return "", nil, "", fmt.Errorf("unsupported interpreter %q on windows (allowed: powershell, cmd)", interpreter)
		}
	case "darwin", "linux":
		switch interpreter {
		case "", "bash":
			return "/bin/bash", nil, ".sh", nil
		case "sh":
			return "/bin/sh", nil, ".sh", nil
		default:
			return "", nil, "", fmt.Errorf("unsupported interpreter %q on %s (allowed: bash, sh)", interpreter, runtime.GOOS)
		}
	default:
		return "", nil, "", fmt.Errorf("run_script unsupported on GOOS=%s", runtime.GOOS)
	}
}

func writeTempScript(body, ext string) (string, error) {
	f, err := os.CreateTemp("", "optifleet-script-*"+ext)
	if err != nil {
		return "", err
	}
	path := f.Name()
	if _, err := f.WriteString(body); err != nil {
		f.Close()
		os.Remove(path)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	if err := os.Chmod(path, 0o700); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

// networkDiagnosticTools คือ allowlist ตายตัวของ network utility แบบ
// read-only ที่ action นี้รันได้ — ไม่มีวันเป็นชื่อคำสั่งอิสระ และไม่ผ่าน
// shell interpret เลย (exec.Command ด้านล่างรับ target เป็น argv element
// ของตัวเองเสมอ ดังนั้นแม้แต่ target string ที่ตั้งใจสร้างมาให้เป็นอันตราย
// ก็หลุดออกไปเป็นคำสั่งที่สองไม่ได้ แบบที่ shell input ที่ concatenate ด้วย
// string ทำได้)
var networkDiagnosticTools = map[string]struct{}{
	"ping":     {},
	"tracert":  {},
	"nslookup": {},
	"netstat":  {},
}

// targetPattern ตั้งใจให้หลวมพอสำหรับ hostname/IPv4/IPv6 จริง ๆ (จุด, ทวิภาค,
// ขีดกลาง, underscore) แต่ปฏิเสธอะไรก็ตามที่ไม่น่าจะเป็นสิ่งเหล่านั้น นี่เป็น
// แค่ sanity/abuse check ไม่ใช่ security boundary จริง — exec.Command ที่ใช้
// argv element แยกต่างหากป้องกัน shell injection อยู่แล้วไม่ว่า string นี้
// จะมีอะไรอยู่ข้างในก็ตาม
var targetPattern = regexp.MustCompile(`^[a-zA-Z0-9.:_-]{1,253}$`)

// networkDiagnostic รัน network utility แบบ read-only ตัวเดียวที่ตายตัว
// (ping/tracert/nslookup/netstat) แล้ว stream output กลับไปทีละบรรทัดตามที่
// ผลิตออกมาผ่าน e.sendOutput แทนที่จะให้ caller รอจนจบก่อนถึงจะเห็นอะไร —
// tracert ไปยัง host ที่ไปไม่ถึงอาจใช้เวลา 15-20 วินาที และ operator ที่เฝ้า
// ดู dashboard ควรเห็นแต่ละ hop ปรากฏขึ้นตามจริง เหมือนกับรันเองใน terminal
// เป็น read-only โดยโครงสร้าง: ไม่มีอะไรตรงนี้เปลี่ยนสถานะเครื่องได้ ดังนั้น
// — ต่างจาก kill_process/restart_host — ไม่จำเป็นต้องมี safeguard ของ
// destructive action เลย
func (e *Executor) networkDiagnostic(ctx context.Context, commandID string, params map[string]string) (string, error) {
	tool := strings.ToLower(strings.TrimSpace(params["tool"]))
	if _, ok := networkDiagnosticTools[tool]; !ok {
		return "", fmt.Errorf("network_diagnostic: unsupported tool %q (allowed: ping, tracert, nslookup, netstat)", tool)
	}

	target := strings.TrimSpace(params["target"])
	if tool != "netstat" {
		if target == "" {
			return "", fmt.Errorf("network_diagnostic: %s requires a target hostname/IP", tool)
		}
		if !targetPattern.MatchString(target) {
			return "", fmt.Errorf("network_diagnostic: target %q doesn't look like a valid hostname/IP", target)
		}
	}

	exePath, args, timeout, err := networkDiagnosticCommand(tool, target)
	if err != nil {
		return "", fmt.Errorf("network_diagnostic: %w", err)
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	execCmd := exec.CommandContext(runCtx, exePath, args...)
	hideWindow(execCmd)
	stdout, err := execCmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("network_diagnostic: %w", err)
	}
	execCmd.Stderr = execCmd.Stdout // ping/nslookup รายงาน failure จริงทาง stderr - เก็บไว้ใน stream เดียวกัน

	if err := execCmd.Start(); err != nil {
		return "", fmt.Errorf("network_diagnostic: start %s: %w", tool, err)
	}

	var full strings.Builder
	lineCount := 0
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		full.WriteString(line)
		full.WriteString("\n")
		lineCount++
		if e.sendOutput != nil {
			e.sendOutput(commandID, line, false, "")
		}
	}

	waitErr := execCmd.Wait()

	// exit code ที่ไม่ใช่ 0 เป็นเรื่องปกติที่คาดไว้อยู่แล้วสำหรับ tool พวกนี้
	// (เช่น ping ไปยัง host ที่ไปไม่ถึงจะ exit ไม่เป็น 0) — แค่บันทึกไว้ใน
	// result เท่านั้น ไม่ได้ถือว่าคำสั่งนี้เองล้มเหลว
	var note string
	if runCtx.Err() == context.DeadlineExceeded {
		note = fmt.Sprintf("timed out after %s", timeout)
	} else if waitErr != nil {
		note = fmt.Sprintf("%s exited with: %v", tool, waitErr)
	}
	if e.sendOutput != nil {
		e.sendOutput(commandID, "", true, note)
	}

	result := strings.TrimRight(full.String(), "\n")
	if note != "" {
		result += "\n(" + note + ")"
	}
	if result == "" {
		result = fmt.Sprintf("%s produced no output", tool)
	}
	return result, nil
}

// networkDiagnosticCommand map tool ที่ร้องขอไปเป็น binary ของ OS, args,
// และ timeout ตายตัว — จำกัดเป็นชุดตายตัวต่อแพลตฟอร์ม pattern เดียวกับ
// scriptCommand ด้านบน Windows เป็น path ที่ทดสอบแล้ว (เป้าหมายการ deploy
// จริงของโปรเจกต์นี้); ฝั่ง Unix ใส่ไว้เพื่อให้ build ผ่านครบทุกแพลตฟอร์ม
// แต่ยังไม่เคยทดสอบบนเครื่องจริง
func networkDiagnosticCommand(tool, target string) (exePath string, args []string, timeout time.Duration, err error) {
	switch runtime.GOOS {
	case "windows":
		switch tool {
		case "ping":
			return "ping.exe", []string{"-n", "4", "-w", "2000", target}, 15 * time.Second, nil
		case "tracert":
			return "tracert.exe", []string{"-d", "-w", "1000", "-h", "20", target}, 35 * time.Second, nil
		case "nslookup":
			return "nslookup.exe", []string{target}, 10 * time.Second, nil
		case "netstat":
			return "netstat.exe", []string{"-ano"}, 10 * time.Second, nil
		}
	case "darwin", "linux":
		switch tool {
		case "ping":
			return "ping", []string{"-c", "4", target}, 15 * time.Second, nil
		case "tracert":
			return "traceroute", []string{"-n", "-m", "20", "-w", "1", target}, 35 * time.Second, nil
		case "nslookup":
			return "nslookup", []string{target}, 10 * time.Second, nil
		case "netstat":
			return "netstat", []string{"-an"}, 10 * time.Second, nil
		}
	}
	return "", nil, 0, fmt.Errorf("no %s command for GOOS=%s", tool, runtime.GOOS)
}
