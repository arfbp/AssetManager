// User accounts. There is no public self-registration endpoint on purpose —
// the very first account is created by an administrator via
// `npm run user:create` (src/auth/createUser.ts, still works as a
// bootstrap/recovery path if every admin account is somehow locked out);
// every account after that is created through POST /api/users, gated to
// the 'admin' role by auth/roles.ts's requireRole. Same "nothing exists
// unless an operator explicitly configured it" philosophy already used for
// device groups (src/groups/deviceGroups.ts) and the agent's command
// allowlist.
//
// Every function here takes an orgId and filters/scopes by it — usernames
// are only unique within an org (see the `(org_id, username)` constraint in
// migrations/0003_users_org_scoped_username.sql), and every mutation is
// additionally constrained by org_id so an admin session from one org can
// never act on another org's user by guessing/enumerating a UUID, even
// though userId alone would otherwise be enough to find the row.
import type { Pool } from "pg";
import { verifyPassword, hashPassword } from "./passwords.js";
import type { Role } from "./roles.js";

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  orgId: string;
}

export interface UserSummary {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
  // Basic profile fields, separate from the login identifier (username) —
  // nullable because accounts created before this existed have neither.
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

interface UserSummaryRow {
  id: string;
  username: string;
  role: Role;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

function rowToSummary(row: UserSummaryRow): UserSummary {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
  };
}

export async function findUserByUsername(pool: Pool, orgId: string, username: string): Promise<UserRecord | null> {
  const { rows } = await pool.query<{ id: string; username: string; password_hash: string; role: Role; org_id: string }>(
    `SELECT id, username, password_hash, role, org_id FROM users WHERE org_id = $1 AND username = $2`,
    [orgId, username],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role, orgId: row.org_id };
}

// Always runs the bcrypt compare even when the username doesn't exist
// (against a fixed dummy hash) so a login attempt's response time doesn't
// leak whether the username is valid.
const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Q0/9AzMcTM8vXdVE0Vv3lZbowFVCG";

export async function verifyCredentials(
  pool: Pool,
  orgId: string,
  username: string,
  password: string,
): Promise<UserRecord | null> {
  const user = await findUserByUsername(pool, orgId, username);
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  return ok && user ? user : null;
}

export async function listUsers(pool: Pool, orgId: string): Promise<UserSummary[]> {
  const { rows } = await pool.query<UserSummaryRow>(
    `SELECT id, username, role, created_at, first_name, last_name, email FROM users WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  return rows.map(rowToSummary);
}

export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`username "${username}" is already taken`);
    this.name = "DuplicateUsernameError";
  }
}

export interface UserProfileInput {
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  email?: string | null | undefined;
}

export async function createUser(
  pool: Pool,
  orgId: string,
  username: string,
  password: string,
  role: Role,
  profile: UserProfileInput = {},
): Promise<UserSummary> {
  const passwordHash = await hashPassword(password);
  try {
    const { rows } = await pool.query<UserSummaryRow>(
      `INSERT INTO users (org_id, username, password_hash, role, first_name, last_name, email) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, role, created_at, first_name, last_name, email`,
      [orgId, username, passwordHash, role, profile.firstName ?? null, profile.lastName ?? null, profile.email ?? null],
    );
    return rowToSummary(rows[0]!);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new DuplicateUsernameError(username);
    }
    throw err;
  }
}

// Edits first/last name and email only — a separate concern from role
// changes (updateUserRole) and password resets (resetPassword) below, same
// as the UI keeps them as separate actions.
export async function updateUserProfile(
  pool: Pool,
  orgId: string,
  userId: string,
  profile: UserProfileInput,
): Promise<void> {
  if (profile.firstName !== undefined) {
    await pool.query(`UPDATE users SET first_name = $1 WHERE id = $2 AND org_id = $3`, [profile.firstName, userId, orgId]);
  }
  if (profile.lastName !== undefined) {
    await pool.query(`UPDATE users SET last_name = $1 WHERE id = $2 AND org_id = $3`, [profile.lastName, userId, orgId]);
  }
  if (profile.email !== undefined) {
    await pool.query(`UPDATE users SET email = $1 WHERE id = $2 AND org_id = $3`, [profile.email, userId, orgId]);
  }
}

// Counts admins EXCLUDING the given user id, WITHIN the same org — used to
// check "is this the last admin of this org" before a role change or delete
// would leave that org with zero accounts able to manage its own users, a
// real lockout, not just an inconvenience (there's no self-registration path
// to recover from it). Deliberately org-scoped: another org having plenty of
// admins is irrelevant to whether this org is about to lock itself out.
export async function otherAdminCount(pool: Pool, orgId: string, excludingUserId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM users WHERE org_id = $1 AND role = 'admin' AND id <> $2`,
    [orgId, excludingUserId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function updateUserRole(pool: Pool, orgId: string, userId: string, role: Role): Promise<void> {
  await pool.query(`UPDATE users SET role = $1 WHERE id = $2 AND org_id = $3`, [role, userId, orgId]);
}

export async function resetPassword(pool: Pool, orgId: string, userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2 AND org_id = $3`, [passwordHash, userId, orgId]);
}

export async function deleteUser(pool: Pool, orgId: string, userId: string): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1 AND org_id = $2`, [userId, orgId]);
}
