// แปลงคำสั่งภาษาธรรมชาติของผู้ควบคุม dashboard ให้เป็น ParsedIntent
// ผ่าน Groq's OpenAI-compatible Chat Completions API โดยบังคับให้โมเดล
// ใช้ tool call เท่านั้น ทำให้โมเดลตอบกลับได้เฉพาะรูปแบบตายตัวใน schema.ts
// เท่านั้น — ไม่มีทางตอบเป็นข้อความอิสระ หรือสั่งคำสั่งที่ agent ไม่รองรับ
//
// ขอบเขตความน่าเชื่อถือ: ผลลัพธ์จากโมดูลนี้ "ไม่ถูกเชื่อถือ" ว่าเป็นการ
// อนุมัติสิทธิ์ ถือเป็นแค่การตีความ intent ของผู้ใช้ เหมือน input อื่น ๆ
// ทั่วไป — security/guardrail.ts จะตรวจสอบซ้ำทุกอย่าง (การเช็ค allowlist,
// การ resolve scope เทียบกับ config ในเครื่อง, การสแกน blacklist) แยกต่างหาก
// จากสิ่งที่โมเดลตอบกลับมา ถ้า LLM ถูกโจมตี ถูกหลอกด้วย prompt injection
// ในข้อความ input หรือแค่ตอบผิด guardrail คือส่วนที่ตัดสินใจจริงว่าคำสั่ง
// จะไปถึง agent หรือไม่
import OpenAI from "openai";
import { log } from "../logger.js";
import { EMIT_FLEET_COMMAND_TOOL, ParsedIntentSchema, type ParsedIntent } from "./schema.js";
import { EMIT_ADMIN_COMMAND_TOOL, AdminParsedIntentSchema, type AdminParsedIntent } from "./adminSchema.js";
import { EMIT_ERP_COMMAND_TOOL, ErpParsedIntentSchema, type ErpParsedIntent } from "./erpSchema.js";

// Groq's Chat Completions API รองรับรูปแบบเดียวกับ OpenAI ดังนั้น OpenAI SDK
// จึงคุยกับ Groq ได้ตรง ๆ แค่ override baseURL — ดู server/README.md ว่าทำไม
// การสลับนี้จึงใช้แทน Claude API integration เดิมได้แบบไม่ต้องแก้โค้ดส่วนอื่น
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "llama-3.3-70b-versatile";

export class ParseRefusedError extends Error {
  constructor(public readonly category: string | null) {
    super(`request declined by model safety classifiers (category: ${category ?? "none"})`);
    this.name = "ParseRefusedError";
  }
}

// ต่างจาก ParseRefusedError: กรณีนี้โมเดลไม่ได้ปฏิเสธเพราะเหตุผลด้านความปลอดภัย
// แต่พยายามตอบแล้วสร้าง function call ที่ strict-mode parser ของ Groq เอง
// ตรวจสอบไม่ผ่าน (ปรากฏเป็น API ตอบ HTTP 400 code "tool_use_failed" แทนที่จะ
// เป็น completion ปกติ) — เป็นช่องโหว่ด้านความน่าเชื่อถือของโมเดลฟรีที่โปรเจกต์
// นี้ใช้จริง ๆ ไม่ใช่บั๊กจาก request ฝั่งโค้ดเรา เดิมทีไม่ได้ดักไว้ ทำให้ error
// นี้หลุดไปเป็น 500 ทั่วไปของ Express ตรง ๆ
export class ParseFailedError extends Error {
  constructor(cause: unknown) {
    super("the model failed to produce a valid tool call for this request");
    this.name = "ParseFailedError";
    this.cause = cause;
  }
}

// Groq's on-demand tier จำกัด tokens-per-day ต่อ organization (ไม่ใช่ต่อ user)
// — แค่ traffic จากการเทสต์ของโปรเจกต์นี้เองก็ใช้โควตาหมดก่อนหมดวันได้ เดิมที
// ไม่ได้ดักไว้ ทำให้หลุดไปเป็น 500 ทั่วไปของ Express โดยไม่บอกเลยว่าเกิดอะไรขึ้น
// หรือจะกลับมาใช้ได้เมื่อไหร่ retryAfterSeconds ช่วยให้ฝั่งเรียกใช้แสดงข้อความ
// "ลองใหม่อีกครั้งในอีก N นาที" ที่แม่นยำแทน
export class RateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super("the language model's daily request quota is exhausted");
    this.name = "RateLimitedError";
  }
}

