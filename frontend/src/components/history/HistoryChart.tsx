"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";
import type { HistoryPoint } from "@/lib/types";

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 34;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;
const GRID_STEPS = [0, 25, 50, 75, 100];

interface Series {
  key: string;
  label: string;
  colorVar: string;
  values: (number | null)[];
}

/**
 * CPU/RAM/Disk trend for one device — all three are percentages sharing one
 * 0-100 axis, so this is a single-axis multi-line chart, never dual-axis
 * (see the dataviz skill's anti-patterns.md). Series color is assigned in a
 * fixed order (CPU, RAM, then each disk mount point alphabetically) and
 * never reassigned when the data changes, per the skill's categorical rule.
 *
 * A table view exists alongside the chart (toggle below) so every value is
 * reachable as text — this is also the mitigation for the reference
 * palette's own documented light-mode contrast warning on a few categorical
 * slots (aqua/yellow/magenta): identity never depends on hue alone here.
 */
export function HistoryChart({ points }: { points: HistoryPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const diskMounts = useMemo(() => {
    const set = new Set<string>();
    for (const p of points) for (const d of p.disks) set.add(d.mount_point);
    return [...set].sort();
  }, [points]);

  const series: Series[] = useMemo(() => {
    const list: Series[] = [
      { key: "cpu", label: "CPU", colorVar: "var(--series-1)", values: points.map((p) => p.cpuPercent) },
      { key: "mem", label: "RAM", colorVar: "var(--series-2)", values: points.map((p) => p.memPercent) },
    ];
    diskMounts.forEach((mount, i) => {
      list.push({
        key: `disk-${mount}`,
        label: `Disk (${mount})`,
        // Slots 1-2 are taken by CPU/RAM; disks continue the same fixed
        // order from slot 3 onward, wrapping past slot 8 only if a device
        // somehow has more than six partitions.
        colorVar: `var(--series-${3 + (i % 6)})`,
        values: points.map((p) => p.disks.find((d) => d.mount_point === mount)?.used_percent ?? null),
      });
    });
    return list;
  }, [points, diskMounts]);

  if (points.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-ink-muted">No historical data yet for this range.</p>;
  }

  const times = points.map((p) => new Date(p.recordedAt).getTime());
  const tMin = times[0]!;
  const tMax = times[times.length - 1]!;
  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  function xFor(i: number): number {
    if (tMax === tMin) return PAD_LEFT + plotW / 2;
    return PAD_LEFT + ((times[i]! - tMin) / (tMax - tMin)) * plotW;
  }
  function yFor(v: number): number {
    return PAD_TOP + (1 - v / 100) * plotH;
  }

  function pathFor(values: (number | null)[]): string {
    let d = "";
    let started = false;
    values.forEach((v, i) => {
      if (v === null) {
        started = false;
        return;
      }
      d += `${started ? "L" : "M"}${xFor(i).toFixed(1)},${yFor(v).toFixed(1)} `;
      started = true;
    });
    return d.trim();
  }

  function handlePointerMove(e: PointerEvent<SVGSVGElement>): void {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dist = Math.abs(xFor(i) - x);
      if (dist < best) {
        best = dist;
        nearest = i;
      }
    }
    setHoverIdx(nearest);
  }

  const hover = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-xs text-ink-secondary">
              <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: s.colorVar }} aria-hidden="true" />
              {s.label}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-ink-secondary hover:bg-gridline/40"
        >
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {showTable ? (
        <div className="max-h-64 overflow-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-ink-muted">
                <th className="px-2 py-1.5 font-normal">Time</th>
                {series.map((s) => (
                  <th key={s.key} className="px-2 py-1.5 font-normal">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {points
                .map((p, i) => (
                  <tr key={p.recordedAt} className="border-t border-border">
                    <td className="px-2 py-1 text-ink-secondary">{new Date(p.recordedAt).toLocaleString()}</td>
                    {series.map((s) => (
                      <td key={s.key} className="px-2 py-1 text-ink-primary">
                        {s.values[i] === null ? "—" : `${s.values[i]!.toFixed(1)}%`}
                      </td>
                    ))}
                  </tr>
                ))
                .reverse()}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="w-full"
            style={{ minWidth: 420 }}
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHoverIdx(null)}
          >
            {GRID_STEPS.map((g) => (
              <g key={g}>
                <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={yFor(g)} y2={yFor(g)} stroke="var(--gridline)" strokeWidth={1} />
                <text x={PAD_LEFT - 6} y={yFor(g)} textAnchor="end" dominantBaseline="middle" fill="var(--text-muted)" fontSize={9}>
                  {g}
                </text>
              </g>
            ))}

            {series.map((s) => (
              <path key={s.key} d={pathFor(s.values)} fill="none" stroke={s.colorVar} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            ))}

            {hoverIdx !== null && (
              <line x1={xFor(hoverIdx)} x2={xFor(hoverIdx)} y1={PAD_TOP} y2={HEIGHT - PAD_BOTTOM} stroke="var(--text-muted)" strokeWidth={1} />
            )}
          </svg>

          <div className="mt-1 min-h-[52px] rounded-md border border-border bg-page px-2.5 py-1.5 text-[11px]">
            {hover ? (
              <>
                <p className="text-ink-muted">{new Date(hover.recordedAt).toLocaleString()}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {series.map((s) => (
                    <span key={s.key} className="tabular flex items-center gap-1">
                      <span className="inline-block h-0.5 w-2.5 rounded-full" style={{ backgroundColor: s.colorVar }} aria-hidden="true" />
                      <span className="text-ink-secondary">{s.label}</span>
                      <span className="font-medium text-ink-primary">
                        {s.values[hoverIdx!] === null ? "—" : `${s.values[hoverIdx!]!.toFixed(1)}%`}
                      </span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-ink-muted">Hover the chart for values at a point in time.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
