// token แบบ self-service สำหรับ "ตั้งรหัสผ่านของตัวเอง" — มาแทน flow เดิมที่
// platform admin ต้องตั้งรหัสผ่าน admin ของ org ใหม่เอง แล้วส่งต่อผ่าน
// chat/email ด้วยมือ (รูปแบบที่รหัสผ่านเดินทางเป็น plaintext) ใช้รูปแบบ
// token สุ่มแบบ opaque เก็บใน Postgres เดียวกับ token ของ sessions.ts ด้วย
// เหตุผลเดียวกัน: การเพิกถอน/หมดอายุเป็นแค่การเช็ค DB ธรรมดา ไม่ใช่การ
// ตรวจสอบลายเซ็นที่ต้องเชื่อถือ
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword } from "./passwords.js";

const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 วัน — เท่ากับ TTL ของ session

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

// ตรวจสอบ token (มีอยู่จริง ยังไม่หมดอายุ ยังไม่เคยใช้) และตั้งรหัสผ่านในขั้น
// ตอนเดียวกันเลย — ไม่มีขั้นตอน "แอบดู token" แยกก่อนส่งจริง แนวทาง "ไม่เปิด
// เผยว่าการตรวจสอบส่วนไหนล้มเหลว" เดียวกับตอน login แค่เปลี่ยนมาใช้กับลิงก์
// คำเชิญแทนรหัสผ่าน คืนค่า false (ไม่ throw error) สำหรับ token ที่ไม่ถูกต้อง/
// หมดอายุ/ถูกใช้แล้วทุกกรณี เพื่อให้ผู้เรียกตอบข้อความทั่วไปข้อความเดียวได้ไม่
// ว่าจะล้มเหลวด้วยเหตุผลไหน
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
