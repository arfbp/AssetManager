// โครงสร้างตายตัวที่คำสั่งภาษาธรรมชาติทุกคำสั่งต้อง resolve ไปหา LLM จะกรอก
// แค่ 5 field นี้ผ่าน forced tool use เท่านั้น — ไม่มีทางส่ง JSON แบบอิสระออกมา
// และไม่มีทางเขียนเนื้อหาที่รันได้เอง (ดู uninstallTemplates.ts ว่าทำไม
// "uninstall_software" ถึงไม่ให้โมเดลเขียนคำสั่งถอนการติดตั้งเอง)
import { z } from "zod";
import type OpenAI from "openai";

// "uninstall_software" กับ "unsupported" ไม่ใช่ agent action จริง ๆ — agent
// (internal/executor) รองรับแค่ kill_process / clean_temp / restart_host /
// run_script เท่านั้น guardrail จะแปลง uninstall_software ให้กลายเป็น
// run_script template ที่ผ่านการตรวจสอบแล้ว (security/guardrail.ts) และจะ
// ปฏิเสธ "unsupported" เสมอพร้อมข้อความแจ้งชัดเจนกลับไปหาผู้เรียก
// "query_info" ก็ไม่ใช่ agent action เช่นกัน — ไม่มีการ dispatch อะไรไปหา
// อุปกรณ์เลย เป็นแค่คำถามอ่านอย่างเดียวเกี่ยวกับสถานะปัจจุบันของอุปกรณ์
// (IP address, เวอร์ชัน OS, uptime, พื้นที่ดิสก์, อะไรกำลังรันอยู่, มีอะไร
// เชื่อมต่ออยู่) ที่ server ตอบได้จาก telemetry snapshot ล่าสุดที่มีอยู่แล้ว
// โดยไม่ต้อง round trip ไปหา agent ดู src/llm/queryAnswerer.ts และ
// short-circuit ใน routes.ts ก่อนถึง guardrail — มันถูกดักไว้ก่อนหน้านั้นใน
// pipeline เพราะหน้าที่ของ evaluateParsedIntent คือตัดสินใจว่าจะ *dispatch*
// อะไรหรือไม่ ซึ่งการอ่านอย่างเดียวไม่จำเป็นต้องผ่านขั้นตอนนั้นเลย
// "ping"/"tracert"/"nslookup"/"netstat" เหมือนกับ uninstall_software คือไม่ใช่
// agent action ระดับ wire — agent จะได้รับแค่ action เดียวคือ
// "network_diagnostic" พร้อม field params.tool เท่านั้น (ดู networkDiagnostic
// ใน internal/executor/executor.go) การแยกเป็น 4 action ต่างหากในฝั่ง
// classifier แทนที่จะใช้ "network_diagnostic" ตัวเดียว + sub-field tool
// ช่วยไม่ให้โครงสร้างตายตัว 5 field ของ ParsedIntent ต้องขยายเพิ่ม และ target
// สำหรับ action พวกนี้ก็คือ "host ที่จะชี้ tool ไปหา" แบบเดียวกับที่
// kill_process ใช้ field เดียวกันนี้เป็น "process ที่จะชี้ action ไปหา"
// resolveAction ใน security/guardrail.ts จะแปลงเป็น wire-level action
// เอง รูปแบบเดียวกับ uninstall_software -> run_script
export const PARSEABLE_ACTIONS = [
  "kill_process",
  "clean_temp",
  "restart_host",
  "shutdown_host",
  "run_script",
  "uninstall_software",
  "query_info",
  "ping",
  "tracert",
  "nslookup",
  "netstat",
  "unsupported",
] as const;

export const ParsedIntentSchema = z.object({
  action: z.enum(PARSEABLE_ACTIONS),
  target: z
    .string()
    .describe("Process name/PID, directory, or application name the action applies to. Empty string if not applicable."),
  scope: z
    .string()
    .describe("The device hostname or device-group key the caller named, e.g. 'Admin-01' or 'accounting-group'."),
  confirm: z
    .boolean()
    .describe("True only if the caller's own wording explicitly confirms a destructive action (restart, uninstall) — not inferred from context."),
  reasoning: z
    .string()
    .describe("One short sentence on how the text maps to this action. For audit/log visibility only — never used to decide execution."),
});
export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

