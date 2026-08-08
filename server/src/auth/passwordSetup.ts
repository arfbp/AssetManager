// Self-service "set your own password" tokens — replaces the old flow where
// a platform admin hand-picked a new org's admin password and relayed it
// manually over chat/email (a plaintext-password-in-transit pattern). Same
// opaque-random-token-in-Postgres shape as sessions.ts's own tokens, for the
// same reason: revocation/expiry is a plain DB check, not a signature to
// trust.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword } from "./passwords.js";

const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches session TTL

export async function createSetupToken(pool: Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_MS);
  await pool.query(`INSERT INTO password_setup_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`, [
    token,
    userId,
    expiresAt,
  ]);
  return token;
}

// Validates the token (exists, unexpired, unused) and sets the password in
// one go — there's no separate "peek at the token" step before submission,
// same "don't leak which part of a lookup failed" posture as login, just
// applied to an invite link instead of a password. Returns false (not an
// error) for any invalid/expired/used token, so callers can respond with
// one generic message regardless of which check failed.
export async function consumeSetupToken(pool: Pool, token: string, newPassword: string): Promise<boolean> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM password_setup_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > now()`,
    [token],
  );
  const row = rows[0];
  if (!row) return false;

  const passwordHash = await hashPassword(newPassword);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, row.user_id]);
  await pool.query(`UPDATE password_setup_tokens SET used_at = now() WHERE token = $1`, [token]);
  return true;
}
