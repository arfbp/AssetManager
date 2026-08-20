// Purchase order พร้อม line item ของมัน ต้นทุนรวมของ PO คือ
// SUM(quantity * unit_cost) จาก item ทั้งหมดเสมอ คำนวณตรงนี้ ไม่ได้เก็บไว้บน
// row ของ purchase_orders — แนวทาง "คำนวณสด ไม่ cache" เดียวกับ book value
// ใน assets/depreciation.ts
import type { Pool } from "pg";

export interface PurchaseOrderItemRecord {
  id: string;
  description: string;
  quantity: number;
  unitCost: number;
  assetCategory: string | null;
}

export interface PurchaseOrderRecord {
  id: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  notes: string | null;
  items: PurchaseOrderItemRecord[];
  totalCost: number;
  createdAt: string;
  updatedAt: string;
}

interface PoRow {
  id: string;
  po_number: string;
  vendor_id: string;
  vendor_name: string;
  status: string;
  requested_by: string;
  approved_by: string | null;
  approved_at: string | null;
  order_date: string | null;
  expected_delivery_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  purchase_order_id: string;
  description: string;
  quantity: number;
  unit_cost: string; // คอลัมน์ NUMERIC ที่ pg คืนกลับมาเป็น string เสมอ
  asset_category: string | null;
}

function rowToItem(row: ItemRow): PurchaseOrderItemRecord {
  return {
    id: row.id,
    description: row.description,
    quantity: row.quantity,
    unitCost: Number(row.unit_cost),
    assetCategory: row.asset_category,
  };
}

function totalOf(items: PurchaseOrderItemRecord[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
}

function rowToPo(row: PoRow, items: PurchaseOrderItemRecord[]): PurchaseOrderRecord {
  return {
    id: row.id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    status: row.status,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    orderDate: row.order_date,
    expectedDeliveryDate: row.expected_delivery_date,
    notes: row.notes,
    items,
    totalCost: totalOf(items),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PO_SELECT = `SELECT po.id, po.po_number, po.vendor_id, v.name AS vendor_name, po.status,
       po.requested_by, po.approved_by, po.approved_at, po.order_date, po.expected_delivery_date,
       po.notes, po.created_at, po.updated_at
     FROM purchase_orders po
     JOIN vendors v ON v.id = po.vendor_id`;

export async function listPurchaseOrders(pool: Pool, orgId: string): Promise<PurchaseOrderRecord[]> {
  const { rows: poRows } = await pool.query<PoRow>(`${PO_SELECT} WHERE po.org_id = $1 ORDER BY po.created_at DESC`, [orgId]);
  if (poRows.length === 0) return [];

  const { rows: itemRows } = await pool.query<ItemRow>(
    `SELECT id, purchase_order_id, description, quantity, unit_cost, asset_category
     FROM purchase_order_items WHERE org_id = $1 ORDER BY id ASC`,
    [orgId],
  );
  const itemsByPo = new Map<string, PurchaseOrderItemRecord[]>();
  for (const row of itemRows) {
    const list = itemsByPo.get(row.purchase_order_id) ?? [];
    list.push(rowToItem(row));
    itemsByPo.set(row.purchase_order_id, list);
  }

  return poRows.map((row) => rowToPo(row, itemsByPo.get(row.id) ?? []));
}

export async function getPurchaseOrder(pool: Pool, orgId: string, id: string): Promise<PurchaseOrderRecord | null> {
  const { rows: poRows } = await pool.query<PoRow>(`${PO_SELECT} WHERE po.org_id = $1 AND po.id = $2`, [orgId, id]);
  const row = poRows[0];
  if (!row) return null;
  const { rows: itemRows } = await pool.query<ItemRow>(
    `SELECT id, purchase_order_id, description, quantity, unit_cost, asset_category
     FROM purchase_order_items WHERE org_id = $1 AND purchase_order_id = $2 ORDER BY id ASC`,
    [orgId, id],
  );
  return rowToPo(row, itemRows.map(rowToItem));
}

// เลขรันต่อองค์กรแบบเรียงลำดับ — idiom "นับ row ปัจจุบัน แล้ว zero-pad" เดียวกับ
// nextAssetTag ของ assets/assetsStore.ts
export async function nextPoNumber(pool: Pool, orgId: string): Promise<string> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchase_orders WHERE org_id = $1`, [orgId]);
  const n = (rows[0]?.n ?? 0) + 1;
  return `PO-${String(n).padStart(4, "0")}`;
}

export interface NewPurchaseOrderItemInput {
  description: string;
  quantity: number;
  unitCost: number;
  assetCategory?: string | null | undefined;
}

export interface NewPurchaseOrderInput {
  vendorId: string;
  orderDate?: string | null | undefined;
  expectedDeliveryDate?: string | null | undefined;
  notes?: string | null | undefined;
  items: NewPurchaseOrderItemInput[];
}

// สร้าง header ของ PO พร้อม line item ทั้งหมดในทรานแซกชันเดียว — PO ที่ไม่มี
// item เลยจะไม่มีความหมาย ดังนั้น row ทั้งสองฝั่งต้องเกิดพร้อมกันหรือไม่เกิดเลย
// แนวทาง "จัดการให้จบในทรานแซกชันเดียว" เดียวกับ deleteOrganization ของ
// orgsStore.ts
export async function createPurchaseOrder(
  pool: Pool,
  orgId: string,
  poNumber: string,
  requestedBy: string,
  input: NewPurchaseOrderInput,
): Promise<PurchaseOrderRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Omit<PoRow, "vendor_name">>(
      `INSERT INTO purchase_orders (org_id, po_number, vendor_id, status, requested_by, order_date, expected_delivery_date, notes)
       VALUES ($1, $2, $3, 'pending_approval', $4, $5, $6, $7)
       RETURNING id, po_number, vendor_id, status, requested_by, approved_by, approved_at, order_date, expected_delivery_date, notes, created_at, updated_at`,
      [orgId, poNumber, input.vendorId, requestedBy, input.orderDate ?? null, input.expectedDeliveryDate ?? null, input.notes ?? null],
    );
    const poId = rows[0]!.id;

    const items: PurchaseOrderItemRecord[] = [];
    for (const item of input.items) {
      const { rows: itemRows } = await client.query<ItemRow>(
        `INSERT INTO purchase_order_items (org_id, purchase_order_id, description, quantity, unit_cost, asset_category)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, purchase_order_id, description, quantity, unit_cost, asset_category`,
        [orgId, poId, item.description, item.quantity, item.unitCost, item.assetCategory ?? null],
      );
      items.push(rowToItem(itemRows[0]!));
    }
    await client.query("COMMIT");

    const { rows: vendorRows } = await pool.query<{ name: string }>(`SELECT name FROM vendors WHERE id = $1`, [input.vendorId]);
    const poRow: PoRow = { ...rows[0]!, vendor_name: vendorRows[0]?.name ?? "" };
    return rowToPo(poRow, items);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export class InvalidPoTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`can't move a purchase order from "${from}" to "${to}"`);
    this.name = "InvalidPoTransitionError";
  }
}

// ทุก transition ที่แอปนี้อนุญาตผ่าน UI/AI — อะไรที่ไม่อยู่ในนี้จะถูกปฏิเสธ
// ไม่ใช่ปล่อยผ่านเงียบ ๆ แนวทาง "ระบุให้ครบว่าอะไรไปถึงได้จริง" เดียวกับ
// ADMIN_ACTIONS ใน llm/adminSchema.ts
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending_approval: ["approved", "rejected", "cancelled"],
  approved: ["received", "cancelled"],
};

