// ที่เก็บชั่วคราวแบบใช้ครั้งเดียวสำหรับผลตัดสินของ guardrail ที่ต้องการการ
// ยืนยันจากมนุษย์ก่อน dispatch operator บน dashboard ตรวจสอบคำสั่งที่ resolve
// แล้วและ target list จากนั้นยืนยันผ่าน POST /api/command/:id/confirm — นี่คือ
// ขั้นตอน human-in-the-loop สำหรับทุกอย่างที่ guardrail ตีธงว่าเป็นระดับ
// destructive หรือ mass-scope (ดู security/guardrail.ts)
//
// เป็น generic ต่อรูปร่างของ payload เพื่อให้กลไก TTL/sweep เดียวกันรองรับ
// store สองตัวที่แยกอิสระกันใน routes.ts: ตัวหนึ่งสำหรับ action ที่เจาะจง
// device (PendingAction เดิม) และอีกตัวสำหรับ admin action (PendingAdminAction
// ดู security/adminGuardrail.ts) — สอง store นี้ยืนยันข้าม endpoint ของกันและ
// กันไม่ได้เลย แยก instance กันโดยสิ้นเชิง
import { randomUUID } from "node:crypto";
import type { ResolvedCommand } from "../security/guardrail.js";
import type { ConfirmableAdminAction } from "../security/adminGuardrail.js";
import type { ConfirmableErpAction } from "../security/erpGuardrail.js";

export interface PendingAction {
  id: string;
  resolved: ResolvedCommand;
  targets: string[];
  reason: string;
  requestedBy: string;
  originalText: string;
  createdAt: number;
}

export interface PendingAdminAction {
  id: string;
  resolved: ConfirmableAdminAction;
  reason: string;
  requestedBy: string;
  originalText: string;
  createdAt: number;
}

// Store อิสระตัวที่สาม (ดู pendingErp ใน routes.ts) — ERP action ก็ยืนยัน
// ข้าม pending-ID space ของ device หรือ admin ไม่ได้เช่นกัน
export interface PendingErpAction {
  id: string;
  resolved: ConfirmableErpAction;
  reason: string;
  requestedBy: string;
  originalText: string;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;

export class PendingActionStore<T extends { id: string; createdAt: number }> {
  private readonly store = new Map<string, T>();

  create(input: Omit<T, "id" | "createdAt">): T {
    this.sweep();
    const action = { ...input, id: randomUUID(), createdAt: Date.now() } as T;
    this.store.set(action.id, action);
    return action;
  }

  /** ดึงและลบ pending action ออก — การยืนยันใช้ได้ครั้งเดียว เล่นซ้ำไม่ได้ */
  take(id: string): T | null {
    this.sweep();
    const action = this.store.get(id);
    if (!action) return null;
    this.store.delete(id);
    return action;
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, action] of this.store) {
      if (action.createdAt < cutoff) this.store.delete(id);
    }
  }
}