export const EMIT_FLEET_COMMAND_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "emit_fleet_command",
    description:
      "Convert an IT operator's natural-language request into a structured fleet management command. " +
      "You are extracting intent, not authoring anything executable — 'target' and 'scope' are plain " +
      "identifiers (a process name, a directory alias, an app name, a device or group name), never a " +
      "script, shell command, or file path outside what the operator explicitly named. " +
      "If the request does not clearly map to one of the listed actions, or names a target/scope you cannot " +
      "identify with confidence, use action='unsupported' rather than guessing.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: PARSEABLE_ACTIONS as unknown as string[],
          description:
            "kill_process: stop/close/restart ONE running program or process — this is what 'restart <app name>', " +
            "'close <app name>', or 'restart the X program' means, even though the word 'restart' appears in the " +
            "request. clean_temp: clear temp/cache files. " +
            "restart_host: REBOOT the ENTIRE machine/OS — every running program closes, then the machine turns " +
            "itself back on and comes back online by itself. Use this for 'restart <device>', 'reboot this " +
            "computer', 'รีสตาร์ทเครื่อง'. shutdown_host: POWER OFF the entire machine and leave it off — " +
            "distinct from restart_host, since the machine does NOT turn itself back on afterward (someone has to " +
            "physically power it back on, or use a separate remote-power-on mechanism this system doesn't have). " +
            "Use shutdown_host only for requests that clearly mean power-off/turn-off, never 'reboot' or " +
            "'restart' — 'shut down Admin-01', 'turn off this computer', 'ปิดเครื่อง', 'ปิดคอม' all mean " +
            "shutdown_host, NOT restart_host, even though both are whole-machine actions. If a request says " +
            "'restart'/'reboot'/'รีสตาร์ท' use restart_host; if it says 'shut down'/'turn off'/'power off'/'ปิด' " +
            "use shutdown_host — do not treat these as interchangeable synonyms for the same action. " +
            "For both: only use these when the operator names the device/machine itself as what should " +
            "restart/shut down, never when they name a specific program/app/process — 'restart Chrome' or " +
            "'close the WeCom app' is kill_process with target='Chrome'/'WeCom', not restart_host or " +
            "shutdown_host, even if a device name is also mentioned in the sentence. " +
            "run_script: run an admin-authored script (rare — only when " +
            "the operator is clearly asking to run a specific script/command, not for any of the other actions). " +
            "uninstall_software: remove an installed application. " +
            "query_info: the operator is ASKING a read-only question, not asking to change anything — e.g. " +
            "'what's this machine's IP', 'how much disk space is left', 'how long has it been up', 'what OS " +
            "version is this', 'what's connected to it', 'what's running on it', 'what user accounts exist on " +
            "this machine', 'net user', 'who are the local users', 'is there an admin account'. Note the " +
            "distinction between 'what accounts EXIST on this machine' (target='local user accounts') and " +
            "'who is USING/logged into this machine right now' (target='current logged-in user') — these are " +
            "different questions answered from different data, don't conflate them. Put a short description of " +
            "what they want to know in `target` (e.g. 'ip address', 'disk space', 'uptime', 'local user " +
            "accounts', 'current logged-in user'). " +
            "ping: the operator wants to test connectivity to a specific host/website with the ping tool — " +
            "put the hostname/IP in `target` (e.g. 'ping google.com' -> target='google.com'). " +
            "tracert: the operator wants to trace the network route/path to a host (tracert, traceroute) — " +
            "put the hostname/IP in `target`. " +
            "nslookup: the operator wants to resolve a domain name to an IP address (or vice versa) — put the " +
            "hostname/IP in `target`. " +
            "netstat: the operator wants to see the device's current network connections/open ports — target " +
            "is always empty for this one, there's nothing to name. " +
            "unsupported: none of the above apply.",
        },
        target: { type: "string" },
        scope: { type: "string" },
        confirm: { type: "boolean" },
        reasoning: { type: "string" },
      },
      required: ["action", "target", "scope", "confirm", "reasoning"],
      additionalProperties: false,
    },
  },
};