export async function setPurchaseOrderStatus(
  pool: Pool,
  orgId: string,
  id: string,
  toStatus: "approved" | "rejected" | "received" | "cancelled",
  approvedBy?: string,
): Promise<PurchaseOrderRecord | null> {
  const current = await getPurchaseOrder(pool, orgId, id);
  if (!current) return null;
  const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(toStatus)) throw new InvalidPoTransitionError(current.status, toStatus);

  if (toStatus === "approved" || toStatus === "rejected") {
    await pool.query(`UPDATE purchase_orders SET status = $3, approved_by = $4, approved_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2`, [
      id,
      orgId,
      toStatus,
      approvedBy ?? null,
    ]);
  } else {
    await pool.query(`UPDATE purchase_orders SET status = $3, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, toStatus]);
  }
  return getPurchaseOrder(pool, orgId, id);
}

export async function deletePurchaseOrder(pool: Pool, orgId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM purchase_orders WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (rowCount ?? 0) > 0;
}

// จับคู่ po_number แบบ exact ก่อนแล้วค่อย substring (ไม่สนตัวพิมพ์เล็กใหญ่) —
// รูปแบบเดียวกับที่ findVendorByName ของ vendorsStore.ts ใช้ สำหรับคำสั่งจาก
// AI console แบบ "approve PO-0003"
export async function findPurchaseOrderByNumber(pool: Pool, orgId: string, poNumber: string): Promise<PurchaseOrderRecord | "none" | "ambiguous"> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM purchase_orders WHERE org_id = $1 AND lower(po_number) = lower($2)`, [orgId, poNumber]);
  if (rows.length === 1) return (await getPurchaseOrder(pool, orgId, rows[0]!.id))!;
  if (rows.length > 1) return "ambiguous";
  return "none";
}
