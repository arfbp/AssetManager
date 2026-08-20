// สร้างบัญชีสำหรับ bootstrap/กู้คืนระบบ — เรียกผ่าน
// `npm run user:create -- <username> <password> [role] [orgSubdomain]`
// การสร้างบัญชีปกติจะผ่าน POST /api/users (เฉพาะ admin เท่านั้น ดู
// routes.ts); path แบบ CLI นี้มีไว้สำหรับบัญชีแรกสุดของ org และเป็นทาง
// กู้คืนกรณีบัญชี admin ทุกบัญชีถูกล็อกไม่ให้เข้าใช้งานได้โดยบังเอิญ — เข้ากับ
// ปรัชญา "ไม่มีอะไรเกิดขึ้นเองถ้าผู้ควบคุมไม่ได้ตั้งค่าไว้ชัดเจน" ของโปรเจกต์นี้
//
// orgSubdomain มีค่า default เป็น "legacy" (fleet แบบ single-tenant ดั้งเดิม
// ดู migrations/0001_organizations.sql) เพื่อให้การใช้งานเดิม
// (`npm run user:create -- name pass role`) ยังทำงานได้ตามปกติสำหรับ org
// นั้นโดยไม่ต้องให้ผู้เรียกมาเรียนรู้ argument บังคับตัวใหม่
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
  // ค่า default เป็น admin: เพราะนี่คือ path สำหรับ bootstrap/กู้คืนระบบ
  // ถ้าตั้ง default บัญชีที่สร้างใหม่ให้ต่ำกว่านี้ จะเสี่ยงถูกล็อกออกแบบเงียบ ๆ
  // (ระบบไม่มี self-registration ให้กู้คืนได้ถ้าเลือก role ต่ำเกินไป)
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
  // ตั้งใจไม่แตะ `role` ตอนเกิด conflict — ถ้ารันคำสั่งนี้ซ้ำกับ username ที่มี
  // อยู่แล้ว (เช่น เพื่อรีเซ็ตรหัสผ่านที่ลืม) ต้องไม่เปลี่ยน role ของบัญชีนั้น
  // ไปแบบเงียบ ๆ conflict target คือ (org_id, username) ไม่ใช่ username
  // เพียงอย่างเดียว — username เดียวกันที่อยู่คนละ org ถือเป็นคนละบัญชี ไม่ใช่
  // การ conflict
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
