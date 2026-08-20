// เป็นตัวขับคำขอ "query_info" จาก AI command console — คำถามอ่านอย่างเดียว
// เกี่ยวกับอุปกรณ์หนึ่งเครื่อง (IP address, เวอร์ชัน OS, uptime, พื้นที่ดิสก์,
// อะไรกำลังรันอยู่, มีอะไรเชื่อมต่ออยู่) ตอบจาก telemetry snapshot ล่าสุดที่มี
// อยู่แล้วในระบบ ไม่มีการ round trip ไปหา agent เลย ดู doc comment ของ
// PARSEABLE_ACTIONS ใน schema.ts และ short-circuit ใน routes.ts ว่าทำไมโมดูล
// นี้ถึงข้าม guardrail ไปได้ทั้งหมด — เพราะมันไม่ dispatch อะไรเลย จึงไม่มีอะไร
// ให้ guardrail ต้องอนุมัติ
//
// สิ่งเดียวที่สำคัญตรงนี้แต่ไม่สำคัญสำหรับ action parser คือ ห้ามกุข้อมูลขึ้นมาเอง
// เด็ดขาด prompt จะส่ง JSON snapshot จริงให้โมเดล และบังคับให้บอกตรง ๆ
// (answerable=false) แทนที่จะเดา เมื่อข้อมูลไม่ครอบคลุมสิ่งที่ถูกถาม (เช่น
// รายชื่อซอฟต์แวร์ที่ติดตั้ง ซึ่งระบบนี้ไม่ได้เก็บข้อมูลส่วนนั้นเลย)
import OpenAI from "openai";
import { z } from "zod";
import { log } from "../logger.js";
import type { TelemetrySnapshot } from "../protocol.js";

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "llama-3.3-70b-versatile";

// ส่งเข้า prompt แค่ 20 process แรกที่ใช้ CPU สูงสุด (เรียงลำดับมาจากฝั่ง agent
// แล้ว) แม้ snapshot จะมี process list เต็มของอุปกรณ์ (300+ รายการบนเครื่อง
// ที่ทำงานหนัก) ก็ตาม — เพียงพอต่อการตอบ "อะไรกำลังรันอยู่/ใช้ CPU" โดยไม่ทำให้
// ทุกคำถามกลายเป็น prompt ยาวหลายร้อยบรรทัด
const MAX_PROCESSES_IN_PROMPT = 20;

const QueryAnswerSchema = z.object({
  answerable: z.boolean(),
  answer: z.string(),
});
export type QueryAnswer = z.infer<typeof QueryAnswerSchema>;

const ANSWER_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "answer_device_query",
    description:
      "Answer an IT operator's read-only question about one device, using ONLY the telemetry data provided " +
      "in the message — never invent a value that isn't in the data.",
    parameters: {
      type: "object",
      properties: {
        answerable: {
          type: "boolean",
          description: "True only if the provided data actually contains what's needed to answer the question.",
        },
        answer: {
          type: "string",
          description:
            "Answer the question at the level of detail it actually asked for. A simple question ('what's the " +
            "IP address') gets one or two plain sentences. A request for a detailed dump (e.g. 'ipconfig /all', " +
            "'show network config', 'full network details') gets the full breakdown instead — every adapter " +
            "with its description, MAC address, IP address(es), subnet mask, DHCP status/server/lease dates, " +
            "gateway, and DNS servers, formatted clearly (one adapter per paragraph or list item). Never " +
            "collapse a request for full detail down to a single summary line just because a shorter answer " +
            "would also be technically true. If answerable is false, say what this device doesn't currently " +
            "report rather than guessing.",
        },
      },
      required: ["answerable", "answer"],
      additionalProperties: false,
    },
  },
};

export interface QueryAnswerInput {
  deviceId: string;
  question: string;
  // สิ่งที่ action parser (การเรียก classify แยกต่างหากอีกครั้งใน
  // actionParser.ts) วิเคราะห์ไว้แล้วว่าผู้ควบคุมต้องการรู้อะไร เช่น
  // "ip address" ทดสอบจริงแล้วพบว่าถ้าให้ call นี้ตีความคำถามดิบเองใหม่ทั้งหมด
  // จะแม่นยำน้อยกว่า classifier อย่างเห็นได้ชัด — ประโยคภาษาไทยสั้น ๆ
  // ("ตรวจหาไอพี เครื่องนี้") ถูก classify ถูกต้องว่าถามเรื่อง IP address แต่พอ
  // ให้ call นี้ได้แค่ข้อความดิบอย่างเดียวกลับตอบราวกับว่าถามเรื่อง CPU/RAM แทน
  // การส่งผลสรุปของ classifier มาเป็น hint แก้ปัญหานี้ได้ โดยไม่ต้องให้ call นี้
  // เก่งเรื่องตีความแบบเปิดกว้างเท่า classifier เฉพาะทางที่ทำหน้าที่นั้นอยู่แล้ว
  topicHint: string;
  snapshot: TelemetrySnapshot;
}

export async function answerDeviceQuery(input: QueryAnswerInput): Promise<QueryAnswer> {
  const s = input.snapshot;
  const data = {
    hostname: s.hostname,
    ip_addresses: s.ip_addresses,
    network_interfaces: s.network_interfaces,
    os: s.os,
    os_version: s.os_version,
    uptime_seconds: s.uptime_seconds,
    telemetry_age_seconds: Math.round((Date.now() - new Date(s.timestamp).getTime()) / 1000),
    cpu_percent: s.cpu_percent,
    mem_percent: s.mem_percent,
    mem_used_mb: Math.round(s.mem_used_mb),
    mem_total_mb: Math.round(s.mem_total_mb),
    disks: s.disks,
    connected_devices: s.connected_devices,
    local_user_accounts: s.local_users,
    currently_logged_in_user: s.current_user || null,
    top_processes_by_cpu: s.top_processes.slice(0, MAX_PROCESSES_IN_PROMPT),
    total_process_count: s.top_processes.length,
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 900,
    tools: [ANSWER_TOOL],
    tool_choice: { type: "function", function: { name: "answer_device_query" } },
    messages: [
      {
        role: "system",
        content:
          "You answer an IT operator's question about ONE device using only the JSON telemetry data given in " +
          "the user message. Never invent a value not present in the data — if the question needs something " +
          "this data doesn't cover (e.g. installed software list, event log history, a full process list beyond " +
          "what's given), set answerable=false and say so plainly instead of guessing. " +
          "The question may be asked in any language, including Thai — you understand it fine; answer in the " +
          "same language the question was asked in. answerable=false means 'the telemetry data doesn't contain " +
          "this information', never 'I don't understand the question's language' — you do.",
      },
      {
        role: "user",
        content:
          `Device: ${input.deviceId}\nQuestion (as the operator wrote it): ${input.question}\n` +
          `What the operator wants to know (already classified — trust this over your own re-reading of the ` +
          `question above if they seem to disagree): ${input.topicHint}\n\n` +
          `Current telemetry data (JSON):\n${JSON.stringify(data)}`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message.tool_calls?.find(
    (c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
      c.type === "function" && c.function.name === "answer_device_query",
  );
  if (!toolCall) {
    throw new Error(`query answerer: expected an answer_device_query tool call, got finish_reason=${response.choices[0]?.finish_reason}`);
  }

  const rawArgs: unknown = JSON.parse(toolCall.function.arguments);
  const result = QueryAnswerSchema.parse(rawArgs);
  log.info({ deviceId: input.deviceId, question: input.question, result }, "query answerer: answer generated");
  return result;
}
