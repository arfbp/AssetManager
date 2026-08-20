// Structured logging: logger สำหรับงาน operational หนึ่งตัว และ audit logger
// แบบ append-only อีกหนึ่งตัว สอดคล้องกับการแยกแบบเดียวกันที่ฝั่ง agent ใช้
// (agent.log / audit.log) เพื่อให้ทั้งสองฝั่งของระบบดูแลจัดการได้ตรงกัน
import pino from "pino";

// exactOptionalPropertyTypes ห้ามไม่ให้ `transport: undefined` — property ที่
// เป็น optional ต้องไม่มี key นั้นเลย จะมี key แต่ค่าเป็น undefined ไม่ได้ —
// จึงต้องใส่ key นี้แบบมีเงื่อนไขแทนที่จะตั้งเป็นค่าที่อาจเป็น undefined
const prettyTransport =
  process.env.NODE_ENV === "production" ? {} : { transport: { target: "pino-pretty", options: { colorize: true } } };

export const log = pino({ level: process.env.LOG_LEVEL ?? "info", ...prettyTransport });

export const audit = pino({
  level: "info",
  base: { component: "audit" },
  ...prettyTransport,
});
