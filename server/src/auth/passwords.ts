// การ hash รหัสผ่าน แยกไว้เป็นโมดูลของตัวเองเพื่อไม่ให้ส่วนอื่นในโค้ดต้องรู้
// หรือสนใจว่าใช้ algorithm อะไร
import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
