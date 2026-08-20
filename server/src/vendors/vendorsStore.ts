// ทะเบียนผู้ขาย (vendor/supplier) — คือคู่ค้าที่ purchase order สั่งซื้อด้วย
// CRUD ปกติ scope ต่อ org รูปแบบเดียวกับฟังก์ชันง่าย ๆ ของ assets/assetsStore.ts
// (ไม่ต้อง join live-telemetry เพราะ vendor ไม่มี device คู่กัน)
import type { Pool } from "pg";

export interface VendorRecord {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  // เพิ่มใน migrations/0031 — ชื่อบริษัทที่จดทะเบียนกับเลขประจำตัวผู้เสียภาษี
  // แยกออกจาก `name` (ชื่อย่อ/ชื่อแสดงผลที่ใช้ทั่วไป) เพราะในเอกสารของผู้ขาย
  // ไทยมักเป็นคนละชื่อกัน
  legalName: string | null;
  taxId: string | null;
  paymentTerms: string | null;
  bankAccountInfo: string | null;
  category: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface VendorRow {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  legal_name: string | null;
  tax_id: string | null;
  payment_terms: string | null;
  bank_account_info: string | null;
  category: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `id, name, contact_name, email, phone, address, legal_name, tax_id, payment_terms, bank_account_info, category, notes, created_at, updated_at`;

function rowToVendor(row: VendorRow): VendorRecord {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    legalName: row.legal_name,
    taxId: row.tax_id,
    paymentTerms: row.payment_terms,
    bankAccountInfo: row.bank_account_info,
    category: row.category,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listVendors(pool: Pool, orgId: string): Promise<VendorRecord[]> {
  const { rows } = await pool.query<VendorRow>(`SELECT ${SELECT_COLUMNS} FROM vendors WHERE org_id = $1 ORDER BY name ASC`, [orgId]);
  return rows.map(rowToVendor);
}

export async function getVendor(pool: Pool, orgId: string, vendorId: string): Promise<VendorRecord | null> {
  const { rows } = await pool.query<VendorRow>(`SELECT ${SELECT_COLUMNS} FROM vendors WHERE org_id = $1 AND id = $2`, [orgId, vendorId]);
  return rows[0] ? rowToVendor(rows[0]) : null;
}

export interface VendorInput {
  name?: string | undefined;
  contactName?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  address?: string | null | undefined;
  legalName?: string | null | undefined;
  taxId?: string | null | undefined;
  paymentTerms?: string | null | undefined;
  bankAccountInfo?: string | null | undefined;
  category?: string | null | undefined;
  notes?: string | null | undefined;
}

export async function createVendor(pool: Pool, orgId: string, input: VendorInput): Promise<VendorRecord> {
  const { rows } = await pool.query<VendorRow>(
    `INSERT INTO vendors (org_id, name, contact_name, email, phone, address, legal_name, tax_id, payment_terms, bank_account_info, category, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${SELECT_COLUMNS}`,
    [
      orgId,
      input.name ?? "",
      input.contactName ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.address ?? null,
      input.legalName ?? null,
      input.taxId ?? null,
      input.paymentTerms ?? null,
      input.bankAccountInfo ?? null,
      input.category ?? null,
      input.notes ?? null,
    ],
  );
  return rowToVendor(rows[0]!);
}

// ใช้ convention dynamic-SET-clause / ""->NULL แบบเดียวกับ updateAsset ของ
// assetsStore.ts — แก้เฉพาะฟิลด์ที่มีอยู่ใน `input` เท่านั้น
export async function updateVendor(pool: Pool, orgId: string, vendorId: string, input: VendorInput): Promise<VendorRecord | null> {
  const columns: Record<string, unknown> = {
    name: input.name,
    contact_name: input.contactName,
    email: input.email,
    phone: input.phone,
    address: input.address,
    legal_name: input.legalName,
    tax_id: input.taxId,
    payment_terms: input.paymentTerms,
    bank_account_info: input.bankAccountInfo,
    category: input.category,
    notes: input.notes,
  };

  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [vendorId, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val === "" ? null : val);
    sets.push(`${col} = $${values.length}`);
  }

  const { rows } = await pool.query<VendorRow>(
    `UPDATE vendors SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2 RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  return rows.length ? rowToVendor(rows[0]!) : null;
}

export async function deleteVendor(pool: Pool, orgId: string, vendorId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM vendors WHERE id = $1 AND org_id = $2`, [vendorId, orgId]);
  return (rowCount ?? 0) > 0;
}

// จับคู่แบบ exact ก่อนแล้วค่อย substring (ไม่สนตัวพิมพ์เล็กใหญ่) — รูปแบบเดียวกับ
// ที่ resolveByName ของ security/adminGuardrail.ts ใช้ สำหรับคำสั่งที่มาจาก
// AI console ซึ่งระบุชื่อผู้ขายแทนที่จะส่ง id มาตรง ๆ
export async function findVendorByName(pool: Pool, orgId: string, name: string): Promise<VendorRecord | "none" | "ambiguous"> {
  const { rows: exact } = await pool.query<VendorRow>(`SELECT ${SELECT_COLUMNS} FROM vendors WHERE org_id = $1 AND lower(name) = lower($2)`, [
    orgId,
    name,
  ]);
  if (exact.length === 1) return rowToVendor(exact[0]!);
  if (exact.length > 1) return "ambiguous";

  const { rows: partial } = await pool.query<VendorRow>(`SELECT ${SELECT_COLUMNS} FROM vendors WHERE org_id = $1 AND lower(name) LIKE lower($2)`, [
    orgId,
    `%${name}%`,
  ]);
  if (partial.length === 1) return rowToVendor(partial[0]!);
  if (partial.length > 1) return "ambiguous";
  return "none";
}
