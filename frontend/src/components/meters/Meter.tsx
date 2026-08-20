import { severityForPercent, formatPercent, type Severity } from "@/lib/format";

const FILL_CLASS: Record<Severity, string> = {
  good: "bg-status-good",
  warning: "bg-status-warning",
  critical: "bg-status-critical",
};

interface MeterProps {
  label: string;
  percent: number;
  detail?: string;
}

/**
 * ส่วนที่เติมสีบอกระดับความรุนแรง ส่วนรางที่ยังไม่เติมใช้สีเทากลางๆ ห่าง
 * จากพื้นหลังแค่หนึ่งระดับ เพื่อให้สถานะอ่านจากส่วนที่เติมสีอย่างเดียวได้
 * ความรุนแรงไม่ใช้สีอย่างเดียวบอก เสมอมีตัวเลขกำกับไว้ข้างๆ ด้วย เพื่อให้
 * อ่านค่าได้แม้แยกสีไม่ออก
 */
export function Meter({ label, percent, detail }: MeterProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const severity = severityForPercent(clamped);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs text-ink-secondary">{label}</span>
        <span className="tabular text-xs font-semibold text-ink-primary">{formatPercent(clamped)}</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-ink-primary/10"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${FILL_CLASS[severity]}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {detail && <p className="mt-0.5 text-[11px] text-ink-muted">{detail}</p>}
    </div>
  );
}
