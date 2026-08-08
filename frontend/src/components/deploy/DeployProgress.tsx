"use client";

import { useEffect, useRef, useState } from "react";
import type { StreamedCommandOutput } from "@/hooks/useDashboardSocket";

// Parses the STATUS:/PROGRESS: lines internal/executor's runScript streams
// live out of a command's stdout/stderr into a stage + percent — everything
// else is just shown as raw log output underneath, for anyone who wants the
// actual script transcript instead of the summary. Shared by every page
// that dispatches a run_script and wants live feedback (Software Deploy,
// Uninstall Software) rather than each re-implementing the same parsing.
export function parseProgress(output: StreamedCommandOutput | undefined): { stage: string | null; percent: number | null } {
  let stage: string | null = null;
  let percent: number | null = null;
  for (const line of output?.lines ?? []) {
    const statusMatch = /^STATUS:(\w+)$/.exec(line);
    if (statusMatch) stage = statusMatch[1]!;
    const progressMatch = /^PROGRESS:(\d+)$/.exec(line);
    if (progressMatch) percent = Number(progressMatch[1]);
  }
  return { stage, percent };
}

const STAGE_LABELS: Record<string, string> = {
  downloading: "Downloading…",
  installing: "Installing…",
  uninstalling: "Uninstalling…",
  done: "Done",
};

// Neither "installing" nor "uninstalling" has anything real to measure —
// no silent installer (Ninite's or a vendor's own) reports its own percent
// complete, unlike the download step's byte count. A bare indeterminate
// pulse with no number at all read as "is this even doing anything?", so
// this fills the gap with an honest-looking estimate instead: fast at
// first, slowing as it approaches a 92% ceiling it can never claim to
// reach on its own (only the real "done" event can ever call this 100%),
// asymptotic so it never looks stalled the way a linear ramp would once it
// runs longer than expected. `active` gates it so the timer/state resets
// cleanly between one dispatch and the next rather than carrying over a
// stale clock.
export function useSimulatedProgress(active: boolean): number {
  const [percent, setPercent] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setPercent(0);
      startRef.current = null;
      return;
    }
    startRef.current = Date.now();
    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - startRef.current!) / 1000;
      setPercent(Math.min(92, Math.round(92 * (1 - Math.exp(-elapsedSeconds / 8)))));
    }, 250);
    return () => clearInterval(interval);
  }, [active]);

  return percent;
}

// The one source of truth for "what percent is currently showing" — real
// download bytes during that stage, the simulated estimate otherwise, null
// once there's a final result or nothing dispatched yet. Callers that want
// to echo the same number outside DeployProgress itself (a Deploy/Uninstall
// button's own label, so it doesn't show a different figure than the bar
// right below it) use this instead of re-deriving it their own way.
export function useDeployPercent(commandId: string | null, output: StreamedCommandOutput | undefined): number | null {
  const { stage, percent: realPercent } = parseProgress(output);
  const isDownloading = stage === "downloading";
  const waitingForResult = Boolean(commandId) && !output?.done;
  const simulatedPercent = useSimulatedProgress(waitingForResult && !isDownloading);

  if (!commandId || output?.done) return null;
  return isDownloading ? realPercent : simulatedPercent;
}

export function DeployProgress({ commandId, output }: { commandId: string | null; output: StreamedCommandOutput | undefined }) {
  const percent = useDeployPercent(commandId, output);
  const { stage } = parseProgress(output);

  if (!commandId) return null;

  if (output?.done) {
    return output.error ? (
      <p className="text-sm text-status-critical">✗ Failed: {output.error}</p>
    ) : (
      <p className="text-sm text-status-good">✓ Completed successfully.</p>
    );
  }

  const label = (stage && STAGE_LABELS[stage]) ?? "Waiting for the device to pick this up…";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs text-ink-secondary">
        <span>{label}</span>
        {percent !== null && <span className="font-mono tabular-nums">{percent}%</span>}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gridline">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent ?? 0}%` }} />
      </div>
      {output && output.lines.length > 0 && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer select-none">Raw output</summary>
          <pre className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-page p-2">
            {output.lines.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
