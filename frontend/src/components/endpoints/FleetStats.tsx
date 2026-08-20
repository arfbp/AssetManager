import type { AgentSummary } from "@/lib/types";

type Tone = "primary" | "good" | "critical" | "muted";

const VALUE_TONE: Record<Tone, string> = {
  primary: "text-ink-primary",
  good: "text-status-good",
  critical: "text-status-critical",
  muted: "text-ink-muted",
};

const ICON_WRAP_TONE: Record<Tone, string> = {
  primary: "bg-accent/10 text-accent",
  good: "bg-status-good/10 text-status-good",
  critical: "bg-status-critical/10 text-status-critical",
  muted: "bg-ink-muted/10 text-ink-muted",
};

const BAR_TONE: Record<Tone, string> = {
  primary: "bg-accent",
  good: "bg-status-good",
  critical: "bg-status-critical",
  muted: "bg-ink-muted",
};

// ตัว scanner แบบ JIT ของ Tailwind ต้องการ class string ที่เขียนตรงๆ
// จะสร้างจาก runtime ไม่ได้ — ถ้าเขียนแบบ template `border-l-status-${tone}`
// จะไม่ได้ style อะไรเลยแบบเงียบๆ เพราะไม่มี class name ที่ตรงตัวปรากฏให้
// Tailwind หาเจอ
const HIGHLIGHT_BORDER_TONE: Record<Tone, string> = {
  primary: "border-l-accent",
  good: "border-l-status-good",
  critical: "border-l-status-critical",
  muted: "border-l-ink-muted",
};

interface StatTileProps {
  label: string;
  value: number;
  tone?: Tone;
  icon: string;
  trend: string;
  barPercent: number;
  highlight?: boolean;
}

const TREND_PILL_TONE: Record<Tone, string> = {
  primary: "bg-accent/10 text-accent",
  good: "bg-status-good/10 text-status-good",
  critical: "bg-status-critical/10 text-status-critical",
  muted: "bg-ink-muted/10 text-ink-muted",
};

function StatTile({ label, value, tone = "primary", icon, trend, barPercent, highlight }: StatTileProps) {
  return (
    <div className={`glass-card flex flex-col rounded-xl p-card-padding ${highlight ? `border-l-4 ${HIGHLIGHT_BORDER_TONE[tone]}` : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${ICON_WRAP_TONE[tone]}`}>
          <span className="material-symbols-outlined text-[22px]">{icon}</span>
        </span>
        <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold leading-none ${TREND_PILL_TONE[tone]}`}>{trend}</span>
      </div>
      <p className="mt-3 text-xs font-medium text-ink-secondary">{label}</p>
      <p className="tabular mt-0.5 text-3xl font-bold text-ink-primary">{value}</p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-primary/10">
        <div className={`h-full rounded-full ${BAR_TONE[tone]}`} style={{ width: `${Math.max(barPercent, 3)}%` }} />
      </div>
    </div>
  );
}

/** จำนวน online/offline/alert รวมทั้งฟลีต — ใช้ร่วมกันทั้งหน้า Dashboard overview และหน้า Devices เพื่อไม่ให้วิธีคำนวณตัวเลขเพี้ยนไปคนละแบบ */
export function FleetStats({ agents }: { agents: AgentSummary[] }) {
  const total = agents.length;
  const online = agents.filter((a) => a.status === "online").length;
  const offline = total - online;
  const inAlert = agents.filter((a) => a.lastTelemetry?.mode === "alert").length;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Total devices" value={total} icon="computer" trend="Fleet" barPercent={100} />
      <StatTile
        label="Online"
        value={online}
        tone="good"
        icon="sensors"
        trend={total > 0 ? `${Math.round((online / total) * 100)}%` : "—"}
        barPercent={total > 0 ? (online / total) * 100 : 0}
      />
      <StatTile
        label="Offline"
        value={offline}
        tone={offline > 0 ? "muted" : "good"}
        icon="power_off"
        trend={offline > 0 ? "Check" : "Clear"}
        barPercent={total > 0 ? (offline / total) * 100 : 0}
      />
      <StatTile
        label="In alert"
        value={inAlert}
        tone={inAlert > 0 ? "critical" : "good"}
        icon="warning"
        trend={inAlert > 0 ? "Attention" : "Normal"}
        barPercent={total > 0 ? (inAlert / total) * 100 : 0}
        highlight={inAlert > 0}
      />
    </div>
  );
}
