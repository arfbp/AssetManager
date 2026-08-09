// Per-org agent credentials (auth token + HMAC secret), replacing the old
// single fleet-wide OPTIFLEET_AGENT_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET pair.
// Warm-started from `organizations` at boot and cached in memory —
// credential rotation is a rare, deliberate operator action (see
// migrations/0004's doc comment and the multi-tenant migration plan's Phase
// 3b), not something that needs same-request freshness the way a role or
// org change does (validateSession's role/org_id join), so a process-
// lifetime cache refreshed only on demand (new org created) is the right
// tradeoff — a DB round-trip per agent heartbeat would be wasteful for
// something that essentially never changes.
//
// Also caches orgs' custom domains (organizations.custom_domain, see
// migrations/0007) for the same reason: index.ts's CORS origin check needs
// a synchronous, in-memory answer per request, and a custom domain is set
// even more rarely than a credential is rotated.
import type { Pool } from "pg";

export interface OrgCredential {
  orgId: string;
  hmacSecret: string;
}

export class OrgCredentialCache {
  private byToken = new Map<string, OrgCredential>();
  // Reverse index of the same rows, keyed by orgId — needed wherever a
  // request is already known to belong to an org (e.g. req.user.orgId after
  // session validation) and just needs that org's own hmacSecret to sign an
  // outgoing command, as opposed to byToken's "which org does this agent's
  // bearer token belong to" direction used at connect time.
  private byOrgId = new Map<string, string>();
  // Full "https://<domain>" origins, ready for a direct match against the
  // browser's Origin header — not bare domains, so index.ts doesn't need to
  // reconstruct the scheme on every request.
  private customDomainOrigins = new Set<string>();

  static async load(pool: Pool): Promise<OrgCredentialCache> {
    const cache = new OrgCredentialCache();
    await cache.reload(pool);
    return cache;
  }

  async reload(pool: Pool): Promise<void> {
    // status = 'active' — a suspended org's agent token simply stops
    // resolving here, the same generic rejection every other invalid
    // token already gets in verifyClient (ws/server.ts). No special-casing
    // needed anywhere else: this is the one place agent auth is resolved.
    const { rows } = await pool.query<{ id: string; agent_auth_token: string; agent_hmac_secret: string }>(
      `SELECT id, agent_auth_token, agent_hmac_secret FROM organizations WHERE agent_auth_token <> '' AND status = 'active'`,
    );
    const next = new Map<string, OrgCredential>();
    const nextByOrgId = new Map<string, string>();
    for (const row of rows) {
      next.set(row.agent_auth_token, { orgId: row.id, hmacSecret: row.agent_hmac_secret });
      nextByOrgId.set(row.id, row.agent_hmac_secret);
    }
    this.byToken = next;
    this.byOrgId = nextByOrgId;

    const { rows: domainRows } = await pool.query<{ custom_domain: string }>(
      `SELECT custom_domain FROM organizations WHERE custom_domain IS NOT NULL`,
    );
    this.customDomainOrigins = new Set(domainRows.map((r) => `https://${r.custom_domain.toLowerCase()}`));
  }

  resolveByToken(token: string): OrgCredential | null {
    return this.byToken.get(token) ?? null;
  }

  resolveByOrgId(orgId: string): string | null {
    return this.byOrgId.get(orgId) ?? null;
  }

  hasCustomDomainOrigin(origin: string): boolean {
    return this.customDomainOrigins.has(origin.toLowerCase());
  }
}
