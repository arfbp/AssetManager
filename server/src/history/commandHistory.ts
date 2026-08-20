// log คำสั่งที่ dispatch แล้วพร้อมผลลัพธ์ เก็บในหน่วยความจำแบบมีขอบเขต ใช้
// แสดงในแผง "Command History" ของ dashboard ring buffer (ขนาดสูงสุดตายตัว)
// เพียงพอสำหรับมุมมองปฏิบัติการของกิจกรรมล่าสุด ถ้าต้องการอะไรที่รอดจากการ
// restart หรือค้นย้อนหลังเกินหน้าต่างล่าสุดได้ ให้ต่อเข้ากับระบบ audit/log
// storage จริง (ดู server/README.md)
import { EventEmitter } from "node:events";
import type { CommandAction } from "../protocol.js";

export type HistoryEntryStatus = "dispatched" | "offline" | "succeeded" | "failed";

export interface HistoryEntry {
  commandId: string;
  orgId: string;
  agentId: string;
  action: CommandAction;
  params: Record<string, string>;
  requestedBy: string;
  sourceText: string | null; // คำขอภาษาธรรมชาติต้นฉบับ ถ้ามาจาก chat console
  status: HistoryEntryStatus;
  message: string | null;
  dispatchedAt: number;
  resolvedAt: number | null;
}

const MAX_ENTRIES = 500;

/** ยิง event "entry" พร้อม {@link HistoryEntry} ทุกครั้งที่ insert หรืออัปเดต */
export class CommandHistoryStore extends EventEmitter {
  private entries: HistoryEntry[] = [];
  private readonly byId = new Map<string, HistoryEntry>();

  recordDispatch(entry: Omit<HistoryEntry, "status" | "message" | "resolvedAt">, delivered: boolean): void {
    const full: HistoryEntry = {
      ...entry,
      status: delivered ? "dispatched" : "offline",
      message: delivered ? null : "agent is offline; command was not delivered",
      resolvedAt: delivered ? null : Date.now(),
    };
    this.entries.push(full);
    this.byId.set(full.commandId, full);
    this.trim();
    this.emit("entry", full);
  }

  recordResult(commandId: string, success: boolean, message: string): void {
    const entry = this.byId.get(commandId);
    if (!entry) return; // เป็นผลลัพธ์ของคำสั่งที่ dispatch ก่อน process นี้จะเริ่ม หรือถูกตัดทิ้งไปแล้ว
    entry.status = success ? "succeeded" : "failed";
    entry.message = message;
    entry.resolvedAt = Date.now();
    this.emit("entry", entry);
  }

  recent(limit = 100): HistoryEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  // โหลด store ในหน่วยความจำนี้ล่วงหน้าจาก storage แบบถาวร (ตาราง
  // command_history ของ Postgres — ดู loadRecentHistory ใน
  // db/persistence.ts) ทันทีหลังสร้าง object ก่อนที่ dashboard client ตัวไหน
  // จะเชื่อมต่อเข้ามา ถ้าไม่ทำแบบนี้ ทุกครั้งที่ server restart มุมมอง "ใครทำ
  // อะไร" แบบสดจะว่างเปล่าไปแบบเงียบ ๆ — ตัว command_history เองไม่เคยได้รับ
  // ผลกระทบเลย (upsertHistoryEntry บันทึกทุกอย่างถูกต้องอยู่แล้ว) มีแค่สำเนา
  // เชิงปฏิบัติการในหน่วยความจำอันนี้เท่านั้นที่ dashboard/AI console/แท็บ
  // Commands อ่านมาใช้จริง `entries` ต้องมาแบบเก่าสุดก่อน ให้ตรงกับลำดับที่
  // recordDispatch push เข้าท้าย list เอง ไม่งั้น slice+reverse ของ recent()
  // จะคืนค่ากลับด้านผิดลำดับให้ผู้เรียก
  hydrate(entries: HistoryEntry[]): void {
    this.entries = entries.slice(-MAX_ENTRIES);
    this.byId.clear();
    for (const e of this.entries) this.byId.set(e.commandId, e);
  }

  private trim(): void {
    if (this.entries.length <= MAX_ENTRIES) return;
    const removed = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    for (const e of removed) this.byId.delete(e.commandId);
  }
}
