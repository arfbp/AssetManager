// Two layers, run in order by `npm run db:migrate`:
//   1. schema.sql — the original idempotent baseline (IF NOT EXISTS
//      everywhere), still applied unconditionally every run since it's a
//      no-op once already applied. Kept as-is rather than folded into a
//      migration file so existing deploy muscle memory ("just run
//      db:migrate") keeps working unchanged.
//   2. migrations/*.sql — real ordered, one-time, non-idempotent steps
//      (backfills, constraint changes) that schema.sql's IF-NOT-EXISTS
//      convention can't safely express. Each file is tracked in
//      schema_migrations and only ever applied once, inside its own
//      transaction (rolled back and the whole run aborted on any failure,
//      so a half-applied migration never gets marked done).
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function applyBaseline(pool: pg.Pool): Promise<void> {
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  // eslint-disable-next-line no-console
  console.log("migrate: baseline schema.sql applied");
}

async function applyMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = join(__dirname, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filenames are zero-padded ("0001_...") so lexical sort is chronological

  const { rows: applied } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
  const appliedVersions = new Set(applied.map((r) => r.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (appliedVersions.has(version)) continue;

    const sql = readFileSync(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      // eslint-disable-next-line no-console
      console.log(`migrate: applied ${version}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migrate: ${version} failed, rolled back: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.OPTIFLEET_DATABASE_URL;
  if (!connectionString) {
    throw new Error("migrate: OPTIFLEET_DATABASE_URL is not set (see .env.example)");
  }

  const pool = new pg.Pool({ connectionString });
  try {
    await applyBaseline(pool);
    await applyMigrations(pool);
    // eslint-disable-next-line no-console
    console.log("migrate: done");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("migrate: failed:", err);
  process.exit(1);
});
