// ตัวป้องกันการ brute-force ตอน login คีย์ด้วย client IP (keyGenerator
// default ของ express-rate-limit) แทนที่จะเป็น username ที่ส่งมา เพราะถ้า
// จำกัดตาม username ผู้โจมตีแค่สลับ username ไปเรื่อยๆ ก็หลบข้อจำกัดได้ง่ายๆ
// — การจำกัดต่อ IP ถึงจะเป็นตัวที่ throttle การเดารหัสแบบ script จริงได้
// ต้องตั้งค่า `app.set("trust proxy", ...)` ใน index.ts ให้ถูกต้อง
// (เซิร์ฟเวอร์นี้อยู่หลัง nginx ใน deployment จริงทุกครั้ง) ไม่งั้นทุก
// request จะดูเหมือนมาจาก loopback address ของ nginx เอง และแชร์ bucket
// เดียวกันกับ client จริงทุกคน — express-rate-limit เองจะปฏิเสธไม่ยอม start
// เลยในสถานะตั้งค่าผิดแบบนี้ แทนที่จะทำงานผิดๆ แบบเงียบๆ
//
// 10 ครั้ง / 15 นาที กว้างพอที่จะรองรับ operator จริงที่พิมพ์รหัสผิดไม่กี่
// ครั้ง (รวมถึงกรณีทั้งออฟฟิศแชร์ public IP เดียวกันผ่าน NAT) ในขณะที่ยังคง
// จำกัดการเดาแบบ script ไว้ที่ไม่ถึง 1,000 ครั้ง/วัน ซึ่งไม่พอเลยที่จะ
// brute-force รหัสผ่านสุ่มจริงๆ ได้ และช้าพอที่จะทำให้ไม่ใช่ช่องทางโจมตีที่
// ใช้งานได้จริงอีกต่อไป
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // นับเฉพาะการพยายามที่ล้มเหลว (401 ฯลฯ) เข้าไปในลิมิต — ไม่งั้น operator
  // จริงที่ login สำเร็จหลายครั้งแล้วในหน้าต่างเดียวกัน (หลายแท็บ, login ใหม่
  // หลัง session หมดอายุ ฯลฯ) จะโดนล็อกจากการ login สำเร็จของตัวเองในที่สุด
  // ซึ่งเสียจุดประสงค์ไปเลย: กลไกนี้ป้องกันการเดารหัส ไม่ใช่ป้องกัน user จริง
  // ที่ authenticate ถูกต้อง
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Try again in a few minutes." },
});

// สำหรับ route ที่ authenticated แล้วและมีต้นทุนต่อการเรียกสูง (NL command
// dispatch, installer generation, uploads) ที่ใช้ร่วมกันข้ามทุก tenant บน
// deployment นี้ — คีย์ด้วย orgId ไม่ใช่ IP เพื่อไม่ให้การใช้งานของ org หนึ่ง
// ไปแย่ง bucket ของอีก org ได้เลย (ต่างจาก loginRateLimiter ที่ตั้งใจคีย์
// ด้วย IP เพราะตอน login ยังไม่มี session ที่ผูกกับ org ให้คีย์ด้วย) จะ
// fallback ไปใช้ req.ip เฉพาะกรณีทางทฤษฎีที่ route นี้รันก่อน auth
// middleware เท่านั้น จุดเรียกใช้จริงทุกจุดในที่นี้อยู่หลัง session
// validation แล้ว fallback นี้ผ่าน ipKeyGenerator (ไม่ใช่ req.ip string
// ดิบๆ) — express-rate-limit ตรวจตอน startup ว่า custom keyGenerator
// normalize IPv6 address แบบนี้หรือไม่ (IPv6 address ที่ไม่ normalize จะทำ
// ให้ client หลบข้อจำกัดได้ด้วยการหมุนเวียน address ภายใน /64 ของตัวเอง)
// ถ้าไม่ทำจะปฏิเสธไม่ยอม start เลย (ERR_ERL_KEY_GEN_IPV6)
export function createOrgRateLimiter(opts: { windowMs: number; limit: number; message: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => (req as Request & { user?: { orgId?: string } }).user?.orgId ?? ipKeyGenerator(req.ip ?? "unknown"),
    message: { error: opts.message },
  });
}
