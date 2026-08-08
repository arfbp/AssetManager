type Tone = "good" | "warning" | "critical" | "offline";

const DOT_CLASS: Record<Tone, string> = {
  good: "bg-status-good",
  warning: "bg-status-warning",
  critical: "bg-status-critical",
  offline: "bg-status-offline",
};

const TEXT_CLASS: Record<Tone, string> = {
  good: "text-status-good",
  warning: "text-status-warning",
  critical: "text-status-critical",
  offline: "text-ink-muted",
};

/**
 * Status is never color-alone: every badge pairs the dot with a text label.
 * Reused for both connection status (online/offline) and telemetry
 * severity (good/warning/critical) — same visual language throughout.
 */
export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs font-medium">
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[tone]}`} aria-hidden="true" />
      <span className={TEXT_CLASS[tone]}>{label}</span>
    </span>
  );
}
