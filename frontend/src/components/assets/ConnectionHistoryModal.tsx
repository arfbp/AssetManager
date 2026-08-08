"use client";

import { useEffect, useState } from "react";
import { ApiError, getConnectionHistory } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import type { ConnectionHistoryEntry } from "@/lib/types";

interface ConnectionHistoryModalProps {
  assetTag: string;
  onClose: () => void;
}

// Every computer this peripheral asset has actually been connected through
// over time (server/src/assets/connectionHistoryStore.ts) — distinct from
// the asset's own parentAgentId field, which only ever remembers the most
// recent one. Opens on demand rather than being preloaded with the asset
// list, since most assets never need it looked at.
export function ConnectionHistoryModal({ assetTag, onClose }: ConnectionHistoryModalProps) {
  const [entries, setEntries] = useState<ConnectionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConnectionHistory(assetTag)
      .then((res) => {
        if (!cancelled) setEntries(res.entries);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load connection history.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetTag]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-xl">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-primary">Connection history — {assetTag}</h2>
          <button type="button" onClick={onClose} className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40">
            Close
          </button>
        </div>

        <div className="mt-4 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <p className="text-sm text-ink-muted">Loading…</p>
          ) : error ? (
            <p className="text-sm text-status-critical">{error}</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-ink-muted">No connection history recorded yet for this asset.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry, i) => (
                <li key={`${entry.agentId}-${entry.connectedAt}-${i}`} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink-primary">{entry.agentId}</p>
                    {!entry.disconnectedAt && (
                      <span className="rounded-full bg-status-good/10 px-2 py-0.5 text-[11px] font-medium text-status-good">Current</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">
                    Connected {formatRelativeTime(new Date(entry.connectedAt).getTime())}
                    {entry.disconnectedAt ? ` · disconnected ${formatRelativeTime(new Date(entry.disconnectedAt).getTime())}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
