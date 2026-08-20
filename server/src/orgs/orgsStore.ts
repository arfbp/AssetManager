// การจัดการ organization (tenant) — สร้าง org ใหม่และแสดงรายการ org ที่มีอยู่
// ตั้งใจแยกออกจาก auth/users.ts: การสร้าง ORG เป็นการกระทำระดับ platform (ว่า
// ใครมีสิทธิ์ทำได้ถูกกำหนดไว้ใน routes.ts ผ่าน PLATFORM_ORG_ID ด้านล่าง ไม่ใช่
// role admin ปกติของแต่ละ org) ส่วนการสร้าง USER ภายใน org ที่มีอยู่แล้วเป็น
// หน้าที่ของ auth/users.ts
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";

// UUID ตายตัวของ fleet แบบ single-tenant ดั้งเดิม (migrations/0001_organizations.sql)
// ทำหน้าที่เป็น "org ของเจ้าของ platform" ไปด้วยในตัว จนกว่าจะมีโมเดล
// governance ระดับ platform แบบ multi-admin จริง ๆ (ดู Phase 9 ของแผน
// multi-tenant migration) — มีแค่ admin ของ org นี้เท่านั้นที่สร้าง/แสดง
// organization อื่นได้ วันนี้ยังไม่ใช่ข้อจำกัดที่มีความหมายอะไรนัก (มี admin
// แบบนี้อยู่คนเดียวคือคนที่ดูแล deployment ทั้งหมดนี้) แต่ก็ช่วยกันไม่ให้
// ความสามารถนี้เผลอเปิดให้ admin ของ org อื่นในอนาคตใช้ได้ แค่เพราะเขาก็มี
// role "admin" ภายใน org ของตัวเองเหมือนกัน
export const PLATFORM_ORG_ID = "00000000-0000-0000-0000-000000000001";

export interface OrganizationSummary {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  status: string;
  createdAt: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  subdomain: string;
  custom_domain: string | null;
  status: string;
  created_at: string;
}

function rowToSummary(row: OrganizationRow): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    subdomain: row.subdomain,
    customDomain: row.custom_domain,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function listOrganizations(pool: Pool): Promise<OrganizationSummary[]> {
  const { rows } = await pool.query<OrganizationRow>(
    `SELECT id, name, subdomain, custom_domain, status, created_at FROM organizations ORDER BY created_at ASC`,
  );
  return rows.map(rowToSummary);
}

export class DuplicateCustomDomainError extends Error {
  constructor(domain: string) {
    super(`custom domain "${domain}" is already taken`);
    this.name = "DuplicateCustomDomainError";
  }
}

// กำหนด (หรือล้าง ด้วย domain === null) โดเมนที่ org เป็นเจ้าของเองเต็มรูปแบบ
// ผู้เรียกต้องเรียก OrgCredentialCache#reload ตามหลังเสมอ เพื่อให้
// CORS allow-list (ซึ่ง cache ไว้ล่วงหน้า ด้วยเหตุผลเดียวกับ agent
// credentials — ดู orgCredentials.ts) รับรู้การเปลี่ยนแปลงโดยไม่ต้อง
// restart server
export async function setCustomDomain(pool: Pool, orgId: string, domain: string | null): Promise<OrganizationSummary> {
  try {
    const { rows } = await pool.query<OrganizationRow>(
      `UPDATE organizations SET custom_domain = $2 WHERE id = $1
       RETURNING id, name, subdomain, custom_domain, status, created_at`,
      [orgId, domain],
    );
    const row = rows[0];
    if (!row) throw new Error(`organization not found: ${orgId}`);
    return rowToSummary(row);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505" && domain) {
      throw new DuplicateCustomDomainError(domain);
    }
    throw err;
  }
}

