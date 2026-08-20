// บัญชีผู้ใช้ ไม่มี endpoint self-registration สาธารณะโดยตั้งใจ — บัญชีแรกสุด
// ถูกสร้างโดยผู้ดูแลระบบผ่าน `npm run user:create`
// (src/auth/createUser.ts ซึ่งยังใช้เป็น path สำหรับ bootstrap/กู้คืนระบบได้
// ถ้าบัญชี admin ทุกบัญชีถูกล็อกไม่ให้เข้าใช้งานโดยบังเอิญ) ส่วนบัญชีหลังจากนั้น
// ทั้งหมดสร้างผ่าน POST /api/users ซึ่งจำกัดไว้เฉพาะ role 'admin' โดย
// requireRole ใน auth/roles.ts ใช้ปรัชญาเดียวกับที่ device groups
// (src/groups/deviceGroups.ts) และ allowlist คำสั่งของ agent ใช้อยู่แล้ว คือ
// "ไม่มีอะไรเกิดขึ้นเองถ้าผู้ควบคุมไม่ได้ตั้งค่าไว้ชัดเจน"
//
// ทุกฟังก์ชันในไฟล์นี้รับ orgId มา และกรอง/จำกัดขอบเขตด้วยมัน — username
// unique แค่ภายใน org เดียวกันเท่านั้น (ดู constraint `(org_id, username)`
// ใน migrations/0003_users_org_scoped_username.sql) และทุกการแก้ไขข้อมูลก็
// ถูกจำกัดด้วย org_id เพิ่มเติมด้วย เพื่อไม่ให้ session ของ admin จาก org
// หนึ่งไปกระทำกับ user ของอีก org ได้ด้วยการเดา/ไล่ UUID แม้ userId เพียง
// อย่างเดียวจะเพียงพอต่อการหาแถวนั้นเจอก็ตาม
import type { Pool } from "pg";
import { verifyPassword, hashPassword } from "./passwords.js";
import type { Role } from "./roles.js";

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  orgId: string;
  status: string;
}

export interface UserSummary {
  id: string;
  username: string;
  role: Role;
  status: string;
  createdAt: string;
  // field ข้อมูลโปรไฟล์พื้นฐาน แยกจาก identifier สำหรับ login (username) —
  // เป็น nullable เพราะบัญชีที่สร้างก่อนจะมี field พวกนี้ไม่มีค่าทั้งคู่
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

interface UserSummaryRow {
  id: string;
  username: string;
  role: Role;
  status: string;
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
    status: row.status,
    createdAt: row.created_at,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
  };
}

export async function findUserByUsername(pool: Pool, orgId: string, username: string): Promise<UserRecord | null> {
  const { rows } = await pool.query<{ id: string; username: string; password_hash: string; role: Role; org_id: string; status: string }>(
    `SELECT id, username, password_hash, role, org_id, status FROM users WHERE org_id = $1 AND username = $2`,
    [orgId, username],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role, orgId: row.org_id, status: row.status };
}

// รัน bcrypt compare เสมอแม้ username จะไม่มีอยู่จริง (เทียบกับ dummy hash
// คงที่) เพื่อไม่ให้เวลาตอบสนองของการพยายาม login เปิดเผยว่า username นั้น
// มีอยู่จริงหรือไม่
const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Q0/9AzMcTM8vXdVE0Vv3lZbowFVCG";

export async function verifyCredentials(
  pool: Pool,
  orgId: string,
  username: string,
  password: string,
): Promise<UserRecord | null> {
  const user = await findUserByUsername(pool, orgId, username);
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  // ยังคงรัน bcrypt compare ด้านบนแม้กับ user ที่ถูก suspend อยู่ (เหตุผล
  // constant-time เดียวกับกรณี DUMMY_HASH) — จะถูกปฏิเสธหลังจากนั้นเท่านั้น
  // และด้วยผลลัพธ์ทั่วไปแบบเดียวกัน "invalid username or password" ที่ผู้
  // เรียกได้รับอยู่แล้วกรณีรหัสผ่านผิด ดังนั้นบัญชีที่ถูก suspend จึงแยกไม่ออก
  // จากบัญชีที่ไม่มีอยู่จริงหรือพิมพ์ผิด
  return ok && user && user.status === "active" ? user : null;
}

export async function listUsers(pool: Pool, orgId: string): Promise<UserSummary[]> {
  const { rows } = await pool.query<UserSummaryRow>(
    `SELECT id, username, role, status, created_at, first_name, last_name, email FROM users WHERE org_id = $1 ORDER BY created_at ASC`,
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
       RETURNING id, username, role, status, created_at, first_name, last_name, email`,
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

// แก้ไขแค่ชื่อ/นามสกุลและอีเมลเท่านั้น — แยกความรับผิดชอบออกจากการเปลี่ยน
// role (updateUserRole) และการรีเซ็ตรหัสผ่าน (resetPassword) ด้านล่าง
// เหมือนกับที่ UI แยกเป็นคนละ action
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

// นับ admin ที่ ACTIVE โดยไม่รวม user id ที่ระบุ ภายใน org เดียวกัน — ใช้
// ตรวจสอบว่า "นี่คือ admin คนสุดท้ายของ org นี้หรือเปล่า" ก่อนที่การเปลี่ยน
// role, suspend หรือ delete จะทำให้ org นั้นเหลือบัญชีที่จัดการ user ของ
// ตัวเองได้เป็นศูนย์ ซึ่งคือการล็อกออกจริง ไม่ใช่แค่ความไม่สะดวก (เพราะไม่มี
// self-registration ให้กู้คืนได้) นับเฉพาะ 'active' เท่านั้น — admin ที่ถูก
// suspend ทำอะไรไม่ได้อยู่แล้ว จึงช่วย org ไม่ให้ล็อกออกไม่ได้เช่นกัน ตั้งใจ
// จำกัดขอบเขตด้วย org: org อื่นมี admin เยอะแค่ไหนก็ไม่เกี่ยวกับว่า org นี้
// กำลังจะล็อกตัวเองออกหรือไม่
export async function otherAdminCount(pool: Pool, orgId: string, excludingUserId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM users WHERE org_id = $1 AND role = 'admin' AND status = 'active' AND id <> $2`,
    [orgId, excludingUserId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function updateUserRole(pool: Pool, orgId: string, userId: string, role: Role): Promise<void> {
  await pool.query(`UPDATE users SET role = $1 WHERE id = $2 AND org_id = $3`, [role, userId, orgId]);
}

// การ suspend ไม่แตะแถว session ที่เปิดอยู่เลย — validateSession
// (sessions.ts) จะตรวจสอบ status สดใหม่ทุก request อยู่แล้ว เหมือนกับที่ทำกับ
// role/orgId ดังนั้นการ suspend จะมีผลตั้งแต่ request ถัดไปของ user นั้น
// ทันที ไม่ต้องรอไปเจอตอน login ครั้งหน้า
export async function setUserStatus(pool: Pool, orgId: string, userId: string, status: "active" | "suspended"): Promise<void> {
  await pool.query(`UPDATE users SET status = $1 WHERE id = $2 AND org_id = $3`, [status, userId, orgId]);
}

export async function resetPassword(pool: Pool, orgId: string, userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2 AND org_id = $3`, [passwordHash, userId, orgId]);
}

export async function deleteUser(pool: Pool, orgId: string, userId: string): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1 AND org_id = $2`, [userId, orgId]);
}
