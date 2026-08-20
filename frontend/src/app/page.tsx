"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { FleetStats } from "@/components/endpoints/FleetStats";
import { StatusBadge } from "@/components/status/StatusBadge";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";
import { formatRelativeTime } from "@/lib/format";
import { getFleetIncidentSummary, getFleetLocations, getErpAlerts } from "@/lib/api";
import type { AgentSummary, HistoryEntry, HistoryEntryStatus, IncidentSummaryEntry, DeviceLocationEntry, ErpAlerts } from "@/lib/types";

const LiveMap = dynamic(() => import("@/components/tracking/LiveMap").then((m) => m.LiveMap), { ssr: false });

const INCIDENT_SUMMARY_WINDOW_DAYS = 30;
const RECENT_INCIDENT_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_PAGE_SIZE = 5;

type AttentionReason = "offline" | "alert" | "incidents";

interface AttentionEntry {
  agentId: string;
  reasons: AttentionReason[];
  lastSeenAt?: number;
  incidentCount?: number;
}

// alert mode (CPU/RAM เกิน threshold แบบ real-time) กับ incidents (process
// ค้างไม่ตอบสนอง) เป็นคนละสัญญาณกันจริง ๆ — process ค้างตัวเดียวไม่ได้แปลว่า
// CPU/RAM รวมของเครื่องจะเกิน threshold เสมอไป เลยต้อง merge ทั้งสอง (บวก
// offline) เข้า map เดียวกันแทนที่จะให้ตัวใดตัวหนึ่งบัง ต้องเริ่มจาก union
// ของ `agents` กับ `incidentSummary` ไม่ใช่แค่ `agents.filter(...)` เพราะ
// device อาจมี incident ที่เคย log ไว้ทั้งที่ตอนนี้ไม่อยู่ใน live registry แล้ว
function buildAttention(agents: AgentSummary[], incidentSummary: IncidentSummaryEntry[] | null): Map<string, AttentionEntry> {
  const byAgent = new Map<string, AttentionEntry>();
  for (const a of agents) {
    const reasons: AttentionReason[] = [];
    if (a.status === "offline") reasons.push("offline");
    if (a.lastTelemetry?.mode === "alert") reasons.push("alert");
    if (reasons.length > 0) byAgent.set(a.agentId, { agentId: a.agentId, reasons, lastSeenAt: a.lastSeenAt });
  }
  for (const entry of incidentSummary ?? []) {
    if (Date.now() - new Date(entry.lastIncidentAt).getTime() > RECENT_INCIDENT_MS) continue;
    const existing = byAgent.get(entry.agentId);
    if (existing) {
      existing.reasons.push("incidents");
      existing.incidentCount = entry.incidentCount;
    } else {
      byAgent.set(entry.agentId, { agentId: entry.agentId, reasons: ["incidents"], incidentCount: entry.incidentCount });
    }
  }
  return byAgent;
}

const ACTIVITY_STATUS_TONE: Record<HistoryEntryStatus, { tone: "good" | "warning" | "critical" | "offline"; label: string }> = {
  succeeded: { tone: "good", label: "Succeeded" },
  failed: { tone: "critical", label: "Failed" },
  dispatched: { tone: "warning", label: "Running…" },
  offline: { tone: "offline", label: "Offline" },
};