// ต่างจาก credential ที่คืนค่าครั้งเดียวตอนสร้าง ตัวนี้อ่านกลับมาได้จริง ๆ —
// organizations.agent_auth_token/agent_hmac_secret ถูกเก็บเป็น plain text
// ใน Postgres อยู่แล้วไม่ว่าจะทำอย่างไร (verifyClient ต้องใช้ค่าจริงตรง ๆ
// ทุกครั้งที่ agent เชื่อมต่อ ต่างจากรหัสผ่าน user ที่ hash ด้วย bcrypt) จึง
// ไม่มีความลับอะไรเหลือให้ต้องรักษาไว้ด้วยการปฏิเสธไม่คืนค่านี้กลับมาอีก สิ่ง
// ที่ฟังก์ชันนี้ทำได้คือ: สร้าง/ดาวน์โหลด installer .zip ของ org ใหม่ได้ใน
// ภายหลัง โดยไม่ต้องเคยคัดลอก credential เก็บไว้ตั้งแต่ตอนสร้าง — ดู
// GET /api/orgs/:id/installer
export async function getOrganizationCredentials(
  pool: Pool,
  orgId: string,
): Promise<{ org: OrganizationSummary; agentAuthToken: string; agentHmacSecret: string } | null> {
  const { rows } = await pool.query<OrganizationRow & { agent_auth_token: string; agent_hmac_secret: string }>(
    `SELECT id, name, subdomain, custom_domain, status, created_at, agent_auth_token, agent_hmac_secret FROM organizations WHERE id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) return null;
  return { org: rowToSummary(row), agentAuthToken: row.agent_auth_token, agentHmacSecret: row.agent_hmac_secret };
}

export class DuplicateSubdomainError extends Error {
  constructor(subdomain: string) {
    super(`subdomain "${subdomain}" is already taken`);
    this.name = "DuplicateSubdomainError";
  }
}

export interface NewOrganization {
  org: OrganizationSummary;
  // คืนค่าครั้งเดียวตอนสร้าง — แนวทาง "แสดงครั้งเดียว จดไว้เลย" เดียวกับ
  // secret ที่สร้างขึ้นใหม่ตัวอื่น ๆ ไม่มีทางดึงกลับมาดูได้อีกผ่าน endpoint
  // ไหน (organizations.agent_auth_token จะไม่ถูก select กลับออกมาเลย
  // ยกเว้นตอนที่ org-credential cache โหลดตอน boot กับ INSERT ... RETURNING
  // ตัวนี้เท่านั้น)
  agentAuthToken: string;
  agentHmacSecret: string;
}

// subdomain เป็น DNS label (จะกลายเป็นเช่น "<subdomain>.optifleet.ai" เมื่อ
// โดเมนจริงของ Phase 6 ใช้งานได้) — ใช้ได้เฉพาะตัวพิมพ์เล็ก/ตัวเลข/ยัติภังค์
// เท่านั้น ห้ามขึ้นต้น/ลงท้ายด้วยยัติภังค์ ตรงกับที่ regex ของ nginx
// server_name และ certbot ยอมรับทั้งคู่
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSubdomain(subdomain: string): boolean {
  return SUBDOMAIN_PATTERN.test(subdomain);
}

// FQDN เต็มรูปแบบที่ org นำมาเอง (เช่น "assets.360qm.co.th") ต่างจาก label
// เปล่า ๆ ภายใต้ orgDomainSuffix ที่ใช้ร่วมกัน — กฎระดับ label เดียวกับ
// SUBDOMAIN_PATTERN แต่ทำซ้ำได้หลาย label คั่นด้วยจุด
const CUSTOM_DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidCustomDomain(domain: string): boolean {
  return CUSTOM_DOMAIN_PATTERN.test(domain);
}

export async function createOrganization(pool: Pool, name: string, subdomain: string): Promise<NewOrganization> {
  const agentAuthToken = randomBytes(32).toString("hex");
  const agentHmacSecret = randomBytes(32).toString("hex");
  try {
    const { rows } = await pool.query<OrganizationRow & { agent_auth_token: string; agent_hmac_secret: string }>(
      `INSERT INTO organizations (name, subdomain, agent_auth_token, agent_hmac_secret)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, subdomain, custom_domain, status, created_at, agent_auth_token, agent_hmac_secret`,
      [name, subdomain, agentAuthToken, agentHmacSecret],
    );
    const row = rows[0]!;
    return { org: rowToSummary(row), agentAuthToken: row.agent_auth_token, agentHmacSecret: row.agent_hmac_secret };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new DuplicateSubdomainError(subdomain);
    }
    throw err;
  }
}

// ถูก throw โดยทุก operation ด้านล่างที่จะทำให้ platform org
// (PLATFORM_ORG_ID) ถูก suspend หรือ delete ได้ — org นี้มีบัญชีเดียวเท่านั้นที่
// จัดการ org อื่นทั้งหมดได้ ทำแบบนี้กับมันจะเท่ากับล็อกทั้ง platform ออกแบบ
// ถาวรโดยไม่มีทางกลับเข้ามาได้อีกเลย
export class PlatformOrgProtectedError extends Error {
  constructor(action: string) {
    super(`The platform organization can't be ${action} — it would lock out every platform admin.`);
    this.name = "PlatformOrgProtectedError";
  }
}

export async function setOrgStatus(pool: Pool, orgId: string, status: "active" | "suspended"): Promise<OrganizationSummary> {
  if (orgId === PLATFORM_ORG_ID && status === "suspended") throw new PlatformOrgProtectedError("suspended");
  const { rows } = await pool.query<OrganizationRow>(
    `UPDATE organizations SET status = $2 WHERE id = $1
     RETURNING id, name, subdomain, custom_domain, status, created_at`,
    [orgId, status],
  );
  const row = rows[0];
  if (!row) throw new Error(`organization not found: ${orgId}`);
  return rowToSummary(row);
}