// body ของ 429 จาก Groq มีข้อความอ่านง่ายแบบ "...try again in 10m41.088s..."
// แต่ error shape นี้ไม่มี field retry-after ที่อ่านด้วยโค้ดได้ตรง ๆ — จึง parse
// แบบระวังไว้ก่อน เพราะถ้าฝั่ง Groq เปลี่ยนถ้อยคำ ควร fallback เป็น "ไม่มีค่า
// ประมาณการ" แทนที่จะ throw error
function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/try again in (?:(\d+)m)?([\d.]+)s/);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
  return Math.ceil(minutes * 60 + seconds);
}

function buildSystemPrompt(knownScopes: string[], presetScope?: string): string {
  return [
    "You translate an IT operator's natural-language request into a single structured command by calling exactly",
    "one of the three tools available to you. Use emit_admin_command when the request is about an ORGANIZATION",
    "(creating a new customer, suspending/reactivating/deleting one) or a USER ACCOUNT (creating/deleting/",
    "suspending/reactivating a login), or about obtaining an agent installer — none of these target a specific",
    "device. Use emit_erp_command when the request is about a VENDOR/SUPPLIER, a PURCHASE ORDER, scheduled or",
    "completed MAINTENANCE on an asset, or HANDING OVER an asset to an employee — also none of these target a",
    "specific device. Use emit_fleet_command for everything else below, which is about acting on or asking about a",
    "specific device or device group.",
    "",
    "You translate an IT operator's natural-language request into a single structured fleet-management command.",
    "",
    "`scope` is WHERE the action runs: a device hostname or a device-group name — never anything else.",
    "`target` is WHAT within that device the action applies to: a process name/PID, a directory, or an app name.",
    "A device/host name (anything that looks like a machine name, e.g. 'DESKTOP-1NH0P21', 'Admin-01',",
    "'accounting-group') always goes in `scope`, even if it's the only noun in the request. Never put a",
    "device/host name in `target`, and never leave `scope` empty if the request names a device or group anywhere.",
    "",
    ...(presetScope
      ? [
          `The operator has already selected "${presetScope}" as the target device using the dashboard's own device`,
          "selector — this exact scope will be used no matter what you put in `scope`, so you do not need the",
          "request's text to name a device at all. Focus entirely on classifying WHAT action the request wants.",
          "A bare imperative with no object at all (e.g. just 'restart', 'clean it up', 'reboot') means the",
          "already-selected device itself, not some unnamed program — classify 'restart' alone this way as",
          "action=restart_host, target='' (not unsupported: the device is already known, so nothing is missing).",
          "Only fall back to a specific target (a program/process name) when the request text actually names one",
          "(e.g. 'restart chrome' still means action=kill_process, target='chrome', even with scope preset).",
          "",
        ]
      : []),
    "Examples:",
    "- 'restart DESKTOP-1NH0P21' -> action=restart_host, scope='DESKTOP-1NH0P21', target=''",
    "  (the thing named to restart IS the device itself — whole-machine reboot, comes back on by itself)",
    "- 'shut down DESKTOP-1NH0P21' / 'turn off Admin-01' / 'ปิดเครื่อง DESKTOP-1NH0P21' / '关闭 DESKTOP-1NH0P21' / '关机 Admin-01' -> action=shutdown_host, scope='DESKTOP-1NH0P21' (or 'Admin-01'), target=''",
    "  (shutdown/turn off/power off/ปิด/关机/关闭电脑 is shutdown_host, NOT restart_host — the machine stays off",
    "  afterward, it does not turn itself back on the way a restart does. 'restart'/'reboot'/'รีสตาร์ท'/'重启' ->",
    "  restart_host; 'shut down'/'turn off'/'power off'/'ปิด'/'ปิดเครื่อง'/'关机'/'关闭电脑' -> shutdown_host.",
    "  These are not interchangeable even though both act on the whole device — pick the one that matches which",
    "  word the operator actually used, in whatever language they used it in)",
    "- '重启 DESKTOP-1NH0P21' -> action=restart_host, scope='DESKTOP-1NH0P21', target=''",
    "- 'clean temp files on admin-01' / '清理 admin-01 上的临时文件' -> action=clean_temp, scope='admin-01', target=''",
    "- 'kill chrome.exe on Admin-01' / '关闭 Admin-01 上的 chrome.exe 进程' -> action=kill_process, scope='Admin-01', target='chrome.exe'",
    "- 'restart the WeCom app on DESKTOP-1NH0P21' / '重启 DESKTOP-1NH0P21 上的企业微信' -> action=kill_process, scope='DESKTOP-1NH0P21', target='WeCom'",
    "  (the thing named to restart is a PROGRAM, not the device — this is never restart_host, no matter how",
    "  the sentence is worded or what language it's in, because restart_host reboots the whole machine and",
    "  closes every other program too, which is not what 'restart this one app'/'重启...企业微信' means. 企业微信",
    "  (WeCom/WXWork) and 微信 (WeChat) are both just program names here, same as 'chrome.exe' or 'WeCom' in",
    "  English — never confuse the app name for a device/host name)",
    "- 'what's the IP address of DESKTOP-1NH0P21' / 'DESKTOP-1NH0P21 的 IP 地址是多少' -> action=query_info, scope='DESKTOP-1NH0P21', target='ip address'",
    "- 'ipconfig /all on DESKTOP-1NH0P21' -> action=query_info, scope='DESKTOP-1NH0P21', target='detailed network configuration (ipconfig /all): every adapter's MAC, subnet, gateway, DNS, and DHCP lease, not just the plain IP'",
    "  (a request that names a specific detailed command/tool (ipconfig /all, ifconfig, systeminfo, ...) wants the",
    "  FULL breakdown that command would show, not a one-line summary — say so explicitly in `target` so the",
    "  answering step doesn't collapse it down to just an IP address)",
    "- 'how much disk space is left on admin-01' -> action=query_info, scope='admin-01', target='disk space'",
    "  (a QUESTION about current state is query_info, never one of the change-something actions — asking",
    "  'what's running' or 'how long has it been up' doesn't restart, kill, or clean anything)",
    "- 'ตรวจหาไอพี เครื่องนี้ DESKTOP-1NH0P21' -> action=query_info, scope='DESKTOP-1NH0P21', target='ip address'",
    "- 'ไอพีของเครื่อง admin-01 คืออะไร' -> action=query_info, scope='admin-01', target='ip address'",
    "- 'เครื่อง DESKTOP-1NH0P21 เปิดมานานแค่ไหนแล้ว' -> action=query_info, scope='DESKTOP-1NH0P21', target='uptime'",
    "  (query_info applies the same way regardless of language — a Thai request asking about IP/uptime/disk/",
    "  what's running is query_info exactly like its English equivalent, never treated as unsupported just",
    "  because it's phrased as an imperative like 'ตรวจหา' (find/check) rather than a literal question)",
    "- 'admin-01 还剩多少硬盘空间' -> action=query_info, scope='admin-01', target='disk space'",
    "- 'DESKTOP-1NH0P21 开机多久了' / 'DESKTOP-1NH0P21 运行了多长时间' -> action=query_info, scope='DESKTOP-1NH0P21', target='uptime'",
    "- 'DESKTOP-1NH0P21 上正在运行哪些程序' -> action=query_info, scope='DESKTOP-1NH0P21', target='running processes'",
    "  (query_info applies the same way in Chinese too — 多少/几/是什么 style questions about IP/uptime/disk/",
    "  what's running are query_info exactly like their English or Thai equivalent, never treated as unsupported",
    "  just because they're phrased as an imperative like 查一下/检查 (check/look up) rather than a literal question)",
    "- 'ping google.com on DESKTOP-1NH0P21' -> action=ping, scope='DESKTOP-1NH0P21', target='google.com'",
    "- 'tracert 8.8.8.8' -> action=tracert, target='8.8.8.8' (scope from whatever device is already selected)",
    "- 'nslookup example.com' -> action=nslookup, target='example.com'",
    "- 'netstat' / 'show me the open connections' -> action=netstat, target=''",
    "  (these four are literal network diagnostic tools — recognize them the same way regardless of whether",
    "  the operator typed the exact command name or described what it does in plain words, and regardless of",
    "  language: 'ping google.com หน่อย' / '帮我 ping 一下 google.com' is still action=ping, target='google.com';",
    "  '追踪一下到 8.8.8.8 的路由' is tracert; '查一下 example.com 的域名解析' is nslookup; '看看现在的网络连接' is netstat)",
    "",
    "Known device/group scopes you may reference in `scope` (case-insensitive):",
    knownScopes.map((s) => `- ${s}`).join("\n"),
    "",
    "If the request names a scope not in this list, still extract it as written into `scope` — the caller-side",
    "system will reject unknown scopes rather than you guessing a match. Do not substitute a similar-sounding",
    "known scope, and do not move an unrecognized device name into `target` instead.",
    "",
    "Only set confirm=true if the operator's own words are an explicit, unambiguous instruction to proceed",
    "with a destructive action (e.g. 'restart it now', 'yes uninstall it') — not merely mentioning the topic.",
  ].join("\n");
}

