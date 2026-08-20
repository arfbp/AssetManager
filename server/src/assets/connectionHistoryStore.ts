// computer เครื่องไหนบ้างที่ peripheral asset ตัวนี้เคยเชื่อมต่อผ่านมาตาม
// ช่วงเวลา — ดู comment ของ asset_connection_history ใน schema.sql ว่าทำไม
// ถึงต้องแยกออกจาก assets.parent_agent_id (ซึ่งเก็บได้แค่ตัวล่าสุดตัวเดียว)
//
// asset_tag unique แค่ภายใน org เดียวกันเท่านั้น (ดู migrations/0006 — การ
// เรียงเลขแยกตาม org หมายความว่า "OF-0001" มีอยู่ในทุก org) ดังนั้นการค้นหา
// ทุกจุดในไฟล์นี้จึงต้องรับ orgId มาด้วยเสมอ
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

// ค้นหาช่วงที่ยังเปิดอยู่ (disconnected_at IS NULL) ของ asset นี้ ถ้ามี —
// ไม่สนว่ากำลังเปิดอยู่กับ agent ตัวไหน
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
