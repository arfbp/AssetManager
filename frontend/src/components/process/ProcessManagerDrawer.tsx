"use client";

import { useEffect, useState } from "react";
import { ChatConsole } from "@/components/chat/ChatConsole";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Meter } from "@/components/meters/Meter";
import { StatusBadge } from "@/components/status/StatusBadge";
import { HistoryChart } from "@/components/history/HistoryChart";
import type { StreamedCommandOutput } from "@/hooks/useDashboardSocket";
import { ApiError, getDeviceReport, getHistory, getIncidents, killProcess, suggestRemediation } from "@/lib/api";
import { formatMb, formatRelativeTime } from "@/lib/format";
import type { AgentSummary, DeviceAnalysis, DeviceInfo, DeviceReport, HistoryEntry, HistoryEntryStatus, HistoryPoint, Incident, ProcessInfo, RemediationSuggestion } from "@/lib/types";

// `name` ของจอมอนิเตอร์มาจาก entry Win32_DesktopMonitor ของ Windows เอง —
// เป็นชื่อที่ resolve จาก driver/INF ที่ติดตั้งอยู่ ซึ่งถ้าจอใช้ driver
// generic ของ Windows (ไม่มี driver เฉพาะยี่ห้อ) จะได้ชื่อ "Generic PnP
// Monitor" เฉยๆ ไม่ว่าจอจริงจะเป็นรุ่นอะไร ส่วน `model`/`manufacturer` มา
// จากแหล่งข้อมูลที่น่าเชื่อถือกว่าคนละแหล่งเลย: ข้อมูล EDID ของจอเอง
// (query WmiMonitorID ใน internal/telemetry/devices_windows.go) ซึ่งเป็น
// identity จริงที่อ่านมาจากฮาร์ดแวร์ตรงๆ ใช้ค่านี้ก่อนเสมอถ้า resolve
// ออกมาได้ แทนที่จะใช้ label ทั่วไปจาก OS ป้องกันไม่ให้ได้ชื่อซ้ำซ้อนแบบ
// "HP HP 24f" ตอนที่ model string จาก EDID มีชื่อยี่ห้ออยู่แล้ว
function monitorLabel(d: DeviceInfo): string {
  if (d.model) {
    if (d.manufacturer && !d.model.toLowerCase().includes(d.manufacturer.toLowerCase())) {
      return `${d.manufacturer} ${d.model}`;
    }
    return d.model;
  }
  // บางครั้ง EDID resolve รหัสยี่ห้อได้ (WmiMonitorID.ManufacturerName) แต่
  // ไม่มี model string ที่ใช้ได้ (UserFriendlyName ว่างเปล่าในบางจอ) — ถึง
  // ข้อมูลจะได้แค่ครึ่งเดียวก็ยังเป็นข้อมูลจริง ยังดีกว่า label ทั่วไปจาก
  // OS
  if (d.manufacturer) return `${d.manufacturer} monitor`;
  return d.name;
}

const VERDICT_LABEL: Record<DeviceAnalysis["verdict"], { label: string; tone: "critical" | "warning" | "good" }> = {
  recommend_replacement: { label: "Recommend replacement", tone: "critical" },
  monitor: { label: "Keep monitoring", tone: "warning" },
  no_action_needed: { label: "No action needed", tone: "good" },
};

const RANGE_PRESETS: { label: string; hours: number }[] = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
];

const COMMAND_STATUS_TONE: Record<HistoryEntryStatus, { tone: "good" | "warning" | "critical" | "offline"; label: string }> = {
  succeeded: { tone: "good", label: "Succeeded" },
  failed: { tone: "critical", label: "Failed" },
  dispatched: { tone: "warning", label: "Running…" },
  offline: { tone: "offline", label: "Offline" },
};

interface RowState {
  killStatus?: "sending" | "sent" | "error";
  killMessage?: string;
  suggestion?: { loading: boolean; result?: RemediationSuggestion; error?: string };
}

type Tab = "chat" | "live" | "trend" | "commands" | "incidents";