// ทุก field เป็น optional — รูปแบบ "รวมทุกอย่างไว้เรียกครั้งเดียว" เดียวกับ
// updateUserProfile/PATCH /users/:id ของ auth/users.ts
export async function updateOrganization(
  pool: Pool,
  orgId: string,
  fields: { name?: string | undefined; subdomain?: string | undefined },
): Promise<OrganizationSummary> {
  try {
    if (fields.name !== undefined) {
      await pool.query(`UPDATE organizations SET name = $2 WHERE id = $1`, [orgId, fields.name]);
    }
    if (fields.subdomain !== undefined) {
      await pool.query(`UPDATE organizations SET subdomain = $2 WHERE id = $1`, [orgId, fields.subdomain]);
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new DuplicateSubdomainError(fields.subdomain ?? "");
    }
    throw err;
  }
  const { rows } = await pool.query<OrganizationRow>(
    `SELECT id, name, subdomain, custom_domain, status, created_at FROM organizations WHERE id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) throw new Error(`organization not found: ${orgId}`);
  return rowToSummary(row);
}

// ลบ org และทุกแถวที่ขึ้นกับมันแบบถาวร ย้อนกลับไม่ได้ — foreign key org_id
// ทุกตัวใน schema นี้ตั้งใจประกาศเป็น RESTRICT ไม่ใช่ CASCADE (ดู
// migrations/0002_org_id_backfill.sql) ดังนั้น `DELETE FROM organizations`
// เปล่า ๆ จะล้มเหลวทันที ฟังก์ชันนี้ทำความสะอาดตามลำดับด้วยมือ ในหนึ่ง
// transaction ตามลำดับ dependency แบบเดียวกับที่การเคลียร์ข้อมูลด้วย psql
// ด้วยมือของโปรเจกต์นี้ใช้มาตลอด: telemetry/history/incidents ก่อน (ไม่มี
// อะไรอ้างอิงถึงมัน) ตามด้วย assets/agents ตามด้วย sessions/setup-tokens
// (ผ่าน users.org_id — ทั้งคู่เป็น ON DELETE CASCADE จาก users(id) ดู
// schema.sql และ migrations/0008) แล้วค่อยเป็น users เอง สุดท้ายคือแถว org
// ส่วน audit_events ตั้งใจปล่อยไว้เฉย ๆ — org_id ของมันเป็น
// ON DELETE SET NULL จึงรอดจากการลบนี้ได้โดยตั้งใจ (ดู doc comment ของ
// migrations/0010)
export async function deleteOrganization(pool: Pool, orgId: string): Promise<void> {
  if (orgId === PLATFORM_ORG_ID) throw new PlatformOrgProtectedError("deleted");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM telemetry_snapshots WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM command_history WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM device_incidents WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM asset_connection_history WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM assets WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agents WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE org_id = $1`, [orgId]);
    const { rowCount } = await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    if (!rowCount) throw new Error(`organization not found: ${orgId}`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// อัปเดตแค่คอลัมน์เดียว — ไบต์ของรูปจริงเก็บอยู่บนดิสก์ (cfg.orgLogosDir)
// ไม่ใช่ใน Postgres contentType === null หมายถึง "ไม่มีโลโก้กำหนดเอง ใช้
// เครื่องหมายเริ่มต้น" (ดู GET /orgs/:id/logo)
export async function setOrgLogoContentType(pool: Pool, orgId: string, contentType: string | null): Promise<void> {
  await pool.query(`UPDATE organizations SET logo_content_type = $2 WHERE id = $1`, [orgId, contentType]);
}

export async function getOrgLogoContentType(pool: Pool, orgId: string): Promise<string | null> {
  const { rows } = await pool.query<{ logo_content_type: string | null }>(
    `SELECT logo_content_type FROM organizations WHERE id = $1`,
    [orgId],
  );
  return rows[0]?.logo_content_type ?? null;
}

// ข้อความ terms/EULA แบบเลือกได้ที่แสดงตอนเบิก asset — null หมายถึง org ยัง
// ไม่ได้ตั้งค่าไว้ และ flow การส่งมอบจะยังเป็นกระบวนการ print แล้วเซ็นด้วยมือ
// จริงแบบเดิมทุกอย่าง ไม่มีขั้นตอนบังคับให้ยอมรับ
export async function setCheckoutEulaText(pool: Pool, orgId: string, text: string | null): Promise<void> {
  await pool.query(`UPDATE organizations SET checkout_eula_text = $2 WHERE id = $1`, [orgId, text]);
}

export async function getCheckoutEulaText(pool: Pool, orgId: string): Promise<string | null> {
  const { rows } = await pool.query<{ checkout_eula_text: string | null }>(`SELECT checkout_eula_text FROM organizations WHERE id = $1`, [orgId]);
  return rows[0]?.checkout_eula_text ?? null;
}
