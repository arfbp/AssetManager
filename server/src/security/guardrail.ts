// The single choke point every parsed natural-language command passes
// through before it can become a signed CommandPayload sent to an agent.
// Nothing here trusts the LLM's output as an authorization decision —
// scope resolution is a local config lookup (deviceGroups.ts), action
// semantics are re-derived from a fixed switch (not copied from the model),
// and content that reaches an agent as executable text is blacklist-scanned
// even when it comes from a pre-vetted template.
import { audit } from "../logger.js";
import type { DeviceGroups } from "../groups/deviceGroups.js";
import { lookupUninstallTemplate } from "../llm/uninstallTemplates.js";
import type { ParsedIntent } from "../llm/schema.js";
import { scanForBlacklistedContent } from "./blacklist.js";
import type { CommandAction } from "../protocol.js";

export interface ResolvedCommand {
  action: CommandAction;
  params: Record<string, string>;
}

export type GuardrailVerdict =
  | { verdict: "blocked"; reason: string }
  | { verdict: "needs_confirmation"; resolved: ResolvedCommand; targets: string[]; reason: string }
  | { verdict: "allowed"; resolved: ResolvedCommand; targets: string[] };

export interface GuardrailContext {
  orgId: string;
  deviceGroups: DeviceGroups;
  /** Mirrors the agent's own OPTIFLEET_ENABLE_RUN_SCRIPT gate — the server has an independent copy of this decision. */
  enableRunScriptDispatch: boolean;
  /** Resolved target count at or above this forces human confirmation for destructive actions, regardless of the LLM's confirm signal. */
  massActionThreshold: number;
}

function blocked(reason: string): GuardrailVerdict {
  return { verdict: "blocked", reason };
}

export function evaluateParsedIntent(parsed: ParsedIntent, ctx: GuardrailContext): GuardrailVerdict {
  const auditBase = { action: parsed.action, target: parsed.target, scope: parsed.scope, llmReasoning: parsed.reasoning };

  if (parsed.action === "unsupported") {
    audit.warn({ ...auditBase, verdict: "blocked" }, "guardrail: request did not map to a supported action");
    return blocked("Could not confidently map this request to a supported fleet action.");
  }

  const targets = ctx.deviceGroups.resolve(ctx.orgId, parsed.scope);
  if (targets.length === 0) {
    audit.warn({ ...auditBase, verdict: "blocked" }, "guardrail: unknown scope");
    return blocked(
      `Unknown device/group scope "${parsed.scope}". Known scopes: ${ctx.deviceGroups.listScopes(ctx.orgId).join(", ")}`,
    );
  }

  const resolution = resolveAction(parsed, ctx);
  if (resolution.verdict === "blocked") {
    audit.warn({ ...auditBase, verdict: "blocked", reason: resolution.reason }, "guardrail: action resolution blocked");
    return resolution;
  }
  const resolved = resolution.resolved;

  const massAction = targets.length >= ctx.massActionThreshold;
  const isDestructiveTier =
    parsed.action === "restart_host" || parsed.action === "shutdown_host" || parsed.action === "uninstall_software";
  const isKillProcess = parsed.action === "kill_process";

  // restart_host / shutdown_host / uninstall_software: ALWAYS requires human
  // confirmation, full stop — parsed.confirm is never enough on its own to skip it, no
  // matter how the request was phrased or how confident the model was.
  // This used to allow skipping confirmation when the model reported
  // confirm=true on a single-device target, on the theory that sufficiently
  // explicit operator wording ("restart it now, confirmed") shouldn't need
  // a redundant second click. In practice, the model is not reliable enough
  // for that: verified live, the exact same bare, non-explicit text
  // ("restart", nothing else) got parsed.confirm=false for one device and
  // parsed.confirm=true for another in back-to-back calls, and the latter
  // dispatched a real reboot with no human ever confirming anything. A
  // reboot closes every running program on a real machine — the cost of one
  // extra click for the rare case where the operator really did mean to
  // skip confirmation is far lower than the cost of trusting this field.
  // kill_process: lower stakes (recoverable, scoped to one process) — only
  // escalates to confirmation when it's a mass action across many devices.
  // clean_temp: never needs confirmation — already tightly bounded by the
  // directory allowlist on the agent side.
  let needsConfirmation = false;
  const reasons: string[] = [];
  if (isDestructiveTier) {
    needsConfirmation = true;
    reasons.push("destructive action — always requires explicit human confirmation before dispatch");
    if (targets.length > 1) reasons.push(`targets ${targets.length} devices`);
  } else if (isKillProcess && massAction) {
    needsConfirmation = true;
    reasons.push(`targets ${targets.length} devices`);
  }

  if (needsConfirmation) {
    audit.warn(
      { ...auditBase, verdict: "needs_confirmation", targets, resolved },
      "guardrail: command requires human confirmation before dispatch",
    );
    return { verdict: "needs_confirmation", resolved, targets, reason: reasons.join("; ") };
  }

  audit.info({ ...auditBase, verdict: "allowed", targets, resolved }, "guardrail: command allowed");
  return { verdict: "allowed", resolved, targets };
}