interface ProcessManagerDrawerProps {
  // ต่างจาก `agent`: ทำให้ drawer เปิดในโหมด "แค่ AI console" แบบไม่มี
  // อุปกรณ์ได้ (เช่นสำหรับคำสั่งแบบ broadcast/กลุ่ม) โดยไม่ต้องเลือก
  // อุปกรณ์ใดเจาะจง
  open: boolean;
  agent: AgentSummary | null;
  agents: AgentSummary[];
  history: HistoryEntry[];
  onClose: () => void;
  // มีค่าเฉพาะหน้าที่เสนอ "ลงทะเบียนอุปกรณ์นี้เป็น asset" ได้ (ตอนนี้มีแค่
  // อุปกรณ์ที่ OS รายงาน serial จริง — จอมอนิเตอร์ผ่าน EDID) หน้าที่ไม่ส่ง
  // ค่านี้มาก็แค่ไม่ render action นี้
  onRegisterDevice?: (device: DeviceInfo, agent: AgentSummary) => void;
  // serial number ที่มี record asset อยู่แล้ว — อุปกรณ์ที่เชื่อมต่ออยู่และ
  // ตรงกับตัวใดตัวหนึ่งในนี้ เคยถูกเพิ่มเข้า Asset Registry ไปแล้วผ่านการ
  // กด "+ Add as asset" ก่อนหน้า (หรือลงทะเบียนมือไว้แล้ว) การเสนอปุ่มซ้ำ
  // ก็แค่ชวนให้สร้างรายการซ้ำ ถ้าไม่ส่งค่านี้มาหรือว่างเปล่า อุปกรณ์ทุกตัว
  // ที่มี serial จะได้ปุ่มตามปกติ
  registeredSerials?: Set<string>;
  // ผลลัพธ์แบบ real-time ของคำสั่ง network_diagnostic ที่กำลังทำงานอยู่
  // จาก useDashboardSocket() — ส่งต่อตรงเข้า ChatConsole ที่ฝังอยู่ ถ้าไม่
  // ส่งมาก็แค่ไม่ render ผลลัพธ์แบบ stream (ใช้ placeholder "waiting for
  // output…" ของ ChatConsole เองแทน)
  commandOutputs?: Record<string, StreamedCommandOutput>;
}

