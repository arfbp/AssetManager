// แปลง "scope" ภาษาธรรมชาติ (เช่น "accounting-group", "Admin-01") ให้เป็น
// list ของ agent ID ที่ชัดเจน กลุ่มอุปกรณ์หลายเครื่องที่ตั้งชื่อไว้ (GROUPS)
// ยังคงเป็น lookup แบบ static ในเครื่อง โหลดครั้งเดียวตอน startup จากไฟล์
// JSON ที่ผู้ควบคุมแก้เอง — LLM parser (llm/actionParser.ts) ไม่มีทางกุชื่อ
// กลุ่มขึ้นมาแล้วเข้าถึงได้เกินกว่าที่ผู้ควบคุมตั้งค่าไว้ชัดเจนในไฟล์นั้น
//
// ชื่ออุปกรณ์เดี่ยว ๆ ต่างออกไป: จะ fallback ไปหาสิ่งที่เชื่อมต่ออยู่จริงตอนนี้
// (ดู getLiveAgentIds) ทำให้เครื่องจริงที่เพิ่ง deploy ใหม่ระบุเป้าหมายด้วย
// hostname ของตัวเองได้ทันที โดยไม่ต้องแก้ไฟล์ config แยกต่างหากทีละเครื่อง
// วิธีนี้ไม่ได้ทำให้ขอบเขตเดิมอ่อนแอลง — LLM ยังคงเข้าถึงอุปกรณ์ที่ไม่เคยผ่าน
// การยืนยันตัวตนและเชื่อมต่อกับ server ตัวนี้ไม่ได้อยู่ดี แค่ไม่ต้องมี allowlist
// เพิ่มด้วยมืออีกชั้นบนการยืนยันตัวตนนั้น ซึ่งเดิมเป็นแค่ความไม่สะดวกเปล่า ๆ
// (agent ที่เพิ่ง deploy ใหม่ทุกตัวต้องมีขั้นตอนเพิ่มด้วยมือก่อนที่ AI console
// จะสั่งงานได้ ทั้งที่ถูกไว้ใจเต็มที่อยู่แล้วสำหรับ path คำสั่งอื่นทุกทางของ
// โปรเจกต์นี้)
import { readFileSync } from "node:fs";
import { log } from "../logger.js";

export class DeviceGroups {
  // กลุ่มที่ตั้งค่าไว้ยังคงเป็นไฟล์ static ตัวเดียวใช้ร่วมกันทั้ง process ณ
  // ตอนนี้ — เป็นช่องว่างที่รู้อยู่แล้วและตั้งใจเลื่อนแก้ไปก่อน (ดู Phase 5/9
  // ของแผน multi-tenant migration): ชื่อกลุ่มที่ผู้ควบคุมตั้งค่าไว้จะมองเห็น/
  // resolve ได้ทั้ง fleet ไม่ได้จำกัดขอบเขตตาม org ผลกระทบจริงตอนนี้ยังต่ำ
  // (ไม่มีข้อมูลที่กระทบลูกค้าอยู่ในชื่อกลุ่มเอง และการ dispatch จริงของแต่ละ
  // org ก็ยังไปถึงแค่ agent ที่เชื่อมต่ออยู่ของ org ตัวเองเท่านั้น — ดู
  // getLiveAgentIds ด้านล่าง และ key แบบผสม org+agentId ของ ws/registry.ts
  // ซึ่งช่วยป้องกันแยกต่างหากไม่ให้ agentId ที่ resolve ได้แต่เป็นของ org อื่น
  // รับคำสั่งได้) แต่ก็จริงจังพอที่ควรแก้ให้ถูกต้อง (เก็บกลุ่มแยกตาม org)
  // ก่อนที่เรื่องนี้จะกลายเป็นปัญหาจริงกับลูกค้าที่จ่ายเงินรายที่สอง
  private readonly groups: Map<string, string[]>;
  // ต่างจาก `groups` ตัวนี้จำเป็นต้องจำกัดขอบเขตตาม org — เพราะสะท้อนอุปกรณ์
  // ที่เชื่อมต่ออยู่จริงตอนนี้ (hostname จริง) และเหตุผลทั้งหมดที่
  // ws/registry.ts เปลี่ยนมาใช้ key แบบผสม org+agentId ก็เพื่อไม่ให้ตรงนี้
  // resolve ไปโดนอุปกรณ์ของ org อื่นเพราะ hostname ชนกัน
  private readonly getLiveAgentIds: (orgId: string) => string[];

  private constructor(groups: Map<string, string[]>, getLiveAgentIds: (orgId: string) => string[]) {
    this.groups = groups;
    this.getLiveAgentIds = getLiveAgentIds;
  }

  static loadFromFile(path: string, getLiveAgentIds: (orgId: string) => string[]): DeviceGroups {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`device groups: failed to read ${path}: ${(err as Error).message}`);
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const groups = new Map<string, string[]>();
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("_")) continue; // อนุญาต key แบบ "_comment"
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new Error(`device groups: entry ${key} must be an array of agent ID strings`);
      }
      groups.set(key.toLowerCase(), value as string[]);
    }

    log.info({ groupCount: groups.size, path }, "device groups loaded");
    return new DeviceGroups(groups, getLiveAgentIds);
  }

  /**
   * แปลง scope string ให้เป็น agent ID: เช็คชื่อกลุ่มที่ตั้งค่าไว้ก่อน ถ้าไม่
   * มีกลุ่มไหนตรงจึงค่อยหา agent ที่เชื่อมต่ออยู่ตัวที่ ID ตรงกันเป๊ะ — เป็น
   * ไปโดยอัตโนมัติ ไม่ต้องให้อุปกรณ์นั้นถูกลิสต์ไว้เป็นกลุ่มแบบมีสมาชิกคนเดียว
   * ในไฟล์ config ด้วย
   */
  resolve(orgId: string, scope: string): string[] {
    const configured = this.groups.get(scope.toLowerCase());
    if (configured) return configured;

    const live = this.getLiveAgentIds(orgId).find((id) => id.toLowerCase() === scope.toLowerCase());
    return live ? [live] : [];
  }

  isKnownScope(orgId: string, scope: string): boolean {
    if (this.groups.has(scope.toLowerCase())) return true;
    return this.getLiveAgentIds(orgId).some((id) => id.toLowerCase() === scope.toLowerCase());
  }

  /**
   * ชื่อกลุ่มที่ตั้งค่าไว้ บวกกับ ID ของ agent ที่เชื่อมต่ออยู่ตอนนี้ทุกตัว —
   * ส่งเข้า system prompt ของ LLM เป็น "known scopes" เพื่อให้จำชื่ออุปกรณ์
   * จริงที่ไม่เคยเห็นถูกตั้งค่าไว้ที่ไหนเลยได้
   */
  listScopes(orgId: string): string[] {
    return [...new Set([...this.groups.keys(), ...this.getLiveAgentIds(orgId)])];
  }
}
