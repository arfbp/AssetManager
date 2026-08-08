// Resolves which organization a login request belongs to, from the
// subdomain the frontend observed via window.location.hostname (sent as a
// header, not derived server-side from the request's own Host — the
// frontend/API are deliberately kept as separate origins, see
// frontend/src/lib/session.ts's currentOrgSubdomain()). This is the ONLY
// place subdomain resolution matters: every request after login already
// carries org identity via the session token (validateSession joins it in
// the same way it already joins role), so no other route needs this.
//
// The header carries either a bare subdomain label (e.g. "360qm", matched
// against organizations.subdomain) or, for an org on its own fully-owned
// domain (e.g. "assets.360qm.co.th"), the full hostname (matched against
// organizations.custom_domain) — currentOrgSubdomain() decides which shape
// to send based on whether the browser's hostname falls under the shared
// org-domain suffix.
import type { Pool } from "pg";

export async function resolveOrgBySubdomain(pool: Pool, subdomain: string): Promise<{ id: string; name: string } | null> {
  const value = subdomain.trim().toLowerCase();
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE (lower(subdomain) = $1 OR lower(custom_domain) = $1) AND status = 'active'`,
    [value],
  );
  return rows[0] ?? null;
}
