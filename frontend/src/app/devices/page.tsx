"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EndpointGrid } from "@/components/endpoints/EndpointGrid";
import { EndpointTable } from "@/components/endpoints/EndpointTable";
import { FleetStats } from "@/components/endpoints/FleetStats";
import { ProcessManagerDrawer } from "@/components/process/ProcessManagerDrawer";
import { AssetFormModal } from "@/components/assets/AssetFormModal";
import { StatusBadge } from "@/components/status/StatusBadge";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";
import { getAssets, getFleetLocations } from "@/lib/api";
import type { AssetInput, DeviceInfo } from "@/lib/types";

type StatusFilter = "all" | "online" | "offline" | "alert";

function Devices({ username }: { username: string }) {
  const { agents, history, connectionStatus, commandOutputs } = useDashboardSocket();
  const searchParams = useSearchParams();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [assetPrefill, setAssetPrefill] = useState<AssetInput | null>(null);
  // Just enough asset data for the "Connected devices" list to hide
  // "+ Add as asset" for a device that's already registered — the full
  // asset table itself lives on /assets, not here.
  const [registeredSerials, setRegisteredSerials] = useState<Set<string>>(new Set());

  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  // agentId -> country, from IP geolocation (same source as Live Tracking) —
  // fetched once here rather than duplicating a geolocation lookup, since
  // AgentSummary itself carries no location data.
  const [countryByAgent, setCountryByAgent] = useState<Record<string, string>>({});

  useEffect(() => {
    getFleetLocations()
      .then((res) => {
        const map: Record<string, string> = {};
        for (const d of res.devices) {
          if (d.country) map[d.agentId] = d.country;
        }
        setCountryByAgent(map);
      })
      .catch(() => {}); // best-effort — filter just shows "Unknown" for everyone if this fails
  }, []);

  function reloadRegisteredSerials(): void {
    getAssets()
      .then((res) => setRegisteredSerials(new Set(res.assets.map((a) => a.serialNumber).filter((s): s is string => Boolean(s)))))
      .catch(() => {}); // best-effort — worst case the button just doesn't hide yet
  }

  useEffect(() => {
    reloadRegisteredSerials();
  }, []);

  // Deep-linked from the Dashboard's "needs attention" list (?agent=<id>) —
  // opens the drawer straight away instead of making the operator find and
  // click the device again. ?console=1 (no agent) is kept as a legacy
  // fallback — the primary way to reach fleet-wide commands is now the
  // standalone /console page (see the sidebar's "AI Console" entry).
  useEffect(() => {
    const agentParam = searchParams.get("agent");
    if (agentParam) {
      setSelectedAgentId(agentParam);
      setDrawerOpen(true);
    } else if (searchParams.get("console")) {
      setSelectedAgentId(null);
      setDrawerOpen(true);
    }
    // Only ever meant to run once on arrival — the drawer's own open/close
    // state takes over after that, it shouldn't reset if these params
    // happen to still be in the URL after the operator closes the drawer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wired to the header's global search (AppShell) — Enter there navigates
  // here with ?q=, filtering by a real substring match on agentId rather
  // than the search box being decorative.
  const query = (searchParams.get("q") ?? "").trim().toLowerCase();

  // Populated from whatever the fleet actually reports, not a hardcoded
  // list — a device's OS platform string (Windows/Linux distro name/darwin)
  // and geolocated country both vary by deployment, so the dropdown only
  // ever offers options that exist right now.
  const countryOptions = useMemo(
    () => Array.from(new Set(Object.values(countryByAgent))).sort(),
    [countryByAgent],
  );
  const typeOptions = useMemo(
    () =>
      Array.from(new Set(agents.map((a) => a.lastTelemetry?.os).filter((os): os is string => Boolean(os)))).sort(),
    [agents],
  );

  const visibleAgents = agents.filter((a) => {
    if (query && !a.agentId.toLowerCase().includes(query)) return false;
    if (statusFilter === "online" && a.status !== "online") return false;
    if (statusFilter === "offline" && a.status !== "offline") return false;
    if (statusFilter === "alert" && a.lastTelemetry?.mode !== "alert") return false;
    if (countryFilter !== "all" && countryByAgent[a.agentId] !== countryFilter) return false;
    if (typeFilter !== "all" && a.lastTelemetry?.os !== typeFilter) return false;
    return true;
  });

  const selectedAgent = agents.find((a) => a.agentId === selectedAgentId) ?? null;

  function openDeviceDrawer(agentId: string): void {
    setSelectedAgentId(agentId);
    setDrawerOpen(true);
  }

  function openConsoleOnly(): void {
    setSelectedAgentId(null);
    setDrawerOpen(true);
  }

  function handleRegisterDevice(device: DeviceInfo, agentId: string): void {
    setAssetPrefill({
      assetType: "peripheral",
      manufacturer: device.manufacturer || null,
      model: device.model || device.name,
      manualSerialNumber: device.serial_number || null,
      parentAgentId: agentId,
      status: "deployed",
    });
  }

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
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Devices</h1>
            <p className="text-xs text-ink-muted">
              {query ? `Filtered by "${query}" — ` : ""}Click a device for its AI console, live processes, trend, and command history.
            </p>
          </div>
          <button
            type="button"
            onClick={openConsoleOnly}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            AI Console
          </button>
        </div>

        <FleetStats agents={agents} />

        <div className="glass-card flex flex-wrap items-center gap-2 rounded-xl p-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
          >
            <option value="all">All Status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="alert">In alert</option>
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
          >
            <option value="all">All Types</option>
            {typeOptions.map((os) => (
              <option key={os} value={os}>
                {os}
              </option>
            ))}
          </select>

          <select
            value={countryFilter}
            onChange={(e) => setCountryFilter(e.target.value)}
            className="rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
          >
            <option value="all">All Countries</option>
            {countryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <div className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-page p-1">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              aria-label="List view"
              className={`flex h-7 w-7 items-center justify-center rounded-md ${viewMode === "list" ? "bg-accent text-white" : "text-ink-muted hover:text-ink-primary"}`}
            >
              <span className="material-symbols-outlined text-[18px]">view_list</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              aria-label="Grid view"
              className={`flex h-7 w-7 items-center justify-center rounded-md ${viewMode === "grid" ? "bg-accent text-white" : "text-ink-muted hover:text-ink-primary"}`}
            >
              <span className="material-symbols-outlined text-[18px]">grid_view</span>
            </button>
          </div>
        </div>

        <main>
          {viewMode === "list" ? (
            <EndpointTable agents={visibleAgents} onSelect={openDeviceDrawer} />
          ) : (
            <EndpointGrid agents={agents} displayAgents={visibleAgents} onSelect={openDeviceDrawer} />
          )}
        </main>
      </div>

      <ProcessManagerDrawer
        open={drawerOpen}
        agent={selectedAgent}
        agents={agents}
        history={history}
        onClose={() => setDrawerOpen(false)}
        onRegisterDevice={(device, agent) => handleRegisterDevice(device, agent.agentId)}
        registeredSerials={registeredSerials}
        commandOutputs={commandOutputs}
      />

      {assetPrefill && (
        <AssetFormModal
          editing={null}
          prefill={assetPrefill}
          unregisteredAgents={[]}
          onClose={() => setAssetPrefill(null)}
          onSaved={() => {
            setAssetPrefill(null);
            reloadRegisteredSerials();
          }}
        />
      )}
    </AppShell>
  );
}

export default function DevicesPage() {
  return (
    <AuthGate>
      {(username) => (
        <Suspense fallback={null}>
          <Devices username={username} />
        </Suspense>
      )}
    </AuthGate>
  );
}
