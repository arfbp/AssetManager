"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { ProcessManagerDrawer } from "@/components/process/ProcessManagerDrawer";
import { AssetFormModal } from "@/components/assets/AssetFormModal";
import { ImportAssetsModal } from "@/components/assets/ImportAssetsModal";
import { ConnectionHistoryModal } from "@/components/assets/ConnectionHistoryModal";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { StatusBadge } from "@/components/status/StatusBadge";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";
import { getAssets, getFleetLocations, deleteAsset, ApiError } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import { formatRelativeTime } from "@/lib/format";
import type { AssetInput, AssetWithLiveInfo, AssetStatus, DeviceInfo, DeviceLocationEntry } from "@/lib/types";

// `ipAddresses` is the device's own LAN-local address list (last_telemetry's
// ip_addresses — same value the device detail page's network tab shows),
// distinct from the geolocation below, which resolves the device's public
// IP instead. Both are "real" — one's just not useful for "where is this
// physically", the other is.
function ipLabel(asset: AssetWithLiveInfo): string {
  const ips = asset.ipAddresses ?? [];
  const first = ips[0];
  if (!first) return "—";
  return ips.length > 1 ? `${first} (+${ips.length - 1})` : first;
}

// City/country by IP geolocation — same source and same honest limits as
// the Live Tracking page (server/src/geolocation/ipGeo.ts): a private/LAN
// address can never resolve to a location at all, and even a real public IP
// only resolves to roughly the ISP's regional point, not a precise address.
function geoLabel(loc: DeviceLocationEntry | undefined): string {
  if (!loc) return "—";
  if (loc.isPrivate) return "Private network";
  const place = [loc.city, loc.country].filter(Boolean).join(", ");
  return place || "—";
}

// One chip per physical drive — "224 GB SSD", "1863 GB HDD" — same spec
// data the device drawer's "Specs" panel shows, just condensed for a table
// cell. "Unknown" media type (the OS didn't report SSD vs HDD reliably)
// still shows the size rather than being hidden entirely.
function storageLabel(asset: AssetWithLiveInfo): string {
  const disks = asset.physicalDisks ?? [];
  if (disks.length === 0) return "—";
  return disks.map((d) => `${d.size_gb.toFixed(0)} GB ${d.media_type}`).join(", ");
}

const STATUS_LABEL: Record<AssetStatus, string> = {
  ready_to_deploy: "Ready to deploy",
  deployed: "Deployed",
  in_repair: "In repair",
  retired: "Retired",
};

// Only ever shown for a "peripheral" asset's "Linked device" cell.
// lastConnectionAgentId null means it's never actually been seen
// connecting to anything (a manually-set parentAgentId at registration
// doesn't count on its own) — "if it's never connected, don't show
// anything". Otherwise distinguishes "still connected right now" from
// "was connected, here's when" rather than always reading as present-tense.
function ConnectionSummary({ asset }: { asset: AssetWithLiveInfo }) {
  if (!asset.lastConnectionAgentId || !asset.lastConnectedAt) {
    return <span className="text-ink-muted">—</span>;
  }
  const isCurrent = !asset.lastConnectionDisconnectedAt;
  return (
    <span className="text-xs text-ink-secondary">
      {isCurrent ? "Connected to " : "Last connected to "}
      <span className="font-medium text-ink-primary">{asset.lastConnectionAgentId}</span>
      <span className="text-ink-muted"> · {formatRelativeTime(new Date(asset.lastConnectedAt).getTime())}</span>
    </span>
  );
}

