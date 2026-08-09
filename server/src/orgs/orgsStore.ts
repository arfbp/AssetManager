// Organization (tenant) management — creating new orgs and listing existing
// ones. Deliberately separate from auth/users.ts: creating an ORG is a
// platform-level operation (who's allowed to do it is gated in routes.ts by
// PLATFORM_ORG_ID below, not by the regular per-org admin role), creating a
// USER within an already-existing org is what auth/users.ts handles.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";

// The original single-tenant fleet's fixed UUID (migrations/0001_organizations.sql)
// doubles as "the platform owner's org" until a real multi-admin platform-
// governance model exists (see the multi-tenant migration plan's Phase 9) —
// only this org's admins can create/list other organizations. Not a
// meaningful restriction today (there's exactly one such admin, the person
// operating this whole deployment), but keeps the capability from being
// silently available to a future org's own admin just because they're also
// role "admin" within their own org.
export const PLATFORM_ORG_ID = "00000000-0000-0000-0000-000000000001";

export interface OrganizationSummary {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  status: string;
  createdAt: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  subdomain: string;
  custom_domain: string | null;
  status: string;
  created_at: string;
}

function rowToSummary(row: OrganizationRow): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    subdomain: row.subdomain,
    customDomain: row.custom_domain,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function listOrganizations(pool: Pool): Promise<OrganizationSummary[]> {
  const { rows } = await pool.query<OrganizationRow>(
    `SELECT id, name, subdomain, custom_domain, status, created_at FROM organizations ORDER BY created_at ASC`,
  );
  return rows.map(rowToSummary);
}

export class DuplicateCustomDomainError extends Error {
  constructor(domain: string) {
    super(`custom domain "${domain}" is already taken`);
    this.name = "DuplicateCustomDomainError";
  }
}

// Assigns (or clears, with domain === null) an org's own fully-owned domain.
// Callers must call OrgCredentialCache#reload afterward so the CORS
// allow-list (which is warm-cached, same rationale as agent credentials —
// see orgCredentials.ts) picks up the change without a server restart.
export async function setCustomDomain(pool: Pool, orgId: string, domain: string | null): Promise<OrganizationSummary> {
  try {
    const { rows } = await pool.query<OrganizationRow>(
      `UPDATE organizations SET custom_domain = $2 WHERE id = $1
       RETURNING id, name, subdomain, custom_domain, status, created_at`,
      [orgId, domain],
    );
    const row = rows[0];
    if (!row) throw new Error(`organization not found: ${orgId}`);
    return rowToSummary(row);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505" && domain) {
      throw new DuplicateCustomDomainError(domain);
    }
    throw err;
  }
}

// Unlike the credentials returned once at creation time, this genuinely IS
// re-readable — organizations.agent_auth_token/agent_hmac_secret are stored
// in plain text in Postgres regardless (verifyClient needs the literal
// value on every agent connection, unlike a bcrypt-hashed user password),
// so there's no real secrecy left to preserve by refusing to serve it back
// out again here. What this enables: regenerating/redownloading an org's
// installer .zip later without needing to have copied the credentials down
// at creation time — see GET /api/orgs/:id/installer.
export async function getOrganizationCredentials(
  pool: Pool,
  orgId: string,
): Promise<{ org: OrganizationSummary; agentAuthToken: string; agentHmacSecret: string } | null> {
  const { rows } = await pool.query<OrganizationRow & { agent_auth_token: string; agent_hmac_secret: string }>(
    `SELECT id, name, subdomain, custom_domain, status, created_at, agent_auth_token, agent_hmac_secret FROM organizations WHERE id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) return null;
  return { org: rowToSummary(row), agentAuthToken: row.agent_auth_token, agentHmacSecret: row.agent_hmac_secret };
}

export class DuplicateSubdomainError extends Error {
  constructor(subdomain: string) {
    super(`subdomain "${subdomain}" is already taken`);
    this.name = "DuplicateSubdomainError";
  }
}

export interface NewOrganization {
  org: OrganizationSummary;
  // Returned once, at creation — same "shown once, write it down" treatment
  // as any other freshly generated secret. Not retrievable again afterward
  // through any other endpoint (organizations.agent_auth_token is never
  // selected back out except by the org-credential cache's own boot-time
  // load and this one INSERT ... RETURNING).
  agentAuthToken: string;
  agentHmacSecret: string;
}

// Subdomains are DNS labels (become e.g. "<subdomain>.optifleet.ai" once
// Phase 6's real domain is live) — lowercase letters/digits/hyphens only,
// can't start/end with a hyphen, matches what nginx's server_name regex and
// certbot would both accept.
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSubdomain(subdomain: string): boolean {
  return SUBDOMAIN_PATTERN.test(subdomain);
}

// A full FQDN an org brings on its own (e.g. "assets.360qm.co.th"), as
// opposed to a bare label under the shared orgDomainSuffix — same
// label-level rules as SUBDOMAIN_PATTERN, repeated across one or more
// dot-separated labels.
const CUSTOM_DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidCustomDomain(domain: string): boolean {
  return CUSTOM_DOMAIN_PATTERN.test(domain);
}

export async function createOrganization(pool: Pool, name: string, subdomain: string): Promise<NewOrganization> {
  const agentAuthToken = randomBytes(32).toString("hex");
  const agentHmacSecret = randomBytes(32).toString("hex");
  try {
    const { rows } = await pool.query<OrganizationRow & { agent_auth_token: string; agent_hmac_secret: string }>(
      `INSERT INTO organizations (name, subdomain, agent_auth_token, agent_hmac_secret)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, subdomain, custom_domain, status, created_at, agent_auth_token, agent_hmac_secret`,
      [name, subdomain, agentAuthToken, agentHmacSecret],
    );
    const row = rows[0]!;
    return { org: rowToSummary(row), agentAuthToken: row.agent_auth_token, agentHmacSecret: row.agent_hmac_secret };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new DuplicateSubdomainError(subdomain);
    }
    throw err;
  }
}

// Thrown by every operation below that would otherwise let the platform
// org (PLATFORM_ORG_ID) be suspended or deleted — that org holds the only
// accounts capable of managing every other org, so doing either to it would
// be a total, unrecoverable platform lockout with no other path back in.
export class PlatformOrgProtectedError extends Error {
  constructor(action: string) {
    super(`The platform organization can't be ${action} — it would lock out every platform admin.`);
    this.name = "PlatformOrgProtectedError";
  }
}

