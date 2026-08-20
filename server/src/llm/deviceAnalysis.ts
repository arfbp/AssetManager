// เป็นตัวขับปุ่ม "ควรเปลี่ยนเครื่องนี้ไหม?" บน dashboard ทำหน้าที่ให้คำแนะนำ
// เท่านั้น จุดยืนความน่าเชื่อถือเดียวกับ remediationAdvisor.ts — โมดูลนี้ไม่มี
// ทางยื่นคำขอซื้อหรือลงมือทำอะไรเอง แค่ให้เหตุผลประกอบแก่ผู้ควบคุม IT
// เพื่อนำไปเสนอผู้อนุมัติงบฮาร์ดแวร์
//
// ระบบนี้ไม่มี field วันที่ซื้อ/ประกันเลย ดังนั้นโมเดลจึงต้องให้เหตุผลจากสิ่งที่
// telemetry แสดงจริง ๆ คือ แรงกดดันด้านทรัพยากรที่ต่อเนื่อง (เครื่องที่ CPU/RAM/
// disk สูงติดต่อกันเป็นภาระต่อ productivity ของผู้ใช้จริง) และความน่าเชื่อถือ
// (ความถี่ที่โปรแกรมค้าง) — ไม่ใช่การประมาณอายุเครื่องซึ่งโมเดลจะต้องเดาเอาเอง
import OpenAI from "openai";
import { z } from "zod";
import { log } from "../logger.js";

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "llama-3.3-70b-versatile";

const AnalysisSchema = z.object({
  verdict: z.enum(["recommend_replacement", "monitor", "no_action_needed"]),
  reasoning: z.string(),
  note: z.string(),
});
export type DeviceAnalysis = z.infer<typeof AnalysisSchema>;

const ANALYZE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "analyze_device_for_replacement",
    description:
      "Given a device's recent resource-usage stats and reliability incidents, advise an IT operator on whether " +
      "the employee using it would benefit from a hardware refresh. Advisory only — never state or imply a " +
      "purchase has been requested or approved.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["recommend_replacement", "monitor", "no_action_needed"] },
        reasoning: { type: "string", description: "Two or three sentences grounded in the specific numbers given, written for a non-technical manager approving a purchase." },
        note: { type: "string", description: "One sentence caveat — e.g. data window is short, or this is usage-based only and doesn't account for warranty/age." },
      },
      required: ["verdict", "reasoning", "note"],
      additionalProperties: false,
    },
  },
};

export interface DeviceAnalysisInput {
  deviceId: string;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  uptimeSeconds: number;
  windowDays: number;
  avgCpuPercent: number;
  maxCpuPercent: number;
  avgMemPercent: number;
  maxMemPercent: number;
  worstDiskUsedPercent: number | null;
  incidentCount: number;
  sampleCount: number;
}

export async function analyzeDeviceForReplacement(input: DeviceAnalysisInput): Promise<DeviceAnalysis> {
  const uptimeDays = (input.uptimeSeconds / 86400).toFixed(1);
  const summary = [
    `Device ${input.deviceId} (${input.manufacturer ?? "unknown manufacturer"} ${input.model ?? "unknown model"}, ${input.osVersion ?? "unknown OS"}).`,
    `Current uptime: ${uptimeDays} days.`,
    `Over the last ${input.windowDays} day(s) (${input.sampleCount} telemetry samples):`,
    `- CPU usage: average ${input.avgCpuPercent.toFixed(1)}%, peak ${input.maxCpuPercent.toFixed(1)}%`,
    `- RAM usage: average ${input.avgMemPercent.toFixed(1)}%, peak ${input.maxMemPercent.toFixed(1)}%`,
    input.worstDiskUsedPercent !== null ? `- Worst disk usage: ${input.worstDiskUsedPercent.toFixed(1)}%` : "- No disk data available",
    `- Processes stopped responding ("Not Responding") ${input.incidentCount} time(s) in this window.`,
    "",
    "Should IT recommend this employee's machine be replaced, kept under monitoring, or is it fine as-is?",
  ].join("\n");

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    tools: [ANALYZE_TOOL],
    tool_choice: { type: "function", function: { name: "analyze_device_for_replacement" } },
    messages: [{ role: "user", content: summary }],
  });

  const toolCall = response.choices[0]?.message.tool_calls?.find(
    (c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
      c.type === "function" && c.function.name === "analyze_device_for_replacement",
  );
  if (!toolCall) {
    throw new Error(`device analysis: expected an analyze_device_for_replacement tool call, got finish_reason=${response.choices[0]?.finish_reason}`);
  }

  const rawArgs: unknown = JSON.parse(toolCall.function.arguments);
  const analysis = AnalysisSchema.parse(rawArgs);
  log.info({ input, analysis }, "device analysis: recommendation generated");
  return analysis;
}
