import { StatusBadge } from "@/components/status/StatusBadge";
import { formatMb, formatRelativeTime, severityForPercent, type Severity } from "@/lib/format";
import type { AgentSummary } from "@/lib/types";

const BAR_TONE: Record<Severity, string> = {
  good: "bg-status-good",
  warning: "bg-status-warning",
  critical: "bg-status-critical",
};

// bar แบบย่อสำหรับใช้ในเซลล์ตาราง — <Meter> ของ card grid มี label ซ้ำ
// เหนือ bar เอง ซึ่งอ่านโอเคตอนมีการ์ดเดียว แต่ในตารางจะซ้ำซ้อนเพราะหัว
// คอลัมน์บอกอยู่แล้วว่าเป็น "CPU"/"RAM"/"Disk"
function CellBar({ percent, detail }: { percent: number; detail?: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const severity = severityForPercent(clamped);
  return (
    <div className="flex min-w-[120px] flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <div className="h-1.5 w-full max-w-[90px] overflow-hidden rounded-full bg-ink-primary/10">
          <div className={`h-full rounded-full ${BAR_TONE[severity]}`} style={{ width: `${clamped}%` }} />
        </div>
        <span className="tabular text-xs font-semibold text-ink-primary">{Math.round(clamped)}%</span>
      </div>
      {detail && <p className="text-[11px] text-ink-muted">{detail}</p>}
    </div>
  );
}

interface EndpointTableProps {
  agents: AgentSummary[];
  onSelect: (agentId: string) => void;
}

export function EndpointTable({ agents, onSelect }: EndpointTableProps) {
  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-ink-muted">
        No devices match the current filters.
      </div>
    );
  }

  return (
    <div className="glass-card overflow-hidden rounded-xl">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-card-padding py-2 font-medium">Device</th>
              <th className="px-card-padding py-2 font-medium">Status</th>
              <th className="px-card-padding py-2 font-medium">CPU</th>
              <th className="px-card-padding py-2 font-medium">RAM</th>
              <th className="px-card-padding py-2 font-medium">Disk</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const snap = agent.lastTelemetry;
              // disks เองก็เป็น null ได้ (ไม่ใช่แค่ lastTelemetry) — ฟังก์ชัน
              // แจกแจง disk partition ของ Go agent จะคืนค่า nil เปล่าๆ เมื่อ
              // ทำงานล้มเหลว ซึ่ง serialize ออกมาเป็น JSON null ไม่ใช่ []
              const disks = snap?.disks ?? [];
              const worstDisk = disks.length ? disks.reduce((worst, d) => (d.used_percent > worst.used_percent ? d : worst)) : null;
              return (
                <tr
                  key={agent.agentId}
                  onClick={() => onSelect(agent.agentId)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-page"
                >
                  <td className="px-card-padding py-3">
                    <p className="font-semibold text-ink-primary">{agent.agentId}</p>
                    <p className="text-[11px] text-ink-muted">Last seen {formatRelativeTime(agent.lastSeenAt)}</p>
                  </td>
                  <td className="px-card-padding py-3">
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge tone={agent.status === "offline" ? "offline" : "good"} label={agent.status === "offline" ? "Offline" : "Online"} />
                      {snap?.mode === "alert" && <StatusBadge tone="critical" label="Alert mode" />}
                    </div>
                  </td>
                  {snap ? (
                    <>
                      <td className="px-card-padding py-3">
                        <CellBar percent={snap.cpu_percent} />
                      </td>
                      <td className="px-card-padding py-3">
                        <CellBar percent={snap.mem_percent} detail={`${formatMb(snap.mem_used_mb)} / ${formatMb(snap.mem_total_mb)}`} />
                      </td>
                      <td className="px-card-padding py-3">
                        {worstDisk ? <CellBar percent={worstDisk.used_percent} detail={worstDisk.mount_point} /> : <span className="text-ink-muted">—</span>}
                      </td>
                    </>
                  ) : (
                    <td className="px-card-padding py-3 text-xs text-ink-muted" colSpan={3}>
                      No telemetry received yet.
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
