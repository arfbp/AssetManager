// Postgres pool เดียวที่ใช้ร่วมกันทั้ง process เก็บเป็น module singleton
// แบบ lazily-set (แทนที่จะส่งผ่านทุก function signature) เพราะ
// db/persistence.ts เป็นผู้ใช้เพียงรายเดียว และถูก wire แค่ครั้งเดียวตอน
// startup — ดู index.ts
import pg from "pg";
import { log } from "../logger.js";

let pool: pg.Pool | null = null;

export function initPool(connectionString: string): pg.Pool {
  pool = new pg.Pool({ connectionString });
  // Connection ที่ idle แล้วหลุดไปต้องไม่ทำให้ process ล่ม — pool จะ
  // reconnect เองตอน query ครั้งถัดไป การเก็บข้อมูลถาวรเป็นแค่ของดีเสริม
  // ด้าน durability ไม่ใช่สิ่งที่การจัดการ agent สดๆ ควรพึ่งพาให้ต้องรันอยู่
  // ตลอดเวลา
  pool.on("error", (err) => {
    log.error({ err }, "db: idle client error");
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("db: pool not initialized — call initPool() before getPool()");
  }
  return pool;
}
