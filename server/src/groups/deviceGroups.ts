// Resolves a natural-language "scope" (e.g. "accounting-group", "Admin-01")
// to a concrete list of agent IDs. Named, multi-device GROUPS are still a
// local, static lookup loaded once at startup from an operator-edited JSON
// file — the LLM parser (llm/actionParser.ts) can never invent a group name
// that reaches more than what an operator explicitly configured there.
//
// A bare device name is different: it falls back to whatever's actually
// connected right now (see getLiveAgentIds), so a newly-deployed real
// machine is targetable by its own hostname immediately, with no separate
// per-device config-file edit required. This doesn't weaken the original
// bound — the LLM still can't reach a device that was never authenticated
// and connected to this exact server, it just no longer requires a manual
// allowlist entry on top of that authentication, which was pure friction
// (every single newly-deployed agent needing an extra manual step before
// the AI console could address it, despite already being fully trusted for
// every other command path this project has).
import { readFileSync } from "node:fs";
import { log } from "../logger.js";

export class DeviceGroups {
  // Configured groups are still one process-wide static file today — a
  // known, deliberately deferred gap (see the multi-tenant migration plan's
  // Phase 5/9): a group name an operator configured is visible/resolvable
  // fleet-wide, not scoped per org. Low real-world impact for now (nothing
  // customer-sensitive lives in a group name itself, and any org's actual
  // dispatch still only ever reaches its OWN connected agents — see
  // getLiveAgentIds below and ws/registry.ts's composite org+agentId keys,
  // which independently stop a resolved-but-foreign agentId from ever
  // receiving a command), but real enough to fix properly (per-org group
  // storage) before this matters for an actual second paying customer.
  private readonly groups: Map<string, string[]>;
  // Unlike `groups`, this DOES need to be org-scoped — it reflects live,
  // currently-connected devices (real hostnames), and the whole reason
  // ws/registry.ts became org+agentId composite-keyed was so this couldn't
  // resolve into another org's device by hostname collision.
  private readonly getLiveAgentIds: (orgId: string) => string[];

  private constructor(groups: Map<string, string[]>, getLiveAgentIds: (orgId: string) => string[]) {
    this.groups = groups;
    this.getLiveAgentIds = getLiveAgentIds;
  }

  static loadFromFile(path: string, getLiveAgentIds: (orgId: string) => string[]): DeviceGroups {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`device groups: failed to read ${path}: ${(err as Error).message}`);
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const groups = new Map<string, string[]>();
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("_")) continue; // allow "_comment" style keys
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new Error(`device groups: entry ${key} must be an array of agent ID strings`);
      }
      groups.set(key.toLowerCase(), value as string[]);
    }

    log.info({ groupCount: groups.size, path }, "device groups loaded");
    return new DeviceGroups(groups, getLiveAgentIds);
  }

  /**
   * Resolves a scope string to agent IDs: a configured group name first,
   * then (if no group matches) a live agent whose ID matches exactly —
   * automatic, not requiring that device to also be listed as its own
   * single-entry group in the config file.
   */
  resolve(orgId: string, scope: string): string[] {
    const configured = this.groups.get(scope.toLowerCase());
    if (configured) return configured;

    const live = this.getLiveAgentIds(orgId).find((id) => id.toLowerCase() === scope.toLowerCase());
    return live ? [live] : [];
  }

  isKnownScope(orgId: string, scope: string): boolean {
    if (this.groups.has(scope.toLowerCase())) return true;
    return this.getLiveAgentIds(orgId).some((id) => id.toLowerCase() === scope.toLowerCase());
  }

  /**
   * Configured group names plus every currently-connected agent's own ID —
   * fed into the LLM's system prompt as "known scopes" so it recognizes a
   * live device name it's never seen configured anywhere.
   */
  listScopes(orgId: string): string[] {
    return [...new Set([...this.groups.keys(), ...this.getLiveAgentIds(orgId)])];
  }
}
