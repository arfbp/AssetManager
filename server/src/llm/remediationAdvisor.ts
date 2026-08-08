// Powers the dashboard's "AI Suggested Fix" button in the process manager.
// Returns a recommendation only — it is never auto-applied. The operator
// reviews the suggestion and reasoning, then clicks a separate "Apply"
// action that goes through the same kill-process path as a manual force
// close (api/routes.ts's POST /agents/:id/kill-process).
import OpenAI from "openai";
import { z } from "zod";
import { log } from "../logger.js";

// Groq's Chat Completions API is OpenAI-compatible — see actionParser.ts.
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "llama-3.3-70b-versatile";

const SuggestionSchema = z.object({
  suggested_action: z.enum(["kill_process", "monitor"]),
  reasoning: z.string(),
  risk_note: z.string(),
});
export type RemediationSuggestion = z.infer<typeof SuggestionSchema>;

const SUGGEST_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "suggest_remediation",
    description:
      "Given one process's live resource usage on a fleet-managed device, recommend whether an IT operator " +
      "should force-close it or keep monitoring. This is advisory only — never state or imply the action has " +
      "already happened.",
    parameters: {
      type: "object",
      properties: {
        suggested_action: { type: "string", enum: ["kill_process", "monitor"] },
        reasoning: { type: "string", description: "One or two sentences on why, grounded in the numbers given." },
        risk_note: {
          type: "string",
          description: "One sentence on what could go wrong if the operator force-closes this process (e.g. unsaved work, service disruption).",
        },
      },
      required: ["suggested_action", "reasoning", "risk_note"],
      additionalProperties: false,
    },
  },
};

export interface RemediationInput {
  deviceId: string;
  processName: string;
  pid: number;
  cpuPercent: number;
  memMb: number;
}

export async function suggestRemediation(input: RemediationInput): Promise<RemediationSuggestion> {
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    tools: [SUGGEST_TOOL],
    tool_choice: { type: "function", function: { name: "suggest_remediation" } },
    messages: [
      {
        role: "user",
        content:
          `Process "${input.processName}" (pid ${input.pid}) on device ${input.deviceId} is currently using ` +
          `${input.cpuPercent.toFixed(1)}% CPU and ${input.memMb.toFixed(0)}MB RAM. Should IT force-close it, ` +
          "or just keep monitoring it for now?",
      },
    ],
  });

  const toolCall = response.choices[0]?.message.tool_calls?.find(
    (c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
      c.type === "function" && c.function.name === "suggest_remediation",
  );
  if (!toolCall) {
    throw new Error(`remediation advisor: expected a suggest_remediation tool call, got finish_reason=${response.choices[0]?.finish_reason}`);
  }

  const rawArgs: unknown = JSON.parse(toolCall.function.arguments);
  const suggestion = SuggestionSchema.parse(rawArgs);
  log.info({ input, suggestion }, "remediation advisor: suggestion generated");
  return suggestion;
}
