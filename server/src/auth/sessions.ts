// session token เป็น string สุ่มแบบ opaque ที่ค้นหาใน Postgres ไม่ใช่ JWT —
// การเพิกถอนคือแค่ DELETE และการตรวจสอบความถูกต้องคืออ่าน DB ธรรมดา แทนที่
// จะต้องเชื่อถือลายเซ็นที่ server ไม่มีทางยกเลิกได้ก่อนมันหมดอายุเอง เก็บใน
// Postgres (ไม่ใช่ memory) เพื่อให้ session ที่ล็อกอินอยู่รอดจากการรีสตาร์ท
// server แทนที่จะบังคับให้ผู้ควบคุมทุกคนต้อง login ใหม่ทุกครั้ง
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Role } from "./roles.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 วัน

export interface Session {
  token: string;
  userId: string;
  username: string;
  // อ่านสดจากตาราง `users` ทุกครั้งที่เรียก validateSession (join มา ไม่ได้
  // เก็บไว้ในแถว session) — เมื่อ admin เปลี่ยน role ของใคร จะมีผลตั้งแต่
  // request ถัดไปของ user นั้นทันที ไม่ต้องรอ login ใหม่
  role: Role;
  // แนวทาง "อ่านสดผ่าน join ไม่ cache" เดียวกับ role — การย้าย user ข้าม org
  // (ถ้าเกิดขึ้น) ก็มีผลทันทีเช่นกัน
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
  // u.status = 'active' — แนวทาง "อ่านสดทุก request" เดียวกับ role/org_id
  // ด้านบน: user ที่ถูก suspend ระหว่าง session อยู่จะถูกปฏิเสธตั้งแต่
  // request ถัดไปทันที ไม่ต้องรอไปเจอตอน login ครั้งหน้า
  const { rows } = await pool.query<{ token: string; user_id: string; username: string; role: Role; org_id: string }>(
    `SELECT s.token, s.user_id, u.username, u.role, u.org_id FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [token],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { token: row.token, userId: row.user_id, username: row.username, role: row.role, orgId: row.org_id };
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}
