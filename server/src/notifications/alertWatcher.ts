// Watches the registry's "update" event (fires on every heartbeat/telemetry
// state change) for two edge-triggered transitions notifications care about:
// a device going offline/coming back online, and telemetry entering/leaving
// alert mode (CPU/RAM over threshold). Both are diffed against
// previously-seen state kept here, not derived from a single snapshot —
// "update" fires on *every* heartbeat regardless of whether anything
// actually changed, so without this a device sitting in alert mode would
// re-notify on every single poll instead of once per transition.
import type { AgentRegistry, AgentSummary } from "../ws/registry.js";
import { notifyAll } from "./dispatcher.js";
import type { NotifyConfig } from "./types.js";

// Keyed by "orgId:agentId", not bare agentId — agentId is just the
// machine's OS hostname (e.g. "DESKTOP-001") and is NOT unique across
// orgs (same reasoning as ws/registry.ts's mapKey and db/persistence.ts's
// agentKey/incidentKey). Keying on agentId alone let one org's transition
// mask or spuriously trigger another same-hostname org's notification —
// e.g. Org A's DESKTOP-001 entering alert mode would make Org B's
// DESKTOP-001 later entering alert mode look like no change at all,
// silently dropping Org B's real notification.
function trackerKey(orgId: string, agentId: string): string {
  return `${orgId}:${agentId}`;
}

export function wireNotifications(registry: AgentRegistry, cfg: NotifyConfig): void {
  const previousStatus = new Map<string, AgentSummary["status"]>();
  const previousMode = new Map<string, "normal" | "alert">();

  registry.on("update", (summary: AgentSummary) => {
    const key = trackerKey(summary.orgId, summary.agentId);
    const prevStatus = previousStatus.get(key);
    if (prevStatus !== undefined && prevStatus !== summary.status) {
      notifyAll(cfg, {
        kind: summary.status === "offline" ? "device_offline" : "device_online",
        agentId: summary.agentId,
        message: summary.status === "offline" ? `${summary.agentId} went offline.` : `${summary.agentId} is back online.`,
        severity: summary.status === "offline" ? "warning" : "info",
      });
    }
    previousStatus.set(key, summary.status);

    const mode = summary.lastTelemetry?.mode;
    if (mode) {
      const prevMode = previousMode.get(key);
      if (prevMode !== undefined && prevMode !== mode) {
        notifyAll(cfg, {
          kind: mode === "alert" ? "resource_alert" : "resource_recovered",
          agentId: summary.agentId,
          message:
            mode === "alert"
              ? `${summary.agentId} entered alert mode (CPU ${summary.lastTelemetry!.cpu_percent.toFixed(0)}%, RAM ${summary.lastTelemetry!.mem_percent.toFixed(0)}%).`
              : `${summary.agentId} resource usage is back to normal.`,
          severity: mode === "alert" ? "critical" : "info",
        });
      }
      previousMode.set(key, mode);
    }
  });
}
