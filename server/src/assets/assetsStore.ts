// Asset registry data access. Inventory/procurement metadata an operator
// enters by hand (location, who it's checked out to, order number,
// end-of-life date) — separate from and layered on top of what the agent
// already reports automatically (serial number, model, manufacturer, live
// status), which lives in the `agents` table's last_telemetry JSONB and is
// only ever joined in here for read, never written by this module.
//
// Every function takes an orgId: agent_id is the machine's OS hostname, not
// globally unique across organizations (see ws/registry.ts's doc comment),
// so any join or lookup keyed by it alone risks matching a different org's
// device that happens to share a hostname. org_id scoping here is both a
// correctness fix (the joins below) and a visibility boundary (callers only
// ever see their own org's assets).
import type { Pool } from "pg";
import type { PhysicalDiskInfo } from "../protocol.js";

// "computer" assets are the agent_id side of the picture: their
// manufacturer/model/serial always come live from the linked agent's
// telemetry. "peripheral" assets (a monitor, for example) have no telemetry
// connection of their own, so their identity is captured once at
// registration time and stored directly — see schema.sql's column comments.
export type AssetType = "computer" | "peripheral";

export interface AssetRecord {
  assetTag: string;
  agentId: string | null;
  status: string;
  category: string | null;
  location: string | null;
  orderNumber: string | null;
  checkedOutTo: string | null;
  checkoutDate: string | null;
  expectedCheckinDate: string | null;
  eolDate: string | null;
  notes: string | null;
  // Entered by hand for a "computer" asset registered before it's ever
  // connected, OR the actual (only) serial for a "peripheral" asset — see
  // schema.sql's column comment. Distinct from AssetLiveInfo's
  // serialNumber, which folds this in only as a fallback when there's no
  // live telemetry to prefer instead.
  manualSerialNumber: string | null;
  assetType: AssetType;
  // Which computer this peripheral was connected through at registration
  // time — informational only, not kept in sync afterward. Null for
  // "computer" assets.
  parentAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

// The read-side view: for a "computer" asset this is always the live
// telemetry value; for a "peripheral" asset (no telemetry of its own) it
// falls back to whatever was stored on the row at registration time — see
// listAssets' COALESCE.
export interface AssetLiveInfo {
  liveStatus: "online" | "offline" | null;
  serialNumber: string | null;
  model: string | null;
  manufacturer: string | null;
  ipAddresses: string[] | null;
  // Both come straight from the linked agent's last telemetry snapshot, same
  // as serialNumber/model/manufacturer above — null for a "peripheral" asset
  // (no telemetry of its own) or if the linked computer hasn't reported a
  // snapshot yet.
  cpuModel: string | null;
  physicalDisks: PhysicalDiskInfo[] | null;
  // The most recent asset_connection_history episode for a "peripheral"
  // asset — null for all three fields if it's never actually been tracked
  // connecting to anything (only manually set at registration, never
  // confirmed on the wire). lastConnectionDisconnectedAt is null while that
  // episode is still open (i.e. this is where it's connected *right now*).
  lastConnectionAgentId: string | null;
  lastConnectedAt: string | null;
  lastConnectionDisconnectedAt: string | null;
}

export type AssetWithLiveInfo = AssetRecord & AssetLiveInfo;

interface AssetRow {
  asset_tag: string;
  agent_id: string | null;
  status: string;
  category: string | null;
  location: string | null;
  order_number: string | null;
  checked_out_to: string | null;
  checkout_date: string | null;
  expected_checkin_date: string | null;
  eol_date: string | null;
  notes: string | null;
  manual_serial_number: string | null;
  asset_type: AssetType;
  parent_agent_id: string | null;
  created_at: string;
  updated_at: string;
  live_status?: "online" | "offline" | null;
  serial_number?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  ip_addresses?: string[] | null;
  cpu_model?: string | null;
  physical_disks?: PhysicalDiskInfo[] | null;
  last_connection_agent_id?: string | null;
  last_connected_at?: string | null;
  last_connection_disconnected_at?: string | null;
}

function rowToAsset(row: AssetRow): AssetWithLiveInfo {
  return {
    assetTag: row.asset_tag,
    agentId: row.agent_id,
    status: row.status,
    category: row.category,
    location: row.location,
    orderNumber: row.order_number,
    checkedOutTo: row.checked_out_to,
    checkoutDate: row.checkout_date,
    expectedCheckinDate: row.expected_checkin_date,
    eolDate: row.eol_date,
    notes: row.notes,
    manualSerialNumber: row.manual_serial_number,
    assetType: row.asset_type,
    parentAgentId: row.parent_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    liveStatus: row.live_status ?? null,
    serialNumber: row.serial_number ?? null,
    model: row.model ?? null,
    manufacturer: row.manufacturer ?? null,
    ipAddresses: row.ip_addresses ?? null,
    cpuModel: row.cpu_model ?? null,
    physicalDisks: row.physical_disks ?? null,
    lastConnectionAgentId: row.last_connection_agent_id ?? null,
    lastConnectedAt: row.last_connected_at ?? null,
    lastConnectionDisconnectedAt: row.last_connection_disconnected_at ?? null,
  };
}

// Explicit column list rather than `a.*`: the assets table has its own
// manufacturer/model columns (the stored fallback for peripheral assets),
// which would otherwise collide by name with the COALESCEd read-side
// manufacturer/model computed below. The agents join includes org_id on
// both sides — without it, an asset could join against a same-hostname
// agent belonging to a *different* org (agent_id alone is not unique across
// organizations, see this file's top comment).
export async function listAssets(pool: Pool, orgId: string): Promise<AssetWithLiveInfo[]> {
  const { rows } = await pool.query<AssetRow>(
    `SELECT a.asset_tag, a.agent_id, a.status, a.category, a.location, a.order_number,
            a.checked_out_to, a.checkout_date, a.expected_checkin_date, a.eol_date,
            a.notes, a.manual_serial_number, a.asset_type, a.parent_agent_id,
            a.created_at, a.updated_at,
            ag.status AS live_status,
            COALESCE(ag.last_telemetry->>'serial_number', a.manual_serial_number) AS serial_number,
            COALESCE(ag.last_telemetry->>'model', a.model) AS model,
            COALESCE(ag.last_telemetry->>'manufacturer', a.manufacturer) AS manufacturer,
            ag.last_telemetry->'ip_addresses' AS ip_addresses,
            ag.last_telemetry->>'cpu_model' AS cpu_model,
            ag.last_telemetry->'physical_disks' AS physical_disks,
            lc.agent_id AS last_connection_agent_id,
            lc.connected_at AS last_connected_at,
            lc.disconnected_at AS last_connection_disconnected_at
     FROM assets a
     LEFT JOIN agents ag ON ag.agent_id = a.agent_id AND ag.org_id = a.org_id
     LEFT JOIN LATERAL (
       SELECT agent_id, connected_at, disconnected_at
       FROM asset_connection_history h
       WHERE h.asset_tag = a.asset_tag AND h.org_id = a.org_id
       ORDER BY connected_at DESC
       LIMIT 1
     ) lc ON true
     WHERE a.org_id = $1
     ORDER BY a.asset_tag ASC`,
    [orgId],
  );
  return rows.map(rowToAsset);
}

// Devices that have connected at least once but have no asset record yet —
// backs a "quickly register this device" prompt in the UI rather than
// requiring every asset to be typed in from scratch.
export async function listUnregisteredAgents(pool: Pool, orgId: string): Promise<string[]> {
  const { rows } = await pool.query<{ agent_id: string }>(
    `SELECT ag.agent_id FROM agents ag
     LEFT JOIN assets a ON a.agent_id = ag.agent_id AND a.org_id = ag.org_id
     WHERE ag.org_id = $1 AND a.asset_tag IS NULL
     ORDER BY ag.agent_id ASC`,
    [orgId],
  );
  return rows.map((r) => r.agent_id);
}

// Per-org sequential numbering — a shared global sequence would leak rough
// cross-org signup/fleet-size volume to anyone who ever sees another org's
// tag (support screenshots, shared documentation), which a customer's own
// inventory numbering has no reason to expose.
export async function nextAssetTag(pool: Pool, orgId: string): Promise<string> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM assets WHERE org_id = $1`, [orgId]);
  const n = (rows[0]?.n ?? 0) + 1;
  return `OF-${String(n).padStart(4, "0")}`;
}

export interface AssetInput {
  agentId?: string | null | undefined;
  status?: string | undefined;
  category?: string | null | undefined;
  location?: string | null | undefined;
  orderNumber?: string | null | undefined;
  checkedOutTo?: string | null | undefined;
  checkoutDate?: string | null | undefined;
  expectedCheckinDate?: string | null | undefined;
  eolDate?: string | null | undefined;
  notes?: string | null | undefined;
  manualSerialNumber?: string | null | undefined;
  assetType?: AssetType | undefined;
  manufacturer?: string | null | undefined;
  model?: string | null | undefined;
  parentAgentId?: string | null | undefined;
}

export async function createAsset(pool: Pool, orgId: string, assetTag: string, input: AssetInput): Promise<AssetRecord> {
  const { rows } = await pool.query<AssetRow>(
    `INSERT INTO assets
       (org_id, asset_tag, agent_id, status, category, location, order_number, checked_out_to, checkout_date, expected_checkin_date, eol_date, notes, manual_serial_number, asset_type, manufacturer, model, parent_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      orgId,
      assetTag,
      input.agentId ?? null,
      input.status ?? "ready_to_deploy",
      input.category ?? null,
      input.location ?? null,
      input.orderNumber ?? null,
      input.checkedOutTo ?? null,
      input.checkoutDate ?? null,
      input.expectedCheckinDate ?? null,
      input.eolDate ?? null,
      input.notes ?? null,
      input.manualSerialNumber ?? null,
      input.assetType ?? "computer",
      input.manufacturer ?? null,
      input.model ?? null,
      input.parentAgentId ?? null,
    ],
  );
  return rowToAsset(rows[0]!);
}

