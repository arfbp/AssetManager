// การติดตาม software license — CRUD ของตัว license เองก็รูปแบบเดียวกับ
// vendors/vendorsStore.ts assignment เป็นลิสต์ลูกธรรมดา seats ที่ใช้ไปคำนวณสด
// ตอนอ่าน (count(*) จาก assignments) ไม่เคยเก็บไว้ แนวทาง "คำนวณสด ไม่ cache"
// เดียวกับ book value ของ asset
import type { Pool } from "pg";

export interface LicenseAssignment {
  id: string;
  assetTag: string;
  assignedAt: string;
}

export interface LicenseRecord {
  id: string;
  name: string;
  vendorId: string | null;
  vendorName: string | null;
  licenseKey: string | null;
  seats: number | null;
  purchaseDate: string | null;
  expiryDate: string | null;
  cost: number | null;
  notes: string | null;
  assignments: LicenseAssignment[];
  seatsUsed: number;
  createdAt: string;
  updatedAt: string;
}

interface LicenseRow {
  id: string;
  name: string;
  vendor_id: string | null;
  vendor_name: string | null;
  license_key: string | null;
  seats: number | null;
  purchase_date: string | null;
  expiry_date: string | null;
  cost: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface AssignmentRow {
  id: string;
  license_id: string;
  asset_tag: string;
  assigned_at: string;
}

function rowToLicense(row: LicenseRow, assignments: LicenseAssignment[]): LicenseRecord {
  return {
    id: row.id,
    name: row.name,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    licenseKey: row.license_key,
    seats: row.seats,
    purchaseDate: row.purchase_date,
    expiryDate: row.expiry_date,
    cost: row.cost === null ? null : Number(row.cost),
    notes: row.notes,
    assignments,
    seatsUsed: assignments.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const LICENSE_SELECT = `SELECT l.id, l.name, l.vendor_id, v.name AS vendor_name, l.license_key, l.seats,
       l.purchase_date, l.expiry_date, l.cost, l.notes, l.created_at, l.updated_at
     FROM software_licenses l
     LEFT JOIN vendors v ON v.id = l.vendor_id`;

export async function listLicenses(pool: Pool, orgId: string): Promise<LicenseRecord[]> {
  const { rows: licenseRows } = await pool.query<LicenseRow>(`${LICENSE_SELECT} WHERE l.org_id = $1 ORDER BY l.name ASC`, [orgId]);
  if (licenseRows.length === 0) return [];
  const { rows: assignmentRows } = await pool.query<AssignmentRow>(
    `SELECT id, license_id, asset_tag, assigned_at FROM software_license_assignments WHERE org_id = $1 ORDER BY assigned_at ASC`,
    [orgId],
  );
  const byLicense = new Map<string, LicenseAssignment[]>();
  for (const row of assignmentRows) {
    const list = byLicense.get(row.license_id) ?? [];
    list.push({ id: row.id, assetTag: row.asset_tag, assignedAt: row.assigned_at });
    byLicense.set(row.license_id, list);
  }
  return licenseRows.map((row) => rowToLicense(row, byLicense.get(row.id) ?? []));
}

export async function getLicense(pool: Pool, orgId: string, id: string): Promise<LicenseRecord | null> {
  const { rows } = await pool.query<LicenseRow>(`${LICENSE_SELECT} WHERE l.org_id = $1 AND l.id = $2`, [orgId, id]);
  const row = rows[0];
  if (!row) return null;
  const { rows: assignmentRows } = await pool.query<AssignmentRow>(
    `SELECT id, license_id, asset_tag, assigned_at FROM software_license_assignments WHERE org_id = $1 AND license_id = $2 ORDER BY assigned_at ASC`,
    [orgId, id],
  );
  return rowToLicense(row, assignmentRows.map((r) => ({ id: r.id, assetTag: r.asset_tag, assignedAt: r.assigned_at })));
}

export interface LicenseInput {
  name?: string | undefined;
  vendorId?: string | null | undefined;
  licenseKey?: string | null | undefined;
  seats?: number | null | undefined;
  purchaseDate?: string | null | undefined;
  expiryDate?: string | null | undefined;
  cost?: number | null | undefined;
  notes?: string | null | undefined;
}

export async function createLicense(pool: Pool, orgId: string, input: LicenseInput): Promise<LicenseRecord> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO software_licenses (org_id, name, vendor_id, license_key, seats, purchase_date, expiry_date, cost, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [orgId, input.name ?? "", input.vendorId ?? null, input.licenseKey ?? null, input.seats ?? null, input.purchaseDate ?? null, input.expiryDate ?? null, input.cost ?? null, input.notes ?? null],
  );
  return (await getLicense(pool, orgId, rows[0]!.id))!;
}

export async function updateLicense(pool: Pool, orgId: string, id: string, input: LicenseInput): Promise<LicenseRecord | null> {
  const columns: Record<string, unknown> = {
    name: input.name,
    vendor_id: input.vendorId,
    license_key: input.licenseKey,
    seats: input.seats,
    purchase_date: input.purchaseDate,
    expiry_date: input.expiryDate,
    cost: input.cost,
    notes: input.notes,
  };
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [id, orgId];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    values.push(val === "" ? null : val);
    sets.push(`${col} = $${values.length}`);
  }
  const { rowCount } = await pool.query(`UPDATE software_licenses SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2`, values);
  if (!rowCount) return null;
  return getLicense(pool, orgId, id);
}

export async function deleteLicense(pool: Pool, orgId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM software_licenses WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (rowCount ?? 0) > 0;
}

export async function assignLicense(pool: Pool, orgId: string, licenseId: string, assetTag: string): Promise<LicenseRecord | null> {
  await pool.query(`INSERT INTO software_license_assignments (org_id, license_id, asset_tag) VALUES ($1, $2, $3)`, [orgId, licenseId, assetTag]);
  return getLicense(pool, orgId, licenseId);
}

export async function unassignLicense(pool: Pool, orgId: string, licenseId: string, assetTag: string): Promise<void> {
  await pool.query(`DELETE FROM software_license_assignments WHERE org_id = $1 AND license_id = $2 AND asset_tag = $3`, [orgId, licenseId, assetTag]);
}

// ป้อนข้อมูลให้แผง "needs attention" บน dashboard และงาน daily digest —
// รูปแบบเดียวกับ listAssetsWithExpiringWarranty ของ assets/assetsStore.ts
export async function listLicensesWithExpiring(pool: Pool, orgId: string, withinDays: number): Promise<{ id: string; name: string; expiryDate: string }[]> {
  const { rows } = await pool.query<{ id: string; name: string; expiry_date: string }>(
    `SELECT id, name, expiry_date FROM software_licenses
     WHERE org_id = $1 AND expiry_date IS NOT NULL AND expiry_date <= (CURRENT_DATE + $2 * INTERVAL '1 day')
     ORDER BY expiry_date ASC`,
    [orgId, withinDays],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, expiryDate: r.expiry_date }));
}
