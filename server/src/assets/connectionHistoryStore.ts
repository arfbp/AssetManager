// Which computer(s) a peripheral asset has actually been connected through
// over time — see schema.sql's asset_connection_history comment for why
// this exists separately from assets.parent_agent_id (which only ever
// holds the most recent one).
//
// asset_tag is only unique within an org (see migrations/0006 — per-org
// sequential numbering means "OF-0001" exists in every org), so every
// lookup here takes an orgId alongside it.
import type { Pool } from "pg";

export interface ConnectionHistoryEntry {
  agentId: string;
  connectedAt: string;
  disconnectedAt: string | null;
}

interface ConnectionHistoryRow {
  agent_id: string;
  connected_at: string;
  disconnected_at: string | null;
}

export async function listConnectionHistory(pool: Pool, orgId: string, assetTag: string): Promise<ConnectionHistoryEntry[]> {
  const { rows } = await pool.query<ConnectionHistoryRow>(
    `SELECT agent_id, connected_at, disconnected_at FROM asset_connection_history
     WHERE org_id = $1 AND asset_tag = $2 ORDER BY connected_at DESC`,
    [orgId, assetTag],
  );
  return rows.map((r) => ({ agentId: r.agent_id, connectedAt: r.connected_at, disconnectedAt: r.disconnected_at }));
}

// Finds the currently-open (disconnected_at IS NULL) episode for this asset,
// if any — regardless of which agent it's open against.
export async function findOpenConnection(pool: Pool, orgId: string, assetTag: string): Promise<{ agentId: string } | null> {
  const { rows } = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM asset_connection_history WHERE org_id = $1 AND asset_tag = $2 AND disconnected_at IS NULL LIMIT 1`,
    [orgId, assetTag],
  );
  return rows[0] ? { agentId: rows[0].agent_id } : null;
}

export async function closeConnection(pool: Pool, orgId: string, assetTag: string, agentId: string): Promise<void> {
  await pool.query(
    `UPDATE asset_connection_history SET disconnected_at = now()
     WHERE org_id = $1 AND asset_tag = $2 AND agent_id = $3 AND disconnected_at IS NULL`,
    [orgId, assetTag, agentId],
  );
}

export async function openConnection(pool: Pool, orgId: string, assetTag: string, agentId: string): Promise<void> {
  await pool.query(`INSERT INTO asset_connection_history (org_id, asset_tag, agent_id) VALUES ($1, $2, $3)`, [
    orgId,
    assetTag,
    agentId,
  ]);
}
