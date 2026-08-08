import { Meter } from "@/components/meters/Meter";
import { StatusBadge } from "@/components/status/StatusBadge";
import { formatMb, formatRelativeTime, severityForPercent } from "@/lib/format";
import type { AgentSummary } from "@/lib/types";

interface EndpointCardProps {
  agent: AgentSummary;
  onSelect: () => void;
}

export function EndpointCard({ agent, onSelect }: EndpointCardProps) {
  const snap = agent.lastTelemetry;
  const worstDisk = snap?.disks.length
    ? snap.disks.reduce((worst, d) => (d.used_percent > worst.used_percent ? d : worst))
    : null;

  const overallSeverity =
    agent.status === "offline"
      ? "offline"
      : snap
        ? severityForPercent(Math.max(snap.cpu_percent, snap.mem_percent, worstDisk?.used_percent ?? 0))
        : "offline";

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-ink-primary">{agent.agentId}</h3>
          <p className="text-[11px] text-ink-muted">Last seen {formatRelativeTime(agent.lastSeenAt)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge
            tone={agent.status === "offline" ? "offline" : "good"}
            label={agent.status === "offline" ? "Offline" : "Online"}
          />
          {snap?.mode === "alert" && <StatusBadge tone="critical" label="Alert mode" />}
        </div>
      </div>

      {snap ? (
        <div className="space-y-2.5">
          <Meter label="CPU" percent={snap.cpu_percent} />
          <Meter
            label="RAM"
            percent={snap.mem_percent}
            detail={`${formatMb(snap.mem_used_mb)} / ${formatMb(snap.mem_total_mb)}`}
          />
          {worstDisk && (
            <Meter label="Disk" percent={worstDisk.used_percent} detail={worstDisk.mount_point} />
          )}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">No telemetry received yet.</p>
      )}

      <span className="sr-only">Overall status: {overallSeverity}</span>
    </button>
  );
}