export async function setOrgStatus(pool: Pool, orgId: string, status: "active" | "suspended"): Promise<OrganizationSummary> {
  if (orgId === PLATFORM_ORG_ID && status === "suspended") throw new PlatformOrgProtectedError("suspended");
  const { rows } = await pool.query<OrganizationRow>(
    `UPDATE organizations SET status = $2 WHERE id = $1
     RETURNING id, name, subdomain, custom_domain, status, created_at`,
    [orgId, status],
  );
  const row = rows[0];
  if (!row) throw new Error(`organization not found: ${orgId}`);
  return rowToSummary(row);
}

// Every field optional — same "combine everything in one call" shape as
// auth/users.ts's updateUserProfile/PATCH /users/:id.
export async function updateOrganization(
  pool: Pool,
  orgId: string,
  fields: { name?: string | undefined; subdomain?: string | undefined },
): Promise<OrganizationSummary> {
  try {
    if (fields.name !== undefined) {
      await pool.query(`UPDATE organizations SET name = $2 WHERE id = $1`, [orgId, fields.name]);
    }
    if (fields.subdomain !== undefined) {
      await pool.query(`UPDATE organizations SET subdomain = $2 WHERE id = $1`, [orgId, fields.subdomain]);
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new DuplicateSubdomainError(fields.subdomain ?? "");
    }
    throw err;
  }
  const { rows } = await pool.query<OrganizationRow>(
    `SELECT id, name, subdomain, custom_domain, status, created_at FROM organizations WHERE id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) throw new Error(`organization not found: ${orgId}`);
  return rowToSummary(row);
}

// Real, irreversible deletion of an org and every row that depends on it —
// every org_id foreign key in this schema was deliberately declared
// RESTRICT, not CASCADE (see migrations/0002_org_id_backfill.sql), so a
// bare `DELETE FROM organizations` would fail outright. This does the
// ordered cleanup by hand, in one transaction, in the same dependency
// order this project's own manual psql cleanups have used all along:
// telemetry/history/incidents first (nothing references them), then
// assets/agents, then sessions/setup-tokens (via users.org_id — both are
// ON DELETE CASCADE from users(id), see schema.sql and migrations/0008),
// then users themselves, then the org row. audit_events is deliberately
// left alone — its org_id is ON DELETE SET NULL, so it survives this by
// design (see migrations/0010's doc comment).
export async function deleteOrganization(pool: Pool, orgId: string): Promise<void> {
  if (orgId === PLATFORM_ORG_ID) throw new PlatformOrgProtectedError("deleted");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM telemetry_snapshots WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM command_history WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM device_incidents WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM asset_connection_history WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM assets WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agents WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE org_id = $1`, [orgId]);
    const { rowCount } = await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    if (!rowCount) throw new Error(`organization not found: ${orgId}`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
