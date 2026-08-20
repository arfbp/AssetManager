// agent credential แยกตาม org (auth token + HMAC secret) มาแทนคู่
// OPTIFLEET_AGENT_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET แบบเดียวทั้ง fleet แบบ
// เดิม โหลดจากตาราง `organizations` ตอน boot แล้ว cache ไว้ในหน่วยความจำ —
// การหมุน credential เป็นการกระทำของผู้ควบคุมที่เกิดขึ้นไม่บ่อยและตั้งใจทำ
// (ดู doc comment ของ migrations/0004 และ Phase 3b ของแผน multi-tenant
// migration) ไม่ใช่สิ่งที่ต้องการความสดใหม่ระดับ request เดียวกันแบบที่การ
// เปลี่ยน role หรือ org ต้องการ (การ join role/org_id ของ validateSession)
// ดังนั้น cache ที่อยู่ตลอดอายุ process แล้ว refresh เฉพาะเมื่อจำเป็น (สร้าง
// org ใหม่) จึงเป็นทางเลือกที่เหมาะสม — การ round-trip ไปหา DB ทุกครั้งที่
// agent ส่ง heartbeat จะสิ้นเปลืองโดยใช่เหตุ สำหรับสิ่งที่แทบไม่เปลี่ยนแปลง
// เลย
//
// นอกจากนี้ยัง cache custom domain ของแต่ละ org ด้วย
// (organizations.custom_domain ดู migrations/0007) ด้วยเหตุผลเดียวกัน: การ
// ตรวจสอบ CORS origin ใน index.ts ต้องการคำตอบแบบ synchronous ในหน่วยความจำ
// ต่อ request และ custom domain ยิ่งถูกตั้งค่าน้อยกว่าการหมุน credential
// เสียอีก
import type { Pool } from "pg";

export interface OrgCredential {
  orgId: string;
  hmacSecret: string;
}

export class OrgCredentialCache {
  private byToken = new Map<string, OrgCredential>();
  // ดัชนีย้อนกลับของแถวชุดเดียวกัน คีย์ด้วย orgId — ใช้ในจุดที่รู้อยู่แล้วว่า
  // request เป็นของ org ไหน (เช่น req.user.orgId หลัง validate session) และ
  // ต้องการแค่ hmacSecret ของ org นั้นเพื่อเซ็นคำสั่งที่จะส่งออกไป ตรงข้ามกับ
  // ทิศทางของ byToken ที่ตอบคำถาม "bearer token ของ agent นี้เป็นของ org
  // ไหน" ซึ่งใช้ตอน connect
  private byOrgId = new Map<string, string>();
  // origin แบบเต็ม "https://<domain>" พร้อมจับคู่ตรง ๆ กับ Origin header ของ
  // browser ได้เลย — ไม่ใช่แค่ domain เปล่า ๆ เพื่อไม่ให้ index.ts ต้อง
  // ประกอบ scheme ขึ้นมาใหม่ทุก request
  private customDomainOrigins = new Set<string>();

  static async load(pool: Pool): Promise<OrgCredentialCache> {
    const cache = new OrgCredentialCache();
    await cache.reload(pool);
    return cache;
  }

  async reload(pool: Pool): Promise<void> {
    // status = 'active' — agent token ของ org ที่ถูก suspend จะแค่ resolve
    // ไม่ได้ตรงนี้เฉย ๆ ได้ผลปฏิเสธทั่วไปแบบเดียวกับ token ที่ไม่ถูกต้องตัวอื่น
    // ใน verifyClient (ws/server.ts) ไม่ต้อง special-case ที่ไหนอีกเลย: นี่คือ
    // จุดเดียวที่ resolve agent auth
    const { rows } = await pool.query<{ id: string; agent_auth_token: string; agent_hmac_secret: string }>(
      `SELECT id, agent_auth_token, agent_hmac_secret FROM organizations WHERE agent_auth_token <> '' AND status = 'active'`,
    );
    const next = new Map<string, OrgCredential>();
    const nextByOrgId = new Map<string, string>();
    for (const row of rows) {
      next.set(row.agent_auth_token, { orgId: row.id, hmacSecret: row.agent_hmac_secret });
      nextByOrgId.set(row.id, row.agent_hmac_secret);
    }
    this.byToken = next;
    this.byOrgId = nextByOrgId;

    const { rows: domainRows } = await pool.query<{ custom_domain: string }>(
      `SELECT custom_domain FROM organizations WHERE custom_domain IS NOT NULL`,
    );
    this.customDomainOrigins = new Set(domainRows.map((r) => `https://${r.custom_domain.toLowerCase()}`));
  }

  resolveByToken(token: string): OrgCredential | null {
    return this.byToken.get(token) ?? null;
  }

  resolveByOrgId(orgId: string): string | null {
    return this.byOrgId.get(orgId) ?? null;
  }

  hasCustomDomainOrigin(origin: string): boolean {
    return this.customDomainOrigins.has(origin.toLowerCase());
  }
}
