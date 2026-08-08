// Formatting + threshold helpers shared by the meters, cards, and tables.

export type Severity = "good" | "warning" | "critical";

// Thresholds intentionally match the Go agent's own alert-mode trigger
// (internal/telemetry/poller.go: cpu/mem >= 85% -> alert mode) — the
// dashboard's "critical" tier lines up with the exact point the agent
// itself starts polling more aggressively, so the UI and the agent agree
// on what "trouble" means.
export function severityForPercent(percent: number): Severity {
  if (percent >= 85) return "critical";
  if (percent >= 70) return "warning";
  return "good";
}

export function formatPercent(value: number): string {
  return `${value.toFixed(0)}%`;
}

export function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export function formatGb(gb: number): string {
  return `${gb.toFixed(1)} GB`;
}

export function formatRelativeTime(unixMs: number): string {
  const deltaSeconds = Math.round((Date.now() - unixMs) / 1000);
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
