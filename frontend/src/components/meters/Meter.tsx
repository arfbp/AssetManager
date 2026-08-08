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
 * Fill carries severity; the unfilled track is a neutral, one-step-off-
 * surface gray so state reads from the fill alone — see the dataviz
 * skill's meter spec. Severity is never color-only: the numeric value is
 * always printed beside it.
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