// Only fields actually present in `input` are touched — a field left
// `undefined` keeps its stored value, while an explicit "" clears it to
// NULL. This needs a dynamically-built SET clause (still fully
// parameterized — only column names are hardcoded literals, never user
// input) rather than a single fixed UPDATE, because a fixed COALESCE-based
// query can't distinguish "leave this alone" from "clear this field".
export async function updateAsset(pool: Pool, orgId: string, assetTag: string, input: Partial<AssetInput>): Promise<AssetRecord | null> {
  const columns: Record<string, unknown> = {
    agent_id: input.agentId,
    status: input.status,
    category: input.category,
    location: input.location,
    order_number: input.orderNumber,
    checked_out_to: input.checkedOutTo,
    checkout_date: input.checkoutDate,
    expected_checkin_date: input.expectedCheckinDate,
    eol_date: input.eolDate,
    notes: input.notes,
    manual_serial_number: input.manualSerialNumber,
    asset_type: input.assetType,
    manufacturer: input.manufacturer,
    model: input.model,
    parent_agent_id: input.parentAgentId,
  };

  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [assetTag, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val === "" ? null : val);
    sets.push(`${col} = $${values.length}`);
  }

  const { rows } = await pool.query<AssetRow>(
    `UPDATE assets SET ${sets.join(", ")} WHERE asset_tag = $1 AND org_id = $2 RETURNING *`,
    values,
  );
  return rows.length ? rowToAsset(rows[0]!) : null;
}