function resolveAction(
  parsed: ParsedIntent,
  ctx: GuardrailContext,
): { verdict: "resolved"; resolved: ResolvedCommand } | { verdict: "blocked"; reason: string } {
  const target = parsed.target.trim();

  switch (parsed.action) {
    case "kill_process": {
      if (!target) return { verdict: "blocked", reason: "kill_process requires a process name or PID." };
      const params = /^\d+$/.test(target) ? { pid: target } : { name: target };
      return { verdict: "resolved", resolved: { action: "kill_process", params } };
    }

    case "clean_temp": {
      const params = target ? { dir: target } : {};
      return { verdict: "resolved", resolved: { action: "clean_temp", params } };
    }

    case "restart_host": {
      // Independent check, not just prompt-engineering: restart_host reboots
      // the entire machine, closing every running program, not just one. A
      // non-empty target here means the model extracted something to act on
      // beyond the device itself — almost always a specific program name
      // from a request like "restart <app>", which is a kill_process request
      // misclassified as a full reboot. This has happened in practice (a
      // request to restart one app rebooted the whole machine instead), so
      // this is blocked outright rather than trusted, regardless of what the
      // model's own reasoning says.
      if (target) {
        return {
          verdict: "blocked",
          reason:
            `restart_host reboots the entire device, but this request named "${target}" as the thing to restart — ` +
            `that reads as a specific program, not the device itself. To restart/close that program, phrase it as ` +
            `"kill ${target}" or "close ${target}" instead. To actually reboot the whole machine, phrase the ` +
            `request without naming a program.`,
        };
      }
      return { verdict: "resolved", resolved: { action: "restart_host", params: { confirm: "true" } } };
    }

    case "shutdown_host": {
      // Same independent check as restart_host, and for the same reason:
      // shutdown_host powers off the entire device (and leaves it off,
      // unlike restart_host) — a named target here almost always means a
      // program-close request ("shut down Chrome") got misclassified as a
      // full power-off, so it's blocked outright rather than trusted.
      if (target) {
        return {
          verdict: "blocked",
          reason:
            `shutdown_host powers off the entire device, but this request named "${target}" as the thing to shut down — ` +
            `that reads as a specific program, not the device itself. To close that program, phrase it as ` +
            `"kill ${target}" or "close ${target}" instead. To actually power off the whole machine, phrase the ` +
            `request without naming a program.`,
        };
      }
      return { verdict: "resolved", resolved: { action: "shutdown_host", params: { confirm: "true" } } };
    }

    case "run_script": {
      // The model never authors run_script content under this schema — see
      // schema.ts, target/scope are plain identifiers, not script text. A
      // flow that genuinely needs to dispatch an admin-authored script
      // requires a separate, explicit endpoint where a human supplies and
      // reviews the script body — never something inferred from free text.
      return {
        verdict: "blocked",
        reason:
          "run_script cannot be dispatched from a natural-language request. Its content must be supplied " +
          "explicitly through a reviewed script-submission flow, not inferred by the parser.",
      };
    }

    case "uninstall_software": {
      if (!ctx.enableRunScriptDispatch) {
        return {
          verdict: "blocked",
          reason: "Uninstall actions require run_script dispatch to be enabled on this server (OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH).",
        };
      }
      const template = lookupUninstallTemplate(target);
      if (!template) {
        return {
          verdict: "blocked",
          reason: `No vetted uninstall template for "${target}". An administrator must add one to llm/uninstallTemplates.ts after review.`,
        };
      }
      const hit = scanForBlacklistedContent(template.script);
      if (hit) {
        // A vetted template matching the blacklist means the template was
        // tampered with or miswritten — this is an internal integrity
        // failure, not a normal "request rejected" outcome, so it's logged
        // at error level distinctly from the ordinary blocked-request path.
        audit.error({ target, hit }, "guardrail: vetted uninstall template matched the blacklist scan — treat as compromised");
        return { verdict: "blocked", reason: "Internal safety check failed for this uninstall template — contact an administrator." };
      }
      return {
        verdict: "resolved",
        resolved: {
          action: "run_script",
          params: { interpreter: template.interpreter, script: template.script, confirm: "true" },
        },
      };
    }

    case "ping":
    case "tracert":
    case "nslookup": {
      if (!target) {
        return { verdict: "blocked", reason: `${parsed.action} requires a target hostname or IP address.` };
      }
      return {
        verdict: "resolved",
        resolved: { action: "network_diagnostic", params: { tool: parsed.action, target } },
      };
    }

    case "netstat": {
      return {
        verdict: "resolved",
        resolved: { action: "network_diagnostic", params: { tool: "netstat", target: "" } },
      };
    }

    case "unsupported": {
      // Unreachable in practice — evaluateParsedIntent already returns
      // before calling resolveAction for this case. Handled here only so
      // the switch stays exhaustively typed against ParsedIntent.action.
      return { verdict: "blocked", reason: "unsupported action" };
    }

    case "query_info": {
      // Unreachable in practice — routes.ts intercepts query_info before
      // evaluateParsedIntent is ever called (see schema.ts's doc comment on
      // PARSEABLE_ACTIONS). Handled here only for exhaustive typing; if this
      // ever *does* fire it means that short-circuit broke, so fail closed
      // with a clear reason rather than silently resolving to a no-op dispatch.
      return { verdict: "blocked", reason: "query_info must be answered before reaching the guardrail, never dispatched" };
    }

    default: {
      const exhaustive: never = parsed.action;
      return { verdict: "blocked", reason: `unhandled action: ${exhaustive}` };
    }
  }
}
