// จุดเข้าถึงข้อมูล incident log ต่ออุปกรณ์ — ดู comment ของตาราง
// device_incidents ใน schema.sql สำหรับดีไซน์ "หนึ่งแถวต่อหนึ่งเหตุการณ์
// ไม่ใช่ต่อการ poll แต่ละครั้ง"
import type { Pool } from "pg";

export interface IncidentRecord {
  id: number;
  agentId: string;
  kind: string;
  message: string;
  occurredAt: string;
  resolvedAt: string | null;
}

interface IncidentRow {
  id: string;
  agent_id: string;
  kind: string;
  message: string;
  occurred_at: string;
  resolved_at: string | null;
}

function rowToIncident(row: IncidentRow): IncidentRecord {
  return {
    id: Number(row.id),
    agentId: row.agent_id,
    kind: row.kind,
    message: row.message,
    occurredAt: row.occurred_at,
    resolvedAt: row.resolved_at,
  };
}

export async function openIncident(pool: Pool, orgId: string, agentId: string, kind: string, message: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO device_incidents (org_id, agent_id, kind, message) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, agentId, kind, message],
  );
  return Number(rows[0]!.id);
}

export async function resolveIncident(pool: Pool, id: number): Promise<void> {
  await pool.query(`UPDATE device_incidents SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL`, [id]);
}

// จำกัดไว้ที่ 200 แถว — เพราะนี่คือ feed เหตุการณ์ล่าสุดสำหรับผู้ควบคุมดู ไม่ใช่
// การ export ข้อมูล audit เต็มรูปแบบ
export async function listIncidents(pool: Pool, orgId: string, agentId: string): Promise<IncidentRecord[]> {
  const { rows } = await pool.query<IncidentRow>(
    `SELECT * FROM device_incidents WHERE org_id = $2 AND agent_id = $1 ORDER BY occurred_at DESC LIMIT 200`,
    [agentId, orgId],
  );
  return rows.map(rowToIncident);
}

export interface IncidentSummary {
  agentId: string;
  incidentCount: number;
  lastIncidentAt: string;
}

// อันดับ "อุปกรณ์ไหนมีปัญหามากที่สุด" ทั้ง fleet สำหรับ Dashboard — เป็นแค่
// การนับรวมล้วน ๆ จาก device_incidents ไม่มี LLM เข้ามาเกี่ยวข้องเลย (ต่างจาก
// การวิเคราะห์ "ควรเปลี่ยนเครื่องนี้ไหม?" รายอุปกรณ์ ซึ่งเรียกโมเดลจริงและ
// ตั้งใจทำให้เป็นปุ่มกดตามต้องการ แทนที่จะคำนวณอัตโนมัติให้ทุกอุปกรณ์)
// อุปกรณ์ที่ไม่มี incident เลยในช่วงเวลานั้นจะไม่ปรากฏเลย ไม่ใช่คืนมาเป็นแถว
// ที่นับได้ 0
export async function listIncidentSummary(pool: Pool, orgId: string, days: number, limit: number): Promise<IncidentSummary[]> {
  const { rows } = await pool.query<{ agent_id: string; incident_count: string; last_incident_at: string }>(
    `SELECT agent_id, count(*) AS incident_count, max(occurred_at) AS last_incident_at
     FROM device_incidents
     WHERE org_id = $3 AND occurred_at > now() - (interval '1 day' * $1::double precision)
     GROUP BY agent_id
     ORDER BY incident_count DESC, last_incident_at DESC
     LIMIT $2`,
    [days, limit, orgId],
  );
  return rows.map((r) => ({
    agentId: r.agent_id,
    incidentCount: Number(r.incident_count),
    lastIncidentAt: r.last_incident_at,
  }));
}