export function ProcessManagerDrawer({ open, agent, agents, history, onClose, onRegisterDevice, registeredSerials, commandOutputs }: ProcessManagerDrawerProps) {
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [activeTab, setActiveTab] = useState<Tab>(agent ? "chat" : "chat");
  const [rangeHours, setRangeHours] = useState(6);
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [killTarget, setKillTarget] = useState<ProcessInfo | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentsLoading, setIncidentsLoading] = useState(false);
  const [incidentsError, setIncidentsError] = useState<string | null>(null);
  const [report, setReport] = useState<{ report: DeviceReport; analysis: DeviceAnalysis } | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const agentId = agent?.agentId ?? null;

  // สลับกลับไปแท็บ Chat ทุกครั้งที่เปิดอุปกรณ์เครื่องอื่น — ถ้าค้างอยู่ที่
  // แท็บ Trend/Commands เก่าของอุปกรณ์ก่อนหน้าจะทำให้สับสน และแท็บ Chat
  // ใช้ได้เสมอไม่ว่าอุปกรณ์นี้จะมี telemetry แล้วหรือยัง
  useEffect(() => {
    setActiveTab("chat");
    setReport(null);
    setReportError(null);
  }, [agentId]);

  useEffect(() => {
    if (activeTab !== "trend" || !agentId) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    getHistory(agentId, rangeHours)
      .then((res) => {
        if (!cancelled) setHistoryPoints(res.points);
      })
      .catch((err) => {
        if (!cancelled) setHistoryError(err instanceof ApiError ? err.message : "Failed to load history.");
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, agentId, rangeHours]);

  useEffect(() => {
    if (activeTab !== "incidents" || !agentId) return;
    let cancelled = false;
    setIncidentsLoading(true);
    setIncidentsError(null);
    getIncidents(agentId)
      .then((res) => {
        if (!cancelled) setIncidents(res.incidents);
      })
      .catch((err) => {
        if (!cancelled) setIncidentsError(err instanceof ApiError ? err.message : "Failed to load incidents.");
      })
      .finally(() => {
        if (!cancelled) setIncidentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, agentId]);

  if (!open) return null;
  // ถือเป็นข้อมูล "live" ก็ต่อเมื่ออุปกรณ์ online อยู่จริงตอนนี้เท่านั้น
  // — ไม่งั้นจะแสดงรายการ process/มิเตอร์ล่าสุดที่รู้ก่อนตัดการเชื่อมต่อ
  // ราวกับเป็นข้อมูลปัจจุบัน ซึ่งทำให้เข้าใจผิดได้ (process ที่ขึ้นว่า
  // "running" ตรงนี้อาจปิดไปแล้วหลายนาทีก่อนอุปกรณ์หลุด หรือทั้งเครื่อง
  // อาจถูกปิดไปแล้วก็ได้)
  const isOnline = agent?.status === "online";
  const snap = isOnline ? (agent?.lastTelemetry ?? null) : null;
  const processes = [...(snap?.top_processes ?? [])].sort((a, b) => b.cpu_percent - a.cpu_percent);
  // agent เวอร์ชันเก่า (และ telemetry ที่ cache ไว้จากก่อนมี local_users/
  // current_user) ไม่เคยส่ง field พวกนี้มาเลย — เป็น undefined ไม่ใช่
  // array ว่าง จึงสมมติว่ามีอยู่เสมอแบบ field ที่มีมาตั้งแต่แรกไม่ได้
  const localUsers = snap?.local_users ?? [];
  // ป้องกันเหตุผลเดียวกับ localUsers ด้านบน — เป็น field เก่าเหมือนกัน
  // แต่ collector ฝั่ง Go ของมันเคยคืนค่า nil slice เปล่าๆ เวลาทำงาน
  // ล้มเหลวชั่วคราว (WMI query error, disk-enumeration error, ...) ซึ่ง
  // serialize ออกมาเป็น JSON null ไม่ใช่ [] แก้ที่ฝั่ง agent แล้วก็จริง
  // แต่ตรงนี้ยังกันไว้สำหรับ snapshot ที่เก็บ/cache ไว้ก่อนแก้ และกัน bug
  // แบบเดิมย้อนกลับมาในอนาคตด้วย
  const physicalDisks = snap?.physical_disks ?? [];
  const disks = snap?.disks ?? [];
  const connectedDevices = snap?.connected_devices ?? [];
  const commandEntries = agentId ? history.filter((h) => h.agentId === agentId) : [];

  // ใช้ key เป็น agentId:pid ไม่ใช่ pid เฉยๆ — PID เพียวๆ ไม่ซ้ำแค่ภายใน
  // อุปกรณ์เดียว แต่เลข PID ซ้ำกันข้ามเครื่องได้บ่อยมาก ถ้าไม่มีส่วน
  // agentId พอสลับไปอุปกรณ์อื่นที่บังเอิญใช้ PID ซ้ำ จะเห็นสถานะ "kill
  // sent" / คำแนะนำ AI เก่าจากอุปกรณ์ก่อนหน้าราวกับใช้กับเครื่องใหม่
  function rowKey(pid: number): string {
    return `${agentId}:${pid}`;
  }

  function patchRow(pid: number, patch: RowState): void {
    const key = rowKey(pid);
    setRowState((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function requestForceClose(proc: ProcessInfo): void {
    setKillTarget(proc);
  }

  async function confirmForceClose(): Promise<void> {
    if (!agent || !killTarget) return;
    const proc = killTarget;
    patchRow(proc.pid, { killStatus: "sending", killMessage: undefined });
    setKillTarget(null);
    try {
      const res = await killProcess(agent.agentId, { pid: proc.pid });
      const delivered = res.results[0]?.dispatched ?? false;
      patchRow(proc.pid, {
        killStatus: delivered ? "sent" : "error",
        killMessage: delivered ? "Kill command sent." : "Device is offline — command not delivered.",
      });
    } catch (err) {
      patchRow(proc.pid, {
        killStatus: "error",
        killMessage: err instanceof ApiError ? err.message : "Failed to send kill command.",
      });
    }
  }

  async function handleAnalyze(): Promise<void> {
    if (!agentId) return;
    setReportLoading(true);
    setReportError(null);
    try {
      const res = await getDeviceReport(agentId);
      setReport(res);
    } catch (err) {
      setReportError(err instanceof ApiError ? err.message : "Failed to generate report.");
    } finally {
      setReportLoading(false);
    }
  }

  async function handleSuggest(proc: ProcessInfo): Promise<void> {
    if (!agent) return;
    patchRow(proc.pid, { suggestion: { loading: true } });
    try {
      const { suggestion } = await suggestRemediation(agent.agentId, proc.pid);
      patchRow(proc.pid, { suggestion: { loading: false, result: suggestion } });
    } catch (err) {
      patchRow(proc.pid, {
        suggestion: { loading: false, error: err instanceof ApiError ? err.message : "Failed to get a suggestion." },
      });
    }
  }

  const tabs: { key: Tab; label: string }[] = agent
    ? [
        { key: "chat", label: "AI Console" },
        { key: "live", label: "Live" },
        { key: "trend", label: "Trend" },
        { key: "commands", label: "Commands" },
        { key: "incidents", label: "Incidents" },
      ]
    : [{ key: "chat", label: "AI Console" }];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close process manager"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <aside className="relative z-50 flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-border bg-surface shadow-xl">
        <header className="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-ink-primary">{agent ? agent.agentId : "AI Console"}</h2>
            {agent && (
              <div className="mt-1 flex items-center gap-2">
                <StatusBadge tone={agent.status === "offline" ? "offline" : "good"} label={agent.status === "offline" ? "Offline" : "Online"} />
                <span className="text-xs text-ink-muted">Last seen {formatRelativeTime(agent.lastSeenAt)}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
          >
            Close
          </button>
        </header>

        <div className="flex gap-1 border-b border-border px-5 pt-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`rounded-t-md px-3 py-1.5 text-xs font-medium ${
                activeTab === t.key ? "border-b-2 border-accent text-ink-primary" : "text-ink-muted hover:text-ink-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === "chat" ? (
          <div className="min-h-0 flex-1">
            {/* ใช้ key แยกตามอุปกรณ์: drawer นี้ยัง mount ค้างอยู่ตอนสลับ
                อุปกรณ์ (ไม่มีการปิด/เปิดคั่นกลาง) ถ้าไม่มี key React จะใช้
                ChatConsole instance เดิมซ้ำ ทำให้ dropdown scope และ
                history ที่ดึงมาแสดงค้างอยู่ที่อุปกรณ์แรกที่เลือกไว้ */}
            <ChatConsole key={agentId ?? "none"} agents={agents} defaultScope={agentId ?? undefined} history={history} commandOutputs={commandOutputs} />
          </div>
        ) : activeTab === "trend" ? (
          <section className="flex-1 overflow-y-auto px-5 py-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-ink-primary">CPU / RAM / Disk trend</h3>
              <div className="flex gap-1">
                {RANGE_PRESETS.map((r) => (
                  <button
                    key={r.hours}
                    type="button"
                    onClick={() => setRangeHours(r.hours)}
                    className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
                      rangeHours === r.hours
                        ? "border-accent bg-accent text-white"
                        : "border-border text-ink-secondary hover:bg-gridline/40"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            {historyLoading ? (
              <p className="py-6 text-center text-sm text-ink-muted">Loading…</p>
            ) : historyError ? (
              <p className="py-6 text-center text-sm text-status-critical">{historyError}</p>
            ) : (
              <HistoryChart points={historyPoints} />
            )}

            <div className="mt-6 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-ink-primary">Device report &amp; replacement analysis</h3>
                <button
                  type="button"
                  onClick={handleAnalyze}
                  disabled={reportLoading}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-ink-secondary hover:bg-gridline/40 disabled:opacity-50"
                >
                  {reportLoading ? "Analyzing…" : "Should we replace this PC?"}
                </button>
              </div>

              {reportError && <p className="mt-3 text-xs text-status-critical">{reportError}</p>}

              {report && (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                    <div className="rounded-md border border-border p-2">
                      <p className="text-ink-muted">Avg CPU ({report.report.windowDays}d)</p>
                      <p className="tabular text-sm font-medium text-ink-primary">{report.report.avgCpuPercent.toFixed(1)}%</p>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <p className="text-ink-muted">Avg RAM ({report.report.windowDays}d)</p>
                      <p className="tabular text-sm font-medium text-ink-primary">{report.report.avgMemPercent.toFixed(1)}%</p>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <p className="text-ink-muted">Worst disk</p>
                      <p className="tabular text-sm font-medium text-ink-primary">
                        {report.report.worstDiskUsedPercent !== null ? `${report.report.worstDiskUsedPercent.toFixed(1)}%` : "—"}
                      </p>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <p className="text-ink-muted">Not-responding events</p>
                      <p className="tabular text-sm font-medium text-ink-primary">{report.report.incidentCount}</p>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <p className="text-ink-muted">Model</p>
                      <p className="truncate text-sm font-medium text-ink-primary">{report.report.model || "—"}</p>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <p className="text-ink-muted">Samples</p>
                      <p className="tabular text-sm font-medium text-ink-primary">{report.report.sampleCount}</p>
                    </div>
                  </div>

                  <div className="rounded-md border border-border bg-page p-3">
                    <StatusBadge tone={VERDICT_LABEL[report.analysis.verdict].tone} label={VERDICT_LABEL[report.analysis.verdict].label} />
                    <p className="mt-2 text-sm text-ink-secondary">{report.analysis.reasoning}</p>
                    <p className="mt-1 text-xs text-ink-muted">{report.analysis.note}</p>
                  </div>
                </div>
              )}
            </div>
          </section>
        ) : activeTab === "commands" ? (
          <section className="flex-1 overflow-y-auto">
            {commandEntries.length === 0 ? (
              <p className="p-5 text-sm text-ink-muted">No commands dispatched to this device yet.</p>
            ) : (
              <ul className="divide-y divide-gridline">
                {commandEntries.map((entry) => {
                  const status = COMMAND_STATUS_TONE[entry.status];
                  return (
                    <li key={entry.commandId} className="px-5 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink-primary">
                            <span className="font-mono">{entry.action}</span>
                          </p>
                          {entry.sourceText && <p className="truncate text-xs text-ink-muted">“{entry.sourceText}”</p>}
                          {entry.message && <p className="mt-0.5 truncate text-xs text-ink-secondary">{entry.message}</p>}
                        </div>
                        <StatusBadge tone={status.tone} label={status.label} />
                      </div>
                      <p className="mt-1 text-[11px] text-ink-muted">
                        {entry.requestedBy} · {formatRelativeTime(entry.dispatchedAt)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : activeTab === "incidents" ? (
          <section className="flex-1 overflow-y-auto">
            {incidentsLoading ? (
              <p className="p-5 text-sm text-ink-muted">Loading…</p>
            ) : incidentsError ? (
              <p className="p-5 text-sm text-status-critical">{incidentsError}</p>
            ) : incidents.length === 0 ? (
              <p className="p-5 text-sm text-ink-muted">No incidents recorded for this device.</p>
            ) : (
              <ul className="divide-y divide-gridline">
                {incidents.map((inc) => (
                  <li key={inc.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-ink-primary">{inc.message}</p>
                      <StatusBadge tone={inc.resolvedAt ? "good" : "critical"} label={inc.resolvedAt ? "Resolved" : "Ongoing"} />
                    </div>
                    <p className="mt-1 text-[11px] text-ink-muted">
                      Started {formatRelativeTime(new Date(inc.occurredAt).getTime())}
                      {inc.resolvedAt ? ` · resolved ${formatRelativeTime(new Date(inc.resolvedAt).getTime())}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : snap ? (
          <div className="flex-1 overflow-y-auto">
            <section className="border-b border-border px-5 py-4">
              <h3 className="mb-3 font-semibold text-ink-primary">Specs</h3>
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                <div>
                  <p className="text-ink-muted">CPU</p>
                  <p className="truncate text-sm font-medium text-ink-primary" title={snap.cpu_model || undefined}>
                    {snap.cpu_model || "—"}
                  </p>
                </div>
                <div>
                  <p className="text-ink-muted">RAM</p>
                  <p className="text-sm font-medium text-ink-primary">{formatMb(snap.mem_total_mb)}</p>
                </div>
                <div>
                  <p className="text-ink-muted">Current user</p>
                  <p className="truncate text-sm font-medium text-ink-primary" title={snap.current_user || undefined}>
                    {snap.current_user || "Not logged in"}
                  </p>
                </div>
              </div>
              {physicalDisks.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {physicalDisks.map((d, i) => (
                    <span
                      key={i}
                      title={d.model || undefined}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-page px-2 py-1 text-xs text-ink-secondary"
                    >
                      {d.size_gb.toFixed(0)} GB {d.media_type}
                      {d.model && <span className="text-ink-muted"> · {d.model}</span>}
                    </span>
                  ))}
                </div>
              )}
            </section>

            <section className="grid grid-cols-1 gap-3 border-b border-border px-5 py-4 sm:grid-cols-2">
              <Meter label="CPU" percent={snap.cpu_percent} />
              <Meter label="RAM" percent={snap.mem_percent} detail={`${formatMb(snap.mem_used_mb)} / ${formatMb(snap.mem_total_mb)}`} />
              {disks.map((d) => (
                <Meter key={d.mount_point} label={`Disk (${d.mount_point})`} percent={d.used_percent} detail={`${d.free_gb.toFixed(1)} GB free`} />
              ))}
            </section>

            <section className="border-b border-border px-5 py-4">
              <h3 className="mb-3 font-semibold text-ink-primary">
                Connected devices
                <span className="ml-1.5 font-normal text-ink-muted">({connectedDevices.length})</span>
              </h3>
              {connectedDevices.length === 0 ? (
                <p className="text-xs text-ink-muted">No devices reported.</p>
              ) : (
                <div className="space-y-3">
                  {(["monitor", "printer", "usb"] as const).map((type) => {
                    const items = connectedDevices.filter((d) => d.type === type);
                    if (items.length === 0) return null;
                    return (
                      <div key={type}>
                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                          {type === "usb" ? "USB" : type === "printer" ? "Printers" : "Monitors"} ({items.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {items.map((d, i) => {
                            const label = d.type === "monitor" ? monitorLabel(d) : d.name;
                            return (
                            <span
                              key={`${d.name}-${i}`}
                              title={d.detail || label}
                              className="flex items-center gap-1.5 rounded-md border border-border bg-page px-2 py-1 text-xs text-ink-secondary"
                            >
                              {label}
                              {d.detail && <span className="text-ink-muted"> · {d.detail}</span>}
                              {d.type === "monitor" && d.serial_number && <span className="text-ink-muted"> · SN {d.serial_number}</span>}
                              {d.serial_number && registeredSerials?.has(d.serial_number) ? (
                                <span className="rounded bg-status-good/10 px-1.5 py-0.5 text-[11px] font-medium text-status-good">
                                  Registered
                                </span>
                              ) : (
                                onRegisterDevice &&
                                agent &&
                                d.serial_number && (
                                  <button
                                    type="button"
                                    onClick={() => onRegisterDevice(d, agent)}
                                    className="rounded border border-accent px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent hover:text-white"
                                    title={`Register as asset (SN ${d.serial_number})`}
                                  >
                                    + Add as asset
                                  </button>
                                )
                              )}
                            </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="border-b border-border px-5 py-4">
              <h3 className="mb-3 font-semibold text-ink-primary">
                Local user accounts
                <span className="ml-1.5 font-normal text-ink-muted">({localUsers.length})</span>
              </h3>
              {localUsers.length === 0 ? (
                <p className="text-xs text-ink-muted">No local accounts reported.</p>
              ) : (
                <div className="space-y-1.5">
                  {localUsers.map((u) => (
                    <div key={u.username} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                      <span className={`font-medium ${u.disabled ? "text-ink-muted line-through" : "text-ink-primary"}`}>{u.username}</span>
                      {u.full_name && u.full_name !== u.username && <span className="text-ink-muted">{u.full_name}</span>}
                      <span className="flex-1" />
                      {u.is_admin && (
                        <span className="rounded bg-status-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-status-warning">Admin</span>
                      )}
                      {u.disabled && (
                        <span className="rounded bg-status-critical/10 px-1.5 py-0.5 text-[11px] font-medium text-status-critical">Disabled</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="px-5 py-4">
              <h3 className="mb-3 font-semibold text-ink-primary">Running processes</h3>
              <div className="space-y-2">
                {processes.map((proc) => {
                  const state = rowState[rowKey(proc.pid)] ?? {};
                  return (
                    <div key={proc.pid} className="rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink-primary">
                            {proc.name}
                            {!proc.responding && <StatusBadge tone="critical" label="Not responding" />}
                          </p>
                          <p className="tabular text-xs text-ink-muted">
                            PID {proc.pid} · {proc.cpu_percent.toFixed(1)}% CPU · {formatMb(proc.mem_mb)}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <button
                            type="button"
                            onClick={() => handleSuggest(proc)}
                            disabled={state.suggestion?.loading}
                            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-gridline/40 disabled:opacity-50"
                          >
                            {state.suggestion?.loading ? "Thinking…" : "AI suggestion"}
                          </button>
                          <button
                            type="button"
                            onClick={() => requestForceClose(proc)}
                            disabled={state.killStatus === "sending"}
                            className="rounded-md bg-status-critical px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                          >
                            Force close
                          </button>
                        </div>
                      </div>

                      {state.killMessage && (
                        <p className={`mt-2 text-xs ${state.killStatus === "error" ? "text-status-critical" : "text-status-good"}`}>
                          {state.killMessage}
                        </p>
                      )}

                      {state.suggestion?.result && (
                        <div className="mt-2 rounded-md border border-border bg-page p-2.5 text-xs">
                          <p className="font-medium text-ink-primary">
                            AI recommends: {state.suggestion.result.suggested_action === "kill_process" ? "Force close" : "Keep monitoring"}
                          </p>
                          <p className="mt-1 text-ink-secondary">{state.suggestion.result.reasoning}</p>
                          <p className="mt-1 text-ink-muted">{state.suggestion.result.risk_note}</p>
                          {state.suggestion.result.suggested_action === "kill_process" && (
                            <button
                              type="button"
                              onClick={() => requestForceClose(proc)}
                              disabled={state.killStatus === "sending"}
                              className="mt-2 rounded-md bg-status-critical px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                            >
                              Apply: force close
                            </button>
                          )}
                        </div>
                      )}
                      {state.suggestion?.error && (
                        <p className="mt-2 text-xs text-status-critical">{state.suggestion.error}</p>
                      )}
                    </div>
                  );
                })}
                {processes.length === 0 && <p className="text-sm text-ink-muted">No process data reported.</p>}
              </div>
            </section>
          </div>
        ) : (
          <p className="px-5 py-4 text-sm text-ink-muted">
            {agent && !isOnline ? "Device is offline — live processes, meters, and connected devices aren't shown while disconnected." : "No telemetry received from this device yet."}
          </p>
        )}
      </aside>

      <ConfirmDialog
        open={killTarget !== null}
        title="Force close this process?"
        message={killTarget ? `"${killTarget.name}" (PID ${killTarget.pid}) on ${agent?.agentId}.\nUnsaved work in this process will be lost.` : ""}
        confirmLabel="Force close"
        tone="danger"
        onConfirm={confirmForceClose}
        onCancel={() => setKillTarget(null)}
      />
    </div>
  );
}
