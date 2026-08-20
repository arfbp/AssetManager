// การควบคุมสิทธิ์ตาม role — ดู comment ของคอลัมน์ users.role ใน schema.sql
// สำหรับความหมายของทั้งสาม role นี่คือจุดเดียวที่เก็บ role enum และการ
// ตรวจสอบสิทธิ์ที่ไม่สนลำดับก่อนหลัง routes.ts จะไม่เปรียบเทียบ string ของ
// role ตรง ๆ เลย ต้องผ่าน requireRole เสมอ เพื่อให้ชื่อ role ที่พิมพ์ผิด fail
// closed (role ที่ไม่รู้จักจะไม่ match อะไรเลย) แทนที่จะให้สิทธิ์เข้าถึงแบบ
// เงียบ ๆ
import type { Request, Response, NextFunction } from "express";

export const ROLES = ["admin", "it_support", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

interface RoleAwareRequest extends Request {
  user?: { role: Role };
}

// factory สำหรับ Express middleware: ตอบ 403 กับ request ใด ๆ ที่ role ของ
// session ไม่อยู่ใน `allowed` ต้องรันหลัง middleware ตรวจสอบ session พื้นฐาน
// (routes.ts) เพื่อให้ req.user มีค่าอยู่แล้ว — ไม่เคยใช้แบบ standalone
export function requireRole(...allowed: Role[]) {
  return (req: RoleAwareRequest, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "Your account does not have permission to do this." });
      return;
    }
    next();
  };
}
