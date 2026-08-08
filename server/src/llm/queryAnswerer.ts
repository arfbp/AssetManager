// Powers "query_info" requests from the AI command console — read-only
// questions about one device (IP address, OS version, uptime, disk space,
// what's running, what's connected) answered from the last telemetry
// snapshot already on file, with no round trip to the agent at all. See
// schema.ts's PARSEABLE_ACTIONS doc comment and routes.ts's short-circuit
// for why this bypasses the guardrail entirely — it never dispatches
// anything, so there's nothing for the guardrail to authorize.
//
// The one thing that matters here that doesn't matter for the action
// parser: this must not invent data. The prompt hands the model the actual
// JSON snapshot and forces it to say so (answerable=false) rather than
// guess when the data doesn't cover what was asked (e.g. installed
// software list, which nothing here collects).
import OpenAI from "openai";
import { z } from "zod";
import { log } from "../logger.js";
import type { TelemetrySnapshot } from "../protocol.js";

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "llama-3.3-70b-versatile";

// Only the top 20 processes by CPU (already sorted agent-side) go into the
// prompt even though a snapshot can carry the device's full process list
// (300+ on a busy machine) — enough to answer "what's running/using CPU"
// without ballooning every query into a multi-hundred-line prompt.
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
  // What the action parser (a separate, dedicated classification call —
  // actionParser.ts) already determined the operator wants to know, e.g.
  // "ip address". Verified in practice that this call re-interpreting the
  // raw question from scratch is measurably less reliable than the
  // classifier — a terse Thai phrasing ("ตรวจหาไอพี เครื่องนี้") was
  // correctly classified as being about the IP address, then answered as if
  // it were about CPU/RAM instead when this call was only given the raw
  // text. Passing the classifier's own conclusion through as a hint fixes
  // that without needing this call to be as good at open-ended
  // interpretation as a dedicated classifier already is.
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
