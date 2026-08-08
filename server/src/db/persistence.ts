// Bridges the two in-memory live-state stores (AgentRegistry,
// CommandHistoryStore) to durable Postgres storage, by subscribing to the
// same EventEmitter events ws/dashboardServer.ts already uses to push live
// updates to browser clients. This is a pure add-on: nothing in ws/server.ts,
// api/routes.ts, or ws/dispatch.ts needs to change to get persistence.
//
// Writes are fire-and-forget and every failure is caught and logged, never
// thrown — a database outage must degrade to "this snapshot/entry didn't get
// persisted", not take down live agent handling or command dispatch, which
// have to keep working regardless of whether Postgres is reachable.
import type { Pool } from "pg";
import { log } from "../logger.js";
import type { AgentRegistry, AgentSummary } from "../ws/registry.js";
import type { CommandHistoryStore, HistoryEntry } from "../history/commandHistory.js";
import type { TelemetrySnapshot } from "../protocol.js";
import { nextAssetTag, createAsset, findUnlinkedAssetBySerial, findPeripheralAssetBySerial } from "../assets/assetsStore.js";
import { openIncident, resolveIncident } from "../incidents/incidentsStore.js";
import { findOpenConnection, closeConnection, openConnection } from "../assets/connectionHistoryStore.js";
import { notifyAll } from "../notifications/dispatcher.js";
import type { NotifyConfig } from "../notifications/types.js";

// Serial values some OEMs ship literally instead of a real serial (common on
// custom-built desktops with no OEM-programmed BIOS serial) — verified on a
// real test machine (Win32_BIOS.SerialNumber = "To Be Filled By O.E.M."), so
// these must never be treated as a real identifier for matching purposes,
// or every machine with a blank BIOS would spuriously merge into one asset.
const PLACEHOLDER_SERIALS = new Set([
  "to be filled by o.e.m.",
  "system serial number",
  "default string",
  "none",
  "n/a",
  "",
]);

function isRealSerial(serial: string | null | undefined): serial is string {
  if (!serial) return false;
  return !PLACEHOLDER_SERIALS.has(serial.trim().toLowerCase());
}

export function wirePersistence(pool: Pool, registry: AgentRegistry, history: CommandHistoryStore, notifyCfg: NotifyConfig): void {
  registry.on("update", (summary: AgentSummary) => {
    upsertAgent(pool, summary).catch((err) =>
      log.error({ err, orgId: summary.orgId, agentId: summary.agentId }, "db: failed to persist agent state"),
    );
    ensureAssetForAgent(pool, summary).catch((err) =>
      log.error({ err, orgId: summary.orgId, agentId: summary.agentId }, "db: failed to auto-register asset for agent"),
    );
    trackResourceAlerts(pool, summary);
  });

  registry.on("telemetry", ({ orgId, agentId, snapshot }: { orgId: string; agentId: string; snapshot: TelemetrySnapshot }) => {
    insertTelemetry(pool, orgId, agentId, snapshot).catch((err) =>
      log.error({ err, orgId, agentId }, "db: failed to persist telemetry snapshot"),
    );
    trackHungProcesses(pool, orgId, agentId, snapshot, notifyCfg).catch((err) =>
      log.error({ err, orgId, agentId }, "db: failed to track hung-process incidents"),
    );
    trackPeripheralConnections(pool, orgId, agentId, snapshot).catch((err) =>
      log.error({ err, orgId, agentId }, "db: failed to track peripheral connection history"),
    );
  });

  history.on("entry", (entry: HistoryEntry) => {
    upsertHistoryEntry(pool, entry).catch((err) =>
      log.error({ err, orgId: entry.orgId, commandId: entry.commandId }, "db: failed to persist command history entry"),
    );
  });
}

interface AgentRow {
  org_id: string;
  agent_id: string;
  status: string;
  connected_at: Date;
  last_seen_at: Date;
  last_telemetry: TelemetrySnapshot | null;
  remote_ip: string | null;
}

