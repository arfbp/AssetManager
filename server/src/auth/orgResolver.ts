// ตัดสินใจว่าคำขอ login หนึ่งครั้งเป็นของ organization ไหน โดยดูจาก subdomain
// ที่ฝั่ง frontend อ่านมาจาก window.location.hostname (ส่งมาเป็น header ไม่ใช่
// derive จาก Host ของ request ฝั่ง server เอง — เพราะ frontend/API ตั้งใจแยก
// origin กันไว้ ดู currentOrgSubdomain() ใน frontend/src/lib/session.ts)
// นี่คือจุดเดียวเท่านั้นที่การ resolve subdomain มีความหมาย: ทุก request หลัง
// login จะพก org identity มากับ session token อยู่แล้ว (validateSession join
// เข้ามาแบบเดียวกับที่ join role) ดังนั้น route อื่นไม่จำเป็นต้องทำแบบนี้
//
// header จะพกมาเป็นชื่อ subdomain เปล่า ๆ (เช่น "360qm" จับคู่กับ
// organizations.subdomain) หรือกรณี org ที่มีโดเมนเป็นของตัวเองเต็มรูปแบบ
// (เช่น "assets.360qm.co.th") จะพก hostname เต็ม (จับคู่กับ
// organizations.custom_domain) — currentOrgSubdomain() เป็นตัวตัดสินใจว่าจะ
// ส่งรูปแบบไหน โดยดูว่า hostname ของเบราว์เซอร์อยู่ภายใต้ suffix โดเมนกลาง
// ของ org หรือไม่
import type { Pool } from "pg";

export async function resolveOrgBySubdomain(pool: Pool, subdomain: string): Promise<{ id: string; name: string } | null> {
  const value = subdomain.trim().toLowerCase();
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE (lower(subdomain) = $1 OR lower(custom_domain) = $1) AND status = 'active'`,
    [value],
  );
  return rows[0] ?? null;
}
