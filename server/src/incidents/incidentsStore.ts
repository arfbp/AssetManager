// Per-device incident log data access — see schema.sql's device_incidents
// table comment for the "one row per episode, not per poll" design.
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

// Capped at 200 rows — this is an operator-facing recent-incident feed, not
// a full audit export.
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

// Fleet-wide "which devices act up the most" ranking for the Dashboard —
// pure aggregate count over device_incidents, no LLM involved (unlike the
// per-device "should we replace this?" analysis, which does call the model
// and is deliberately kept as an on-demand button rather than something
// computed automatically for every device). Devices with zero incidents in
// the window are simply absent, not returned as zero-count rows.
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