// Warm-starts AgentRegistry's in-memory copy from durable storage at startup
// — see AgentRegistry.hydrate's own doc comment for why this matters (a
// restart previously blanked lastTelemetry/remoteIp back to null for a
// perfectly healthy device until its next scheduled poll, up to 5 minutes
// away). `status` from the row is intentionally ignored here — hydrate()
// always seeds "offline" regardless, since this process hasn't actually
// observed a live connection yet.
export async function loadPersistedAgents(pool: Pool): Promise<AgentSummary[]> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT org_id, agent_id, status, connected_at, last_seen_at, last_telemetry, remote_ip FROM agents`,
  );
  return rows.map((r) => ({
    orgId: r.org_id,
    agentId: r.agent_id,
    status: "offline",
    connectedAt: r.connected_at.getTime(),
    lastSeenAt: r.last_seen_at.getTime(),
    lastTelemetry: r.last_telemetry,
    remoteIp: r.remote_ip,
    // Not persisted anywhere — repopulated from the agent's own next
    // heartbeat after it reconnects, same as every other "unknown until
    // fresh data arrives" field here.
    version: null,
    configHash: null,
  }));
}

async function upsertAgent(pool: Pool, s: AgentSummary): Promise<void> {
  await pool.query(
    `INSERT INTO agents (org_id, agent_id, status, connected_at, last_seen_at, last_telemetry, remote_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, agent_id) DO UPDATE SET
       status = EXCLUDED.status,
       connected_at = EXCLUDED.connected_at,
       last_seen_at = EXCLUDED.last_seen_at,
       last_telemetry = EXCLUDED.last_telemetry,
       remote_ip = COALESCE(EXCLUDED.remote_ip, agents.remote_ip)`,
    [
      s.orgId,
      s.agentId,
      s.status,
      new Date(s.connectedAt),
      new Date(s.lastSeenAt),
      s.lastTelemetry ? JSON.stringify(s.lastTelemetry) : null,
      s.remoteIp,
    ],
  );
}

// Every device that ever connects becomes an asset automatically — the
// operator's actual request was "a device that got installed IS an asset,
// don't make me register it by hand." Runs on every agent "update" event
// (frequent — every heartbeat/telemetry), so it's written to be a cheap
// no-op once the asset already exists rather than something that should
// only ever run once; the UNIQUE constraint on assets(org_id, agent_id)
// also makes a concurrent double-create (two events racing before either
// commits) resolve safely — one wins, the other's insert fails and is
// swallowed here rather than logged as a real error, since "someone else
// already created it" isn't a failure.
async function ensureAssetForAgent(pool: Pool, summary: AgentSummary): Promise<void> {
  const { orgId, agentId } = summary;
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM assets WHERE org_id = $1 AND agent_id = $2) AS exists`,
    [orgId, agentId],
  );
  if (rows[0]?.exists) return;

  // No telemetry yet (agent just connected, snapshot hasn't arrived) — skip
  // for now rather than create a bare shell. Telemetry arrival re-triggers
  // this same "update" event, so it's retried automatically once a serial
  // is actually known.
  if (!summary.lastTelemetry) return;

  const serial = summary.lastTelemetry.serial_number;
  if (isRealSerial(serial)) {
    const matchedTag = await findUnlinkedAssetBySerial(pool, orgId, serial);
    if (matchedTag) {
      await pool.query(`UPDATE assets SET agent_id = $1, status = 'deployed', updated_at = now() WHERE org_id = $2 AND asset_tag = $3`, [
        agentId,
        orgId,
        matchedTag,
      ]);
      log.info({ orgId, agentId, assetTag: matchedTag, serial }, "assets: merged newly connected device into pre-registered asset by serial number");
      return;
    }
  }

  const assetTag = await nextAssetTag(pool, orgId);
  try {
    await createAsset(pool, orgId, assetTag, {
      agentId,
      status: "deployed",
      manualSerialNumber: isRealSerial(serial) ? serial : null,
    });
    log.info({ orgId, agentId, assetTag }, "assets: auto-registered newly connected device");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      return; // lost a race to another concurrent event — the asset exists now either way
    }
    throw err;
  }
}

async function insertTelemetry(pool: Pool, orgId: string, agentId: string, snapshot: TelemetrySnapshot): Promise<void> {
  await pool.query(
    `INSERT INTO telemetry_snapshots
       (org_id, agent_id, recorded_at, mode, cpu_percent, mem_percent, mem_used_mb, mem_total_mb, snapshot)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9)`,
    [
      orgId,
      agentId,
      snapshot.timestamp,
      snapshot.mode,
      snapshot.cpu_percent,
      snapshot.mem_percent,
      snapshot.mem_used_mb,
      snapshot.mem_total_mb,
      JSON.stringify(snapshot),
    ],
  );
}