function ActivityTable({ history }: { history: HistoryEntry[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(history.length / ACTIVITY_PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const rows = history.slice(clampedPage * ACTIVITY_PAGE_SIZE, clampedPage * ACTIVITY_PAGE_SIZE + ACTIVITY_PAGE_SIZE);

  return (
    <div className="glass-card overflow-hidden rounded-xl">
      <div className="flex items-center justify-between border-b border-border p-4 sm:p-6">
        <h3 className="text-headline-sm font-semibold text-ink-primary">Recent activity</h3>
      </div>
      {history.length === 0 ? (
        <p className="p-6 text-sm text-ink-muted">No commands dispatched yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Device", "Action", "Requested by", "When", "Status"].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {rows.map((e) => {
                  const status = ACTIVITY_STATUS_TONE[e.status];
                  return (
                    <tr key={e.commandId} className="transition-colors hover:bg-gridline/20">
                      <td className="p-4 text-sm font-bold text-ink-primary">{e.agentId}</td>
                      <td className="p-4 font-mono text-sm text-ink-secondary">{e.action}</td>
                      <td className="p-4 text-sm text-ink-secondary">{e.requestedBy}</td>
                      <td className="p-4 text-xs text-ink-muted">{formatRelativeTime(e.dispatchedAt)}</td>
                      <td className="p-4">
                        <StatusBadge tone={status.tone} label={status.label} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-border p-4">
            <span className="text-xs text-ink-muted">
              Showing {rows.length} of {history.length}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={clampedPage === 0}
                onClick={() => setPage(clampedPage - 1)}
                className="rounded-md border border-border px-3 py-1 text-xs text-ink-secondary hover:bg-gridline/40 disabled:opacity-40"
              >
                Prev
              </button>
              <span className="px-2 py-1 text-xs text-ink-muted">
                {clampedPage + 1} / {pageCount}
              </span>
              <button
                type="button"
                disabled={clampedPage >= pageCount - 1}
                onClick={() => setPage(clampedPage + 1)}
                className="rounded-md border border-border px-3 py-1 text-xs text-ink-secondary hover:bg-gridline/40 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface InsightCardProps {
  icon: string;
  tone: "good" | "accent" | "critical";
  title: string;
  body: string;
  actionLabel: string;
  actionHref: string;
}

const INSIGHT_TONE = {
  good: {
    wrapper: "border-l-status-good bg-status-good/[0.04]",
    icon: "text-status-good",
    title: "text-status-good",
    button: "bg-status-good text-white hover:opacity-90",
  },
  accent: {
    wrapper: "border-l-accent",
    icon: "text-accent",
    title: "text-accent",
    button: "border border-accent text-accent hover:bg-accent/10",
  },
  critical: {
    wrapper: "border-l-status-critical",
    icon: "text-status-critical",
    title: "text-status-critical",
    button: "border border-status-critical text-status-critical hover:bg-status-critical/10",
  },
};

function InsightCard({ icon, tone, title, body, actionLabel, actionHref }: InsightCardProps) {
  const t = INSIGHT_TONE[tone];
  return (
    <div className={`glass-card overflow-hidden rounded-xl border-l-4 ${t.wrapper}`}>
      <div className="p-card-padding">
        <div className="mb-3 flex items-center gap-3">
          <span className={`material-symbols-outlined ${t.icon}`}>{icon}</span>
          <span className={`text-sm font-bold ${t.title}`}>{title}</span>
        </div>
        <p className="mb-4 text-sm text-ink-primary">{body}</p>
        <Link href={actionHref} className={`block w-full rounded-lg py-2 text-center text-sm font-medium transition-all ${t.button}`}>
          {actionLabel}
        </Link>
      </div>
    </div>
  );
}

function Dashboard({ username }: { username: string }) {
  const { agents, history, connectionStatus } = useDashboardSocket();
  const [incidentSummary, setIncidentSummary] = useState<IncidentSummaryEntry[] | null>(null);
  const [locations, setLocations] = useState<DeviceLocationEntry[] | null>(null);
  const [erpAlerts, setErpAlerts] = useState<ErpAlerts | null>(null);

  useEffect(() => {
    getFleetIncidentSummary(INCIDENT_SUMMARY_WINDOW_DAYS, 10)
      .then((res) => setIncidentSummary(res.devices))
      .catch(() => setIncidentSummary([]));
  }, []);

  // เป็น "needs attention" อีกชุดเหมือน buildAttention ด้านบน แต่ key ด้วย
  // asset tag แทน agentId — รายการ warranty/maintenance ไม่จำเป็นต้องมี
  // device เชื่อมอยู่เสมอไป (เช่น peripheral หรือ asset ที่ยังเป็น
  // "ready_to_deploy") เลย track แยกไว้แล้วรวมเข้ากับตัวนับ bell-badge
  // แทนที่จะยัดเข้า device map
  useEffect(() => {
    getErpAlerts(30)
      .then(setErpAlerts)
      .catch(() => setErpAlerts({ expiringWarranties: [], upcomingMaintenance: [], expiringLicenses: [] }));
  }, []);

  useEffect(() => {
    getFleetLocations()
      .then((res) => setLocations(res.devices))
      .catch(() => setLocations([]));
  }, []);

  const attention = buildAttention(agents, incidentSummary);
  const attentionCount = attention.size;
  const erpAlertCount = erpAlerts ? erpAlerts.expiringWarranties.length + erpAlerts.upcomingMaintenance.length + erpAlerts.expiringLicenses.length : 0;
  const located = (locations ?? []).filter((d) => d.lat !== null && d.lon !== null);

  const onlineWithTelemetry = agents.filter((a) => a.status === "online" && a.lastTelemetry);
  const avgCpu = onlineWithTelemetry.length
    ? onlineWithTelemetry.reduce((sum, a) => sum + a.lastTelemetry!.cpu_percent, 0) / onlineWithTelemetry.length
    : null;
  const avgMem = onlineWithTelemetry.length
    ? onlineWithTelemetry.reduce((sum, a) => sum + a.lastTelemetry!.mem_percent, 0) / onlineWithTelemetry.length
    : null;

  const topIssue = incidentSummary?.[0] ?? null;

  return (
    <AppShell
      username={username}
      notificationCount={attentionCount + erpAlertCount}
      connectionStatus={connectionStatus}
      statusSlot={
        <StatusBadge
          tone={connectionStatus === "open" ? "good" : "critical"}
          label={connectionStatus === "open" ? "Live" : connectionStatus === "connecting" ? "Connecting…" : "Disconnected"}
        />
      }
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-headline-lg font-bold text-ink-primary">Fleet Overview</h2>
            <p className="font-body-md text-ink-secondary">Live summary from the AI monitoring system.</p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/devices"
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink-secondary transition-all hover:bg-gridline/40"
            >
              <span className="material-symbols-outlined text-[18px]">list</span>
              View all devices
            </Link>
            <Link
              href="/console"
              className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white shadow-sm transition-all hover:opacity-90 active:scale-95"
            >
              <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
              AI Console
            </Link>
          </div>
        </div>

        <FleetStats agents={agents} />

        <div className="grid grid-cols-12 gap-6">
          <div className="glass-card col-span-12 flex min-h-[500px] flex-col overflow-hidden rounded-xl lg:col-span-8">
            <div className="flex items-center justify-between border-b border-border bg-surface p-4">
              <h3 className="flex items-center gap-2 text-headline-sm font-semibold text-ink-primary">
                <span className="material-symbols-outlined text-accent">map</span>
                Live device map
              </h3>
              <p className="text-xs text-ink-muted">Approximate location by IP — not GPS</p>
            </div>
            <div className="relative flex-1">
              {locations === null ? (
                <div className="flex h-full items-center justify-center text-sm text-ink-muted">Loading…</div>
              ) : located.length === 0 ? (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-muted">
                  No devices have a resolvable public IP yet.
                </div>
              ) : (
                <LiveMap devices={located} />
              )}
            </div>
          </div>

          <div className="glass-card col-span-12 flex max-h-[500px] flex-col overflow-hidden rounded-xl lg:col-span-4">
            <div className="border-b border-border bg-surface p-4">
              <h3 className="text-headline-sm font-semibold text-ink-primary">Device status</h3>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {agents.length === 0 && <p className="p-3 text-sm text-ink-muted">No devices have connected yet.</p>}
              {agents.map((agent) => {
                const att = attention.get(agent.agentId);
                const mem = agent.lastTelemetry?.mem_percent;
                return (
                  <Link
                    key={agent.agentId}
                    href={`/devices?agent=${encodeURIComponent(agent.agentId)}`}
                    className="block cursor-pointer rounded-lg border border-border p-4 transition-all hover:bg-gridline/30"
                  >
                    <div className="flex items-start justify-between">
                      <span className="text-sm font-bold text-ink-primary">{agent.agentId}</span>
                      <StatusBadge tone={agent.status === "online" ? "good" : "offline"} label={agent.status === "online" ? "Online" : "Offline"} />
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">
                      {att?.reasons.includes("alert")
                        ? "CPU/RAM over threshold"
                        : att?.reasons.includes("incidents")
                          ? `${att.incidentCount} incident(s) in the last 24h`
                          : `Last seen ${formatRelativeTime(agent.lastSeenAt)}`}
                    </p>
                    {mem !== undefined && (
                      <div className="mt-2 flex items-center gap-3">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-primary/10">
                          <div
                            className={`h-full rounded-full ${mem >= 85 ? "bg-status-critical" : "bg-accent"}`}
                            style={{ width: `${Math.max(Math.min(100, mem), 3)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-ink-muted">{Math.round(mem)}%</span>
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined text-status-good">auto_awesome</span>
            <h3 className="text-headline-sm font-semibold text-ink-primary">AI insights &amp; recommendations</h3>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
            <InsightCard
              icon="build_circle"
              tone="good"
              title="Reliability risk"
              body={
                topIssue
                  ? `${topIssue.agentId} logged ${topIssue.incidentCount} not-responding incidents in the last ${INCIDENT_SUMMARY_WINDOW_DAYS} days (last ${formatRelativeTime(new Date(topIssue.lastIncidentAt).getTime())}).`
                  : "No devices have logged reliability incidents in this window."
              }
              actionLabel="View device"
              actionHref={topIssue ? `/devices?agent=${encodeURIComponent(topIssue.agentId)}` : "/devices"}
            />
            <InsightCard
              icon="monitoring"
              tone="accent"
              title="Fleet resource usage"
              body={
                avgCpu !== null && avgMem !== null
                  ? `Average CPU ${avgCpu.toFixed(0)}% and RAM ${avgMem.toFixed(0)}% across ${onlineWithTelemetry.length} online device(s).`
                  : "No online devices are reporting telemetry yet."
              }
              actionLabel="View all devices"
              actionHref="/devices"
            />
            <InsightCard
              icon="warning"
              tone="critical"
              title="Needs attention"
              body={
                attentionCount > 0
                  ? `${attentionCount} device(s) are offline, in alert mode, or have recent incidents.`
                  : "All devices are online and healthy right now."
              }
              actionLabel="Review devices"
              actionHref="/devices"
            />
            <InsightCard
              icon="event_upcoming"
              tone={erpAlertCount > 0 ? "critical" : "good"}
              title="Asset management"
              body={
                erpAlertCount > 0
                  ? `${erpAlerts!.expiringWarranties.length} warrant${erpAlerts!.expiringWarranties.length === 1 ? "y" : "ies"} expiring, ${erpAlerts!.upcomingMaintenance.length} maintenance item(s) due, and ${erpAlerts!.expiringLicenses.length} license(s) expiring in the next 30 days.`
                  : "No warranties expiring or maintenance due in the next 30 days."
              }
              actionLabel="Review maintenance"
              actionHref="/maintenance"
            />
          </div>
        </div>

        <ActivityTable history={history} />
      </div>
    </AppShell>
  );
}

export default function DashboardPage() {
  return <AuthGate>{(username) => <Dashboard username={username} />}</AuthGate>;
}