// Finds a pre-registered asset (created before its device ever connected)
// whose hand-entered serial matches a live one just seen in telemetry, so
// the caller can link the two instead of creating a duplicate row. Only
// candidates with no agent_id yet are eligible — an asset already linked to
// a different agent is never repointed by a serial coincidence. org-scoped:
// without this, an org A device could silently merge into an org B
// pre-registered asset that happens to share a serial number.
export async function findUnlinkedAssetBySerial(pool: Pool, orgId: string, serial: string): Promise<string | null> {
  const { rows } = await pool.query<{ asset_tag: string }>(
    `SELECT asset_tag FROM assets WHERE org_id = $1 AND agent_id IS NULL AND manual_serial_number = $2 LIMIT 1`,
    [orgId, serial],
  );
  return rows[0]?.asset_tag ?? null;
}

// Finds a "peripheral" asset (a monitor, say) by its own hand-entered
// serial, regardless of link state — used by db/persistence.ts's
// connection-history tracking to recognize a peripheral that's shown up on
// some agent's connected_devices list, whether or not it's currently linked
// to that same agent. org-scoped for the same cross-org-merge reason as
// findUnlinkedAssetBySerial above.
export async function findPeripheralAssetBySerial(
  pool: Pool,
  orgId: string,
  serial: string,
): Promise<{ assetTag: string; parentAgentId: string | null } | null> {
  const { rows } = await pool.query<{ asset_tag: string; parent_agent_id: string | null }>(
    `SELECT asset_tag, parent_agent_id FROM assets WHERE org_id = $1 AND asset_type = 'peripheral' AND manual_serial_number = $2 LIMIT 1`,
    [orgId, serial],
  );
  return rows[0] ? { assetTag: rows[0].asset_tag, parentAgentId: rows[0].parent_agent_id } : null;
}

export async function deleteAsset(pool: Pool, orgId: string, assetTag: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM assets WHERE asset_tag = $1 AND org_id = $2`, [assetTag, orgId]);
  return (rowCount ?? 0) > 0;
}