// (orgId, agentId) -> currently-open "resource_alert" device_incidents row
// id, and -> last-seen mode — the same edge-triggered-transition pattern
// notifications/alertWatcher.ts already uses (registry's "update" event
// fires on *every* heartbeat regardless of whether mode actually changed,
// so without diffing against the previous mode this would open a new
// incident on every single poll while a device sits in alert mode, not once
// per episode). Kept separate from alertWatcher's own previousMode map —
// notifications and incident logging are different concerns that happen to
// both subscribe to the same event. In-memory only, same caveat as
// openHangIncidents below: a server restart loses track of an
// already-open episode, so a device still in alert mode after a restart
// gets one fresh incident row rather than resuming the old one. Keyed by
// org+agent (not agent alone) so two orgs' agents sharing a hostname never
// collide in these trackers.
const openAlertIncidents = new Map<string, number>();
const previousAlertMode = new Map<string, "normal" | "alert">();

function agentKey(orgId: string, agentId: string): string {
  return `${orgId}:${agentId}`;
}

// Alert mode (CPU/RAM over the agent's configured threshold) previously
// only ever reached an operator as a transient dashboard badge and an
// outbound Slack/Teams/email notification (if configured) — nothing
// persisted it, so there was no way to look back and see *why* a device had
// been flagged, or even that it had been. This gives it the same durable
// "Incidents" record process-hang detection already gets, with the actual
// CPU/RAM numbers in the message — the real cause, not just "alert mode",
// since the agent's own threshold value never reaches the server at all
// (only the resulting mode flag does).
function trackResourceAlerts(pool: Pool, summary: AgentSummary): void {
  const mode = summary.lastTelemetry?.mode;
  if (!mode) return;
  const key = agentKey(summary.orgId, summary.agentId);
  const prevMode = previousAlertMode.get(key);
  previousAlertMode.set(key, mode);
  if (prevMode === undefined || prevMode === mode) return; // no transition (or first sighting of this agent)

  if (mode === "alert") {
    const snap = summary.lastTelemetry!;
    openIncident(
      pool,
      summary.orgId,
      summary.agentId,
      "resource_alert",
      `Entered alert mode — CPU ${snap.cpu_percent.toFixed(0)}%, RAM ${snap.mem_percent.toFixed(0)}%`,
    )
      .then((id) => openAlertIncidents.set(key, id))
      .catch((err) => log.error({ err, orgId: summary.orgId, agentId: summary.agentId }, "incidents: failed to open resource_alert incident"));
  } else {
    const id = openAlertIncidents.get(key);
    if (id === undefined) return;
    openAlertIncidents.delete(key);
    resolveIncident(pool, id).catch((err) =>
      log.error({ err, orgId: summary.orgId, agentId: summary.agentId }, "incidents: failed to resolve resource_alert incident"),
    );
  }
}

// (orgId, agentId, pid, name) -> open device_incidents row id, so a process
// that's still hung across many consecutive polls updates the same episode
// instead of spamming a new row every ~5s/10s. In-memory only: a server
// restart loses track of already-open episodes, which just means a
// still-hung process gets a fresh incident row next poll rather than
// resuming the old one — fine for what this is (a recent-activity feed),
// not a durable audit log with stronger guarantees.
const openHangIncidents = new Map<string, number>();

function incidentKey(orgId: string, agentId: string, pid: number, name: string): string {
  return `${orgId} ${agentId} ${pid} ${name}`;
}

async function trackHungProcesses(
  pool: Pool,
  orgId: string,
  agentId: string,
  snapshot: TelemetrySnapshot,
  notifyCfg: NotifyConfig,
): Promise<void> {
  const hungProcs = snapshot.top_processes.filter((p) => !p.responding);
  const hungKeys = new Set(hungProcs.map((p) => incidentKey(orgId, agentId, p.pid, p.name)));

  for (const proc of hungProcs) {
    const key = incidentKey(orgId, agentId, proc.pid, proc.name);
    if (openHangIncidents.has(key)) continue;
    const id = await openIncident(pool, orgId, agentId, "process_not_responding", `${proc.name} (PID ${proc.pid}) stopped responding`);
    openHangIncidents.set(key, id);
    log.warn({ orgId, agentId, pid: proc.pid, name: proc.name }, "incidents: process not responding");
    notifyAll(notifyCfg, {
      kind: "process_not_responding",
      agentId,
      message: `${proc.name} (PID ${proc.pid}) stopped responding.`,
      severity: "warning",
    });
  }

  const prefix = `${orgId} ${agentId} `;
  for (const [key, id] of [...openHangIncidents.entries()]) {
    if (!key.startsWith(prefix) || hungKeys.has(key)) continue;
    await resolveIncident(pool, id);
    openHangIncidents.delete(key);
  }
}

