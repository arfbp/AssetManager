// Bootstrap/recovery account creation — run via
// `npm run user:create -- <username> <password> [role] [orgSubdomain]`.
// Normal account creation goes through POST /api/users (admin-only, see
// routes.ts); this CLI path exists for the very first account of an org,
// and as a recovery route if every admin account somehow gets locked out —
// matching the rest of this project's "nothing exists unless an operator
// explicitly configured it" philosophy.
//
// orgSubdomain defaults to "legacy" (the original single-tenant fleet, see
// migrations/0001_organizations.sql) so existing usage
// (`npm run user:create -- name pass role`) keeps working unchanged for
// that org without callers needing to learn a new required argument.
import "dotenv/config";
import { initPool } from "../db/pool.js";
import { hashPassword } from "./passwords.js";
import { isRole, type Role } from "./roles.js";

async function main(): Promise<void> {
  const [, , username, password, roleArg, orgSubdomainArg] = process.argv;
  if (!username || !password) {
    console.error("usage: npm run user:create -- <username> <password> [admin|it_support|viewer] [orgSubdomain]");
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exitCode = 1;
    return;
  }
  // Defaults to admin: this is the bootstrap/recovery path, and defaulting
  // a newly created account to anything less would risk a silent lockout
  // (no self-registration exists to recover from picking too low a role).
  const role: Role = roleArg ? (isRole(roleArg) ? roleArg : (() => { throw new Error(`invalid role "${roleArg}" — must be admin, it_support, or viewer`); })()) : "admin";
  const orgSubdomain = orgSubdomainArg?.trim().toLowerCase() || "legacy";

  const databaseUrl = process.env.OPTIFLEET_DATABASE_URL;
  if (!databaseUrl) {
    console.error("OPTIFLEET_DATABASE_URL must be set (see server/.env) — run `npm run db:migrate` first if you haven't.");
    process.exitCode = 1;
    return;
  }

  const pool = initPool(databaseUrl);
  const { rows: orgRows } = await pool.query<{ id: string }>(
    `SELECT id FROM organizations WHERE lower(subdomain) = $1`,
    [orgSubdomain],
  );
  if (orgRows.length === 0) {
    console.error(`no organization with subdomain "${orgSubdomain}" — run \`npm run org:create\` first if this is a new org.`);
    process.exitCode = 1;
    await pool.end();
    return;
  }
  const orgId = orgRows[0]!.id;

  const passwordHash = await hashPassword(password);
  // Deliberately does not touch `role` on conflict — re-running this against
  // an existing username (e.g. to reset a forgotten password) must not
  // silently change that account's role out from under it. Conflict target
  // is (org_id, username), not username alone — the same username existing
  // in a different org is a different account, not a conflict.
  await pool.query(
    `INSERT INTO users (org_id, username, password_hash, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [orgId, username, passwordHash, role],
  );
  console.log(`user "${username}" created/updated in org "${orgSubdomain}".`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