export type ParsedCommand = { kind: "device"; parsed: ParsedIntent } | { kind: "admin"; parsed: AdminParsedIntent } | { kind: "erp"; parsed: ErpParsedIntent };

export async function parseNaturalLanguageCommand(
  text: string,
  knownScopes: string[],
  presetScope?: string,
): Promise<ParsedCommand> {
  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [EMIT_FLEET_COMMAND_TOOL, EMIT_ADMIN_COMMAND_TOOL, EMIT_ERP_COMMAND_TOOL],
      // ใช้ "required" (ไม่ใช่บังคับ tool เดียว) — ให้โมเดลเลือกเองว่า tool ไหน
      // ใน 3 ตัวที่ลงทะเบียนไว้ตรงกับคำขอ ดูหมายเหตุการ routing ใน
      // buildSystemPrompt ด้านบน
      tool_choice: "required",
      messages: [
        { role: "system", content: buildSystemPrompt(knownScopes, presetScope) },
        { role: "user", content: text },
      ],
    });
  } catch (err) {
    if (err instanceof OpenAI.APIError && (err as { code?: string }).code === "tool_use_failed") {
      log.warn({ err }, "llm: model produced an invalid tool call (tool_use_failed)");
      throw new ParseFailedError(err);
    }
    if (err instanceof OpenAI.APIError && err.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(err.message ?? "");
      log.warn({ err, retryAfterSeconds }, "llm: rate limited by provider");
      throw new RateLimitedError(retryAfterSeconds);
    }
    throw err;
  }

  const choice = response.choices[0];
  if (choice?.finish_reason === "content_filter") {
    log.warn("llm: parse request refused by content filter");
    throw new ParseRefusedError(null);
  }

  const toolCall = choice?.message.tool_calls?.find(
    (c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
      c.type === "function" && (c.function.name === "emit_fleet_command" || c.function.name === "emit_admin_command" || c.function.name === "emit_erp_command"),
  );
  if (!toolCall) {
    throw new Error(`llm: expected an emit_fleet_command, emit_admin_command, or emit_erp_command tool call, got finish_reason=${choice?.finish_reason}`);
  }

  // ป้องกันซ้อนอีกชั้น: re-validate ด้วย zod แทนที่จะเชื่อ JSON output ของโมเดล
  // ตรง ๆ — โมเดลยังมีโอกาสตอบ field ที่ผิดรูปแบบหรือเกินมาได้ ไม่ว่า schema
  // จะขอไว้แบบไหนก็ตาม
  const rawArgs: unknown = JSON.parse(toolCall.function.arguments);

  if (toolCall.function.name === "emit_admin_command") {
    const parsed = AdminParsedIntentSchema.parse(rawArgs);
    log.info({ parsed }, "llm: parsed natural-language admin command");
    return { kind: "admin", parsed };
  }

  if (toolCall.function.name === "emit_erp_command") {
    const parsed = ErpParsedIntentSchema.parse(rawArgs);
    log.info({ parsed }, "llm: parsed natural-language erp command");
    return { kind: "erp", parsed };
  }

  const parsed = ParsedIntentSchema.parse(rawArgs);
  log.info({ parsed }, "llm: parsed natural-language command");
  return { kind: "device", parsed };
}
