// Session tokens are opaque random strings looked up in Postgres, not JWTs —
// revocation is a DELETE, and validity is a DB read rather than trusting a
// signature the server has no way to invalidate before its own expiry.
// Stored in Postgres (not memory) so a logged-in session survives a server
// restart instead of forcing every operator to log in again each time.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Role } from "./roles.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Session {
  token: string;
  userId: string;
  username: string;
  // Read fresh from `users` on every validateSession call (joined, not
  // stored on the session row) — an admin changing someone's role takes
  // effect on that user's very next request, not just their next login.
  role: Role;
  // Same "read fresh via join, never cached" treatment as role — moving a
  // user between orgs (if that ever happens) takes effect immediately too.
  orgId: string;
}

export async function createSession(pool: Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`, [
    token,
    userId,
    expiresAt,
  ]);
  return token;
}

export async function validateSession(pool: Pool, token: string): Promise<Session | null> {
  if (!token) return null;
  const { rows } = await pool.query<{ token: string; user_id: string; username: string; role: Role; org_id: string }>(
    `SELECT s.token, s.user_id, u.username, u.role, u.org_id FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { token: row.token, userId: row.user_id, username: row.username, role: row.role, orgId: row.org_id };
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}