// Recognizes a registered peripheral asset (matched by its own hand-entered
// serial) showing up in a snapshot's connected_devices, and keeps
// asset_connection_history — and assets.parent_agent_id, kept as "whichever
// one is most recent" for the tree view in the Asset Registry page — in
// sync with wherever it's actually plugged in right now. This is what
// notices a monitor got moved to a different computer: the moment its
// serial appears on a *different* agent's connected_devices than the one
// its currently-open history episode says, that episode closes and a new
// one opens against the new agent.
async function trackPeripheralConnections(pool: Pool, orgId: string, agentId: string, snapshot: TelemetrySnapshot): Promise<void> {
  for (const device of snapshot.connected_devices) {
    if (!device.serial_number) continue;
    const asset = await findPeripheralAssetBySerial(pool, orgId, device.serial_number);
    if (!asset) continue; // not registered as an asset — nothing to track yet

    const open = await findOpenConnection(pool, orgId, asset.assetTag);
    if (open?.agentId === agentId) continue; // already tracked correctly, no-op

    if (open) {
      await closeConnection(pool, orgId, asset.assetTag, open.agentId);
    }
    await openConnection(pool, orgId, asset.assetTag, agentId);

    if (asset.parentAgentId !== agentId) {
      await pool.query(`UPDATE assets SET parent_agent_id = $1, updated_at = now() WHERE org_id = $2 AND asset_tag = $3`, [
        agentId,
        orgId,
        asset.assetTag,
      ]);
    }
    log.info({ orgId, assetTag: asset.assetTag, agentId, previousAgentId: open?.agentId ?? null }, "assets: peripheral connection tracked");
  }
}

interface CommandHistoryRow {
  command_id: string;
  org_id: string;
  agent_id: string;
  action: string;
  params: Record<string, string>;
  requested_by: string;
  source_text: string | null;
  status: string;
  message: string | null;
  dispatched_at: Date;
  resolved_at: Date | null;
}

// Warm-starts CommandHistoryStore's in-memory copy from durable storage at
// startup — see CommandHistoryStore.hydrate's own doc comment for why this
// matters (a restart previously blanked the dashboard/AI console/Commands
// tab's view back to empty even though this table itself was never
// affected). Ordered oldest-first to match hydrate's expected input.
export async function loadRecentHistory(pool: Pool, limit = 500): Promise<HistoryEntry[]> {
  const { rows } = await pool.query<CommandHistoryRow>(
    `SELECT command_id, org_id, agent_id, action, params, requested_by, source_text, status, message, dispatched_at, resolved_at
     FROM command_history ORDER BY dispatched_at DESC LIMIT $1`,
    [limit],
  );
  return rows.reverse().map((r) => ({
    commandId: r.command_id,
    orgId: r.org_id,
    agentId: r.agent_id,
    action: r.action as HistoryEntry["action"],
    params: r.params,
    requestedBy: r.requested_by,
    sourceText: r.source_text,
    status: r.status as HistoryEntry["status"],
    message: r.message,
    dispatchedAt: r.dispatched_at.getTime(),
    resolvedAt: r.resolved_at ? r.resolved_at.getTime() : null,
  }));
}

async function upsertHistoryEntry(pool: Pool, e: HistoryEntry): Promise<void> {
  await pool.query(
    `INSERT INTO command_history
       (org_id, command_id, agent_id, action, params, requested_by, source_text, status, message, dispatched_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (command_id) DO UPDATE SET
       status = EXCLUDED.status,
       message = EXCLUDED.message,
       resolved_at = EXCLUDED.resolved_at`,
    [
      e.orgId,
      e.commandId,
      e.agentId,
      e.action,
      JSON.stringify(e.params),
      e.requestedBy,
      e.sourceText,
      e.status,
      e.message,
      new Date(e.dispatchedAt),
      e.resolvedAt ? new Date(e.resolvedAt) : null,
    ],
  );
}
