"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { StatusBadge } from "@/components/status/StatusBadge";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";
import { getFleetLocations } from "@/lib/api";
import type { DeviceLocationEntry } from "@/lib/types";

// Leaflet touches `window`/`document` at import time, so it can never run
// during Next.js's server-side render — this defers loading it to the
// browser only, same reason every Leaflet-in-Next.js guide does this.
const LiveMap = dynamic(() => import("@/components/tracking/LiveMap").then((m) => m.LiveMap), { ssr: false });

// A device only has anything worth showing in the detail panel once its IP
// has actually resolved to something — a private address, or a public one
// the lookup failed on, has no city/isp/asn/zip/timezone to display at all.
function hasResolvedInfo(d: DeviceLocationEntry): boolean {
  return Boolean(d.city || d.isp || d.asn || d.zip);
}

interface DetailRowProps {
  label: string;
  value: string | null;
}

function DetailRow({ label, value }: DetailRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gridline px-4 py-2.5 last:border-b-0">
      <span className="text-sm text-ink-secondary">{label}</span>
      <span className="text-sm font-medium text-ink-primary">{value || "—"}</span>
    </div>
  );
}

function DeviceIpDetail({ device }: { device: DeviceLocationEntry }) {
  const place = [device.city, device.region, device.country].filter(Boolean).join(", ");
  return (
    <div className="glass-card overflow-hidden rounded-xl">
      <div className="border-b border-border p-card-padding">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{device.agentId} — public IP address</p>
        <p className="tabular mt-1 text-3xl font-bold text-ink-primary">{device.remoteIp || "Unknown"}</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        <div>
          <DetailRow label="City" value={device.city} />
          <DetailRow label="Region" value={device.region} />
          <DetailRow label="Country" value={device.country} />
          <DetailRow label="Postal code" value={device.zip} />
          <DetailRow label="Timezone" value={device.timezone} />
          <DetailRow label="ISP" value={device.isp} />
        </div>
        <div className="h-64 border-t border-border lg:h-auto lg:border-l lg:border-t-0">
          {device.lat !== null && device.lon !== null ? (
            <LiveMap devices={[device]} />
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-center text-xs text-ink-muted">{place || "No map coordinates available"}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Tracking({ username }: { username: string }) {
  const { connectionStatus } = useDashboardSocket();
  const [devices, setDevices] = useState<DeviceLocationEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  useEffect(() => {
    getFleetLocations()
      .then((res) => setDevices(res.devices))
      .catch(() => setError("Couldn't load device locations."));
  }, []);

  const located = (devices ?? []).filter((d) => d.lat !== null && d.lon !== null);
  const unlocated = (devices ?? []).filter((d) => d.lat === null || d.lon === null);
  const selected = (devices ?? []).find((d) => d.agentId === selectedAgentId) ?? null;

  return (
    <AppShell
      username={username}
      connectionStatus={connectionStatus}
      statusSlot={
        <StatusBadge
          tone={connectionStatus === "open" ? "good" : "critical"}
          label={connectionStatus === "open" ? "Live" : connectionStatus === "connecting" ? "Connecting…" : "Disconnected"}
        />
      }
    >
      <div className="mx-auto flex h-full max-w-[1600px] flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">Live Tracking</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Approximate device location by IP address — not GPS. Devices on the same office network share one
            location; devices on a private/LAN address can't be located at all.
          </p>
        </div>

        {error ? (
          <p className="rounded-lg border border-border bg-surface p-5 text-sm text-status-critical">{error}</p>
        ) : (
          <>
            <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
              <div className="h-[560px] overflow-hidden rounded-lg border border-border bg-surface shadow-sm lg:h-auto">
                {devices === null ? (
                  <div className="flex h-full items-center justify-center text-sm text-ink-muted">Loading…</div>
                ) : located.length === 0 ? (
                  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-muted">
                    No devices have a resolvable public IP yet — see the list for why.
                  </div>
                ) : (
                  <LiveMap devices={located} />
                )}
              </div>

              <div className="flex flex-col rounded-lg border border-border bg-surface shadow-sm">
                <div className="border-b border-border px-4 py-3">
                  <h2 className="font-semibold text-ink-primary">Devices ({devices?.length ?? 0})</h2>
                </div>
                <ul className="flex-1 divide-y divide-gridline overflow-y-auto">
                  {located.map((d) => (
                    <li key={d.agentId}>
                      <button
                        type="button"
                        onClick={() => setSelectedAgentId(d.agentId)}
                        className={`w-full px-4 py-3 text-left transition-colors hover:bg-gridline/30 ${selectedAgentId === d.agentId ? "bg-accent/10" : ""}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium text-ink-primary">{d.agentId}</p>
                          <StatusBadge tone={d.status === "online" ? "good" : "offline"} label={d.status === "online" ? "Online" : "Offline"} />
                        </div>
                        <p className="mt-0.5 text-[11px] text-ink-muted">
                          {[d.city, d.region, d.country].filter(Boolean).join(", ") || "Unknown location"} · {d.remoteIp}
                        </p>
                      </button>
                    </li>
                  ))}
                  {unlocated.map((d) => {
                    const clickable = hasResolvedInfo(d);
                    return (
                      <li key={d.agentId}>
                        <button
                          type="button"
                          disabled={!clickable}
                          onClick={() => clickable && setSelectedAgentId(d.agentId)}
                          className={`w-full px-4 py-3 text-left transition-colors ${clickable ? "hover:bg-gridline/30" : "cursor-default"} ${selectedAgentId === d.agentId ? "bg-accent/10" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-medium text-ink-primary">{d.agentId}</p>
                            <StatusBadge tone={d.status === "online" ? "good" : "offline"} label={d.status === "online" ? "Online" : "Offline"} />
                          </div>
                          <p className="mt-0.5 text-[11px] text-ink-muted">
                            {d.isPrivate
                              ? `Private network address (${d.remoteIp ?? "unknown"}) — location not available`
                              : d.remoteIp
                                ? "Location lookup unavailable"
                                : "No connection recorded yet"}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                  {devices !== null && devices.length === 0 && (
                    <li className="p-5 text-sm text-ink-muted">No devices have connected yet.</li>
                  )}
                </ul>
              </div>
            </div>

            {selected && hasResolvedInfo(selected) && <DeviceIpDetail device={selected} />}
          </>
        )}
      </div>
    </AppShell>
  );
}

export default function TrackingPage() {
  return <AuthGate>{(username) => <Tracking username={username} />}</AuthGate>;
}
