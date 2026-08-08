// The fixed shape every natural-language command must resolve to. The LLM
// only ever fills in these five fields via forced tool use — it never emits
// free-form JSON, and it never authors executable content (see
// uninstallTemplates.ts for why "uninstall_software" doesn't let the model
// write its own uninstall command).
import { z } from "zod";
import type OpenAI from "openai";

// "uninstall_software" and "unsupported" are not agent actions — the agent
// (internal/executor) only implements kill_process / clean_temp /
// restart_host / run_script. The guardrail maps uninstall_software onto a
// vetted run_script template (security/guardrail.ts) and always rejects
// "unsupported" with a clear message back to the caller.
// "query_info" is not an agent action either — it never dispatches anything
// to a device at all. It's a read-only question about a device's current
// state (IP address, OS version, uptime, disk space, what's running, what's
// connected) that the server can already answer from the last telemetry
// snapshot it has on file, without a round trip to the agent. See
// src/llm/queryAnswerer.ts and routes.ts's short-circuit before the
// guardrail — it's intercepted earlier in the pipeline precisely because
// evaluateParsedIntent's whole job is deciding whether to *dispatch*
// something, which a pure read never needs.
// "ping"/"tracert"/"nslookup"/"netstat" are, like uninstall_software, not
// wire-level agent actions — the agent only ever receives a single
// "network_diagnostic" action with a params.tool field (see
// internal/executor/executor.go's networkDiagnostic). Splitting them into
// four distinct classifier-facing actions rather than one generic
// "network_diagnostic" + a tool sub-field avoids widening ParsedIntent's
// fixed 5-field shape, and target is genuinely just "the host to point the
// tool at" for these — the same field kill_process already uses for "the
// process to point the action at". security/guardrail.ts's resolveAction
// does the translation to the wire-level action, same pattern as
// uninstall_software -> run_script.
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
            "version is this', 'what's connected to it', 'what's running on it'. Put a short description of what " +
            "they want to know in `target` (e.g. 'ip address', 'disk space', 'uptime'). " +
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
