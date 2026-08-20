// Package version เก็บ build version ของ agent เอง — เป็น string ธรรมดา
// ที่ bump มือทุกครั้งที่ปล่อย build ใหม่ (โปรเจกต์นี้ยังไม่มี CI pipeline
// ที่ stamp ค่านี้ให้อัตโนมัติ) central server เทียบค่านี้กับ
// downloads/agent-version.txt (ดู loadLatestAgentBuild ของ
// server/src/index.ts) เพื่อตัดสินใจว่า agent ที่เชื่อมต่ออยู่ต้อง
// self-update หรือไม่ — ดู internal/selfupdate
package version

// Version ต้อง bump ทุกครั้งที่มี agent build ใหม่ถูกวางไว้ในโฟลเดอร์
// downloads/ ของ server — ไม่งั้น agent ที่ update แล้วกับที่ยังไม่ update
// จะรายงาน string เดียวกัน แล้ว server จะแยกไม่ออกว่าตัวไหนเป็นตัวไหน
const Version = "2026.08.10-3"
