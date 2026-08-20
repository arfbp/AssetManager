// ไทม์ไลน์ประวัติของ asset แต่ละชิ้นแบบรวมศูนย์ — รวม handover (เบิกออก /
// คืนเข้า), บันทึกการซ่อมบำรุง (นัดหมาย / เสร็จสิ้น) และช่วงเวลาที่เชื่อมต่อ
// อุปกรณ์ต่อพ่วงเข้าเป็นลิสต์เดียวที่เรียงลำดับแล้ว ใช้แสดงในแท็บ "History"
// ของหน้ารายละเอียด asset ใช้ query แยกกัน 3 ครั้งแล้วรวมในหน่วยความจำ
// (ไม่ทำเป็น SQL UNION ก้อนเดียว) เพราะแต่ละตารางต้นทางมีโครงสร้างต่างกัน
// การแยกแบบนี้อ่าน/ต่อยอดง่ายกว่า และจำนวนแถวต่อ asset ก็น้อยพอที่ไม่จำเป็น
// ต้องรวมเป็น query เดียวเพื่อประสิทธิภาพ
import type { Pool } from "pg";

export type AssetHistoryEventKind =
  | "handover_out"
  | "handover_returned"
  | "maintenance_scheduled"
  | "maintenance_completed"
  | "connection"
  | "transfer"
  | "adjustment"
  | "retirement";

export interface AssetHistoryEvent {
  kind: AssetHistoryEventKind;
  at: string;
  summary: string;
}

export async function getAssetHistory(pool: Pool, orgId: string, assetTag: string): Promise<AssetHistoryEvent[]> {
  const events: AssetHistoryEvent[] = [];

  const { rows: handovers } = await pool.query<{ employee_name: string; created_at: string; returned_at: string | null }>(
    `SELECT employee_name, created_at, returned_at FROM handovers WHERE org_id = $1 AND asset_tag = $2 ORDER BY created_at DESC`,
    [orgId, assetTag],
  );
  for (const h of handovers) {
    events.push({ kind: "handover_out", at: h.created_at, summary: `Checked out to ${h.employee_name}` });
    if (h.returned_at) events.push({ kind: "handover_returned", at: h.returned_at, summary: `Checked in (was with ${h.employee_name})` });
  }

  const { rows: maintenance } = await pool.query<{ description: string; scheduled_date: string | null; completed_date: string | null; created_at: string }>(
    `SELECT description, scheduled_date, completed_date, created_at FROM maintenance_records WHERE org_id = $1 AND asset_tag = $2 ORDER BY created_at DESC`,
    [orgId, assetTag],
  );
  for (const m of maintenance) {
    events.push({ kind: "maintenance_scheduled", at: m.scheduled_date ?? m.created_at, summary: `Maintenance scheduled: ${m.description}` });
    if (m.completed_date) events.push({ kind: "maintenance_completed", at: m.completed_date, summary: `Maintenance completed: ${m.description}` });
  }

  const { rows: connections } = await pool.query<{ agent_id: string; connected_at: string; disconnected_at: string | null }>(
    `SELECT agent_id, connected_at, disconnected_at FROM asset_connection_history WHERE org_id = $1 AND asset_tag = $2 ORDER BY connected_at DESC`,
    [orgId, assetTag],
  );
  for (const c of connections) {
    events.push({
      kind: "connection",
      at: c.connected_at,
      summary: c.disconnected_at ? `Connected to ${c.agent_id} (disconnected ${c.disconnected_at})` : `Connected to ${c.agent_id} (still connected)`,
    });
  }

  const { rows: transfers } = await pool.query<{ to_location: string | null; to_department: string | null; transfer_date: string }>(
    `SELECT to_location, to_department, transfer_date FROM asset_transfers WHERE org_id = $1 AND asset_tag = $2 ORDER BY transfer_date DESC`,
    [orgId, assetTag],
  );
  for (const t of transfers) {
    const dest = [t.to_location, t.to_department].filter(Boolean).join(" / ");
    events.push({ kind: "transfer", at: t.transfer_date, summary: dest ? `Transferred to ${dest}` : "Transferred" });
  }

  const { rows: adjustments } = await pool.query<{ field_changed: string; old_value: string | null; new_value: string | null; adjustment_date: string }>(
    `SELECT field_changed, old_value, new_value, adjustment_date FROM asset_adjustments WHERE org_id = $1 AND asset_tag = $2 ORDER BY adjustment_date DESC`,
    [orgId, assetTag],
  );
  for (const a of adjustments) {
    events.push({ kind: "adjustment", at: a.adjustment_date, summary: `Adjusted ${a.field_changed}: ${a.old_value ?? "—"} → ${a.new_value ?? "—"}` });
  }

  const { rows: retirements } = await pool.query<{ reason: string; retirement_date: string }>(
    `SELECT reason, retirement_date FROM asset_retirements WHERE org_id = $1 AND asset_tag = $2 ORDER BY retirement_date DESC`,
    [orgId, assetTag],
  );
  for (const r of retirements) {
    events.push({ kind: "retirement", at: r.retirement_date, summary: `Retired (${r.reason})` });
  }

  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
