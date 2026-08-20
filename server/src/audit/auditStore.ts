// บันทึกการกระทำของ platform-admin ลง Postgres เพื่อให้เห็นได้จาก dashboard
// — แยกออกจาก Pino logger `audit` ใน server/src/logger.ts ซึ่งทุกจุดที่เรียก
// ใช้ไฟล์นี้ก็ยังคงเรียกใช้ตัวนั้นควบคู่กันไปด้วย (ตัวนั้นมีไว้สำหรับ
// ops/stdout ส่วนตัวนี้มีไว้สำหรับตัวผลิตภัณฑ์เอง) ตั้งใจจำกัดขอบเขตเฉพาะ
// action ที่ถูกคุมด้วย requirePlatformAdmin ใน routes.ts เท่านั้น ไม่ใช่
// กิจกรรมทั่วไปของแต่ละ org — ดู doc comment ของ
// migrations/0010_audit_events.sql
import type { Pool } from "pg";

export interface AuditEvent {
  id: string;
  actorUsername: string;
  orgId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditEventRow {
  id: string;
  actor_username: string;
  org_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

function rowToEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    actorUsername: row.actor_username,
    orgId: row.org_id,
    action: row.action,
    details: row.details,
    createdAt: row.created_at,
  };
}

export async function recordAuditEvent(
  pool: Pool,
  event: { actorUsername: string; orgId: string | null; action: string; details?: Record<string, unknown> },
): Promise<void> {
  await pool.query(`INSERT INTO audit_events (actor_username, org_id, action, details) VALUES ($1, $2, $3, $4)`, [
    event.actorUsername,
    event.orgId,
    event.action,
    event.details ?? null,
  ]);
}

export async function listAuditEvents(pool: Pool, opts: { limit: number; offset: number }): Promise<{ events: AuditEvent[]; total: number }> {
  const { rows } = await pool.query<AuditEventRow>(
    `SELECT id, actor_username, org_id, action, details, created_at FROM audit_events
     ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [opts.limit, opts.offset],
  );
  const { rows: countRows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM audit_events`);
  return { events: rows.map(rowToEvent), total: Number(countRows[0]?.count ?? 0) };
}