function AssetsPage({ username }: { username: string }) {
  // A viewer's write attempts are already rejected server-side with a clear
  // message (every save/delete path here catches ApiError and shows it
  // inline) — this just avoids presenting a button that's known in advance
  // to always fail, not a security boundary of its own.
  const canWrite = getStoredRole() !== "viewer";
  const { agents, history, commandOutputs, connectionStatus } = useDashboardSocket();
  const [assets, setAssets] = useState<AssetWithLiveInfo[]>([]);
  const [unregisteredAgents, setUnregisteredAgents] = useState<string[]>([]);
  const [locations, setLocations] = useState<DeviceLocationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AssetWithLiveInfo | "new" | null>(null);
  const [prefill, setPrefill] = useState<AssetInput | undefined>(undefined);
  const [showImport, setShowImport] = useState(false);
  const [viewingDevicesFor, setViewingDevicesFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetWithLiveInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Which "computer" assets are expanded to show their linked peripherals
  // (monitors, etc.) nested underneath — keyed by asset tag.
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const [historyTarget, setHistoryTarget] = useState<string | null>(null);

  function toggleExpand(tag: string): void {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function handleRegisterDevice(device: DeviceInfo, agentId: string): void {
    setPrefill({
      assetType: "peripheral",
      manufacturer: device.manufacturer || null,
      model: device.model || device.name,
      manualSerialNumber: device.serial_number || null,
      parentAgentId: agentId,
      status: "deployed",
    });
    setEditing("new");
  }

  function reload(): void {
    setLoading(true);
    getAssets()
      .then((res) => {
        setAssets(res.assets);
        setUnregisteredAgents(res.unregisteredAgents);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load assets."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    getFleetLocations()
      .then((res) => setLocations(res.devices))
      .catch(() => setLocations([])); // best-effort — asset rows just show "—" for city/country
  }, []);

  const locationByAgentId = new Map(locations.map((l) => [l.agentId, l]));

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteAsset(deleteTarget.assetTag);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Failed to delete asset.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const filtered = assets.filter((a) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      a.assetTag.toLowerCase().includes(q) ||
      (a.agentId ?? "").toLowerCase().includes(q) ||
      (a.serialNumber ?? "").toLowerCase().includes(q) ||
      (a.manufacturer ?? "").toLowerCase().includes(q) ||
      (a.model ?? "").toLowerCase().includes(q) ||
      (a.location ?? "").toLowerCase().includes(q) ||
      (a.category ?? "").toLowerCase().includes(q) ||
      (a.checkedOutTo ?? "").toLowerCase().includes(q)
    );
  });

  const viewingAgent = agents.find((a) => a.agentId === viewingDevicesFor) ?? null;

  // "computer" assets (linked to an agent_id) each get their linked
  // "peripheral" assets (a monitor registered with its own SN, say) nested
  // underneath them, expandable via a +/- toggle — a peripheral's
  // parentAgentId records which computer it was connected through at
  // registration time. Peripherals whose parent isn't (or is no longer) a
  // registered computer asset still need to show up somewhere, so they fall
  // back to their own top-level row instead of silently disappearing.
  const computerAssets = filtered.filter((a) => a.assetType !== "peripheral");
  const peripheralAssets = filtered.filter((a) => a.assetType === "peripheral");
  const computerAgentIds = new Set(computerAssets.map((c) => c.agentId).filter((id): id is string => Boolean(id)));
  const orphanPeripherals = peripheralAssets.filter((p) => !p.parentAgentId || !computerAgentIds.has(p.parentAgentId));
  const childrenByParent = new Map<string, AssetWithLiveInfo[]>();
  for (const p of peripheralAssets) {
    if (!p.parentAgentId || !computerAgentIds.has(p.parentAgentId)) continue;
    const list = childrenByParent.get(p.parentAgentId) ?? [];
    list.push(p);
    childrenByParent.set(p.parentAgentId, list);
  }

  // Fed into ProcessManagerDrawer's "Connected devices" list so it can hide
  // "+ Add as asset" for a device that already has an asset record — built
  // from the full (unfiltered) list, not `filtered`, so typing in the
  // search box never makes an already-registered device's button reappear.
  const registeredSerials = new Set(assets.map((a) => a.serialNumber).filter((s): s is string => Boolean(s)));

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
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Asset Registry</h1>
        <p className="text-xs text-ink-muted">Inventory records, linked to live device data where available.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search asset tag, device, serial, model, location…"
          className="w-full max-w-sm rounded-md border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
        />
        <div className="flex items-center gap-2">
          {unregisteredAgents.length > 0 && (
            <span className="text-xs text-ink-muted">{unregisteredAgents.length} connected device(s) not yet registered</span>
          )}
          {canWrite && (
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-gridline/40"
            >
              Import
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              onClick={() => {
                setPrefill(undefined);
                setEditing("new");
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
            >
              New asset
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[1750px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Asset tag</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Linked device</th>
              <th className="px-4 py-3 font-medium">Serial</th>
              <th className="px-4 py-3 font-medium">Manufacturer</th>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">CPU</th>
              <th className="px-4 py-3 font-medium">Storage</th>
              <th className="px-4 py-3 font-medium">IP address</th>
              <th className="px-4 py-3 font-medium">City / Country</th>
              <th className="px-4 py-3 font-medium">Location</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Checked out to</th>
              <th className="px-4 py-3 font-medium">End of life</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={15} className="px-4 py-6 text-center text-ink-muted">
                  Loading…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={15} className="px-4 py-6 text-center text-status-critical">
                  {error}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={15} className="px-4 py-6 text-center text-ink-muted">
                  No assets registered yet.
                </td>
              </tr>
            ) : (
              computerAssets.flatMap((asset) => {
                const children = asset.agentId ? childrenByParent.get(asset.agentId) ?? [] : [];
                const expanded = expandedTags.has(asset.assetTag);
                const rows = [
                  <tr key={asset.assetTag} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-ink-primary">
                      <span className="flex items-center gap-1.5">
                        {children.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleExpand(asset.assetTag)}
                            aria-label={expanded ? "Collapse linked peripherals" : "Expand linked peripherals"}
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border text-[11px] leading-none text-ink-secondary hover:bg-gridline/40"
                          >
                            {expanded ? "−" : "+"}
                          </button>
                        ) : (
                          <span className="inline-block w-4 shrink-0" />
                        )}
                        {asset.assetTag}
                        {children.length > 0 && (
                          <span className="text-[11px] font-normal text-ink-muted">
                            ({children.length} peripheral{children.length === 1 ? "" : "s"})
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-secondary">
                        {STATUS_LABEL[asset.status]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {asset.agentId ? (
                        <span className="flex items-center gap-1.5">
                          <StatusBadge tone={asset.liveStatus === "online" ? "good" : "offline"} label={asset.agentId} />
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.serialNumber || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.manufacturer || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.model || "—"}</td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-ink-secondary" title={asset.cpuModel || undefined}>
                      {asset.cpuModel || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{storageLabel(asset)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{ipLabel(asset)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">
                      {asset.agentId ? geoLabel(locationByAgentId.get(asset.agentId)) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.location || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.category || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.checkedOutTo || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.eolDate ? asset.eolDate.slice(0, 10) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="flex gap-1.5">
                        {asset.agentId && (
                          <button
                            type="button"
                            onClick={() => setViewingDevicesFor(asset.agentId ?? null)}
                            disabled={!viewingAgent && asset.liveStatus !== "online"}
                            className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40 disabled:opacity-40"
                            title={asset.liveStatus === "online" ? "View connected devices & processes" : "Device is offline"}
                          >
                            Devices
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditing(asset)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(asset);
                          }}
                          className="rounded-md border border-border px-2 py-1 text-xs text-status-critical hover:bg-status-critical/10"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>,
                ];

                if (expanded) {
                  for (const child of children) {
                    rows.push(
                      <tr key={child.assetTag} className="border-b border-border bg-page/60 last:border-0">
                        <td className="whitespace-nowrap px-4 py-2 pl-10 text-ink-secondary">
                          <span className="text-ink-muted">↳</span> {child.assetTag}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-secondary">
                            {STATUS_LABEL[child.status]}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <ConnectionSummary asset={child} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.serialNumber || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.manufacturer || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.model || "—"}</td>
                        {/* A peripheral has no CPU/storage/network identity of its own — these only ever apply to the computer it's plugged into. */}
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">—</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">—</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">—</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">—</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.location || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.category || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.checkedOutTo || "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-ink-secondary">{child.eolDate ? child.eolDate.slice(0, 10) : "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => setHistoryTarget(child.assetTag)}
                              className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                              title="View which computers this was connected through over time"
                            >
                              History
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing(child)}
                              className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteError(null);
                                setDeleteTarget(child);
                              }}
                              className="rounded-md border border-border px-2 py-1 text-xs text-status-critical hover:bg-status-critical/10"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>,
                    );
                  }
                }

                return rows;
              })
            )}
            {!loading && !error && filtered.length > 0 && orphanPeripherals.length > 0 && (
              <>
                <tr className="border-b border-border">
                  <td colSpan={15} className="bg-page/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    Peripherals not linked to a registered computer asset
                  </td>
                </tr>
                {orphanPeripherals.map((asset) => (
                  <tr key={asset.assetTag} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-ink-primary">{asset.assetTag}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-secondary">
                        {STATUS_LABEL[asset.status]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs">
                      {asset.lastConnectionAgentId && agents.some((a) => a.agentId === asset.lastConnectionAgentId) ? (
                        <button
                          type="button"
                          onClick={() => setViewingDevicesFor(asset.lastConnectionAgentId)}
                          className="text-accent underline-offset-2 hover:underline"
                          title="View this device"
                        >
                          <ConnectionSummary asset={asset} />
                        </button>
                      ) : (
                        <ConnectionSummary asset={asset} />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.serialNumber || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.manufacturer || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.model || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">—</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">—</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">—</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">—</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.location || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.category || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.checkedOutTo || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{asset.eolDate ? asset.eolDate.slice(0, 10) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setHistoryTarget(asset.assetTag)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                          title="View which computers this was connected through over time"
                        >
                          History
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(asset)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(asset);
                          }}
                          className="rounded-md border border-border px-2 py-1 text-xs text-status-critical hover:bg-status-critical/10"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <AssetFormModal
          editing={editing === "new" ? null : editing}
          prefill={editing === "new" ? prefill : undefined}
          unregisteredAgents={unregisteredAgents}
          onClose={() => {
            setEditing(null);
            setPrefill(undefined);
          }}
          onSaved={() => {
            setEditing(null);
            setPrefill(undefined);
            reload();
          }}
        />
      )}

      {showImport && (
        <ImportAssetsModal
          onClose={() => setShowImport(false)}
          onImported={reload}
        />
      )}

      </div>

      <ProcessManagerDrawer
        open={viewingDevicesFor !== null}
        agent={viewingAgent}
        agents={agents}
        history={history}
        onClose={() => setViewingDevicesFor(null)}
        onRegisterDevice={(device, agent) => handleRegisterDevice(device, agent.agentId)}
        registeredSerials={registeredSerials}
        commandOutputs={commandOutputs}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this asset?"
        message={
          deleteTarget
            ? `Delete asset ${deleteTarget.assetTag}?${deleteError ? `\n\n${deleteError}` : "\n\nThis only removes the inventory record, not the device itself."}`
            : ""
        }
        confirmLabel="Delete"
        tone="danger"
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {historyTarget && <ConnectionHistoryModal assetTag={historyTarget} onClose={() => setHistoryTarget(null)} />}
    </AppShell>
  );
}

export default function AssetsPageWrapper() {
  return <AuthGate>{(username) => <AssetsPage username={username} />}</AuthGate>;
}
