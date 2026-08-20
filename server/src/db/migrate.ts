// สองชั้น รันตามลำดับโดย `npm run db:migrate`:
//   1. schema.sql — baseline แบบ idempotent เดิม (มี IF NOT EXISTS ทุกที่)
//      ยังถูก apply แบบไม่มีเงื่อนไขทุกครั้งที่รัน เพราะเป็น no-op ถ้า apply
//      ไปแล้ว เก็บไว้แบบเดิมแทนที่จะยุบรวมเข้าไปเป็นไฟล์ migration เพื่อให้
//      ความเคยชินในการ deploy ("แค่รัน db:migrate") ยังใช้ได้เหมือนเดิม
//   2. migrations/*.sql — ขั้นตอนแบบเรียงลำดับจริง ทำครั้งเดียว ไม่ idempotent
//      (backfill, การเปลี่ยน constraint) ที่ convention IF-NOT-EXISTS ของ
//      schema.sql แสดงออกมาแบบปลอดภัยไม่ได้ แต่ละไฟล์ถูก track ไว้ใน
//      schema_migrations และ apply แค่ครั้งเดียวเท่านั้น อยู่ใน transaction
//      ของตัวเอง (rollback และยกเลิกทั้งรันถ้าเกิด failure ใดๆ ดังนั้น
//      migration ที่ apply ไปครึ่งเดียวจะไม่มีวันถูก mark ว่าเสร็จแล้ว)
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
    .sort(); // ชื่อไฟล์เติม 0 นำหน้า ("0001_...") ดังนั้น sort แบบ lexical จึงเรียงตามเวลาได้พอดี

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
