// Powers the dashboard's "Should we replace this PC?" button. Advisory
// only, same trust posture as remediationAdvisor.ts — this never files a
// purchase request or takes any action itself, it just gives an IT operator
// a reasoned opinion to hand to whoever approves hardware spend.
//
// There's no purchase-date/warranty field anywhere in this system, so the
// model reasons from what telemetry actually shows: sustained resource
// pressure (a machine chronically pegged at high CPU/RAM/disk usage is a
// real productivity drag on whoever uses it) and reliability (how often
// something on it stops responding) — not an age estimate it would have to
// fabricate.
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
