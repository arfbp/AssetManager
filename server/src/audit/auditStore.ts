// Persists platform-admin actions to Postgres so they're visible from the
// dashboard — distinct from server/src/logger.ts's `audit` Pino logger,
// which every one of these call sites ALSO still calls (that one's for
// ops/stdout, this one's for the product). Deliberately scoped to actions
// gated by routes.ts's requirePlatformAdmin specifically, not general
// per-org activity — see migrations/0010_audit_events.sql's doc comment.
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
