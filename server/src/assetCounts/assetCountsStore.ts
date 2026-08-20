// การนับสินทรัพย์จริง (physical count) — รอบตรวจสอบตามคาบว่า asset
// "ยังอยู่ตรงที่เราคิดว่ามันอยู่หรือไม่" แต่ละรอบจะสร้างหนึ่งบรรทัดต่อ asset
// ที่ยัง active (ไม่ retired) พนักงานจะเช็คทีละตัวตามการตรวจสอบจริง
// พร้อมระบุตำแหน่งจริงถ้าต่างจากที่คาด (จะถูก flag เป็น discrepancy
// เพื่อติดตามต่อ)
import type { Pool } from "pg";

export interface AssetCountCycleRecord {
  id: string;
  name: string;
  startedAt: string;
  dueDate: string | null;
  status: "open" | "closed";
  createdBy: string;
  closedAt: string | null;
  totalLines: number;
  countedLines: number;
  discrepancyLines: number;
}

export interface AssetCountLineRecord {
  id: string;
  cycleId: string;
  assetTag: string;
  expectedLocation: string | null;
  counted: boolean;
  countedAt: string | null;
  countedBy: string | null;
  actualLocation: string | null;
  discrepancy: boolean;
  notes: string | null;
}

interface CycleRow {
  id: string;
  name: string;
  started_at: string;
  due_date: string | null;
  status: "open" | "closed";
  created_by: string;
  closed_at: string | null;
  total_lines: string;
  counted_lines: string;
  discrepancy_lines: string;
}

interface LineRow {
  id: string;
  cycle_id: string;
  asset_tag: string;
  expected_location: string | null;
  counted: boolean;
  counted_at: string | null;
  counted_by: string | null;
  actual_location: string | null;
  discrepancy: boolean;
  notes: string | null;
}

function rowToCycle(row: CycleRow): AssetCountCycleRecord {
  return {
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    dueDate: row.due_date,
    status: row.status,
    createdBy: row.created_by,
    closedAt: row.closed_at,
    totalLines: Number(row.total_lines),
    countedLines: Number(row.counted_lines),
    discrepancyLines: Number(row.discrepancy_lines),
  };
}

function rowToLine(row: LineRow): AssetCountLineRecord {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    assetTag: row.asset_tag,
    expectedLocation: row.expected_location,
    counted: row.counted,
    countedAt: row.counted_at,
    countedBy: row.counted_by,
    actualLocation: row.actual_location,
    discrepancy: row.discrepancy,
    notes: row.notes,
  };
}

const CYCLE_SELECT = `SELECT c.id, c.name, c.started_at, c.due_date, c.status, c.created_by, c.closed_at,
       count(l.id)::int AS total_lines,
       count(l.id) FILTER (WHERE l.counted)::int AS counted_lines,
       count(l.id) FILTER (WHERE l.discrepancy)::int AS discrepancy_lines
     FROM asset_count_cycles c
     LEFT JOIN asset_count_lines l ON l.cycle_id = c.id`;

export async function listCountCycles(pool: Pool, orgId: string): Promise<AssetCountCycleRecord[]> {
  const { rows } = await pool.query<CycleRow>(`${CYCLE_SELECT} WHERE c.org_id = $1 GROUP BY c.id ORDER BY c.started_at DESC`, [orgId]);
  return rows.map(rowToCycle);
}

export async function getCountCycle(pool: Pool, orgId: string, id: string): Promise<AssetCountCycleRecord | null> {
  const { rows } = await pool.query<CycleRow>(`${CYCLE_SELECT} WHERE c.org_id = $1 AND c.id = $2 GROUP BY c.id`, [orgId, id]);
  return rows[0] ? rowToCycle(rows[0]) : null;
}

export async function listCountLines(pool: Pool, orgId: string, cycleId: string): Promise<AssetCountLineRecord[]> {
  const { rows } = await pool.query<LineRow>(
    `SELECT id, cycle_id, asset_tag, expected_location, counted, counted_at, counted_by, actual_location, discrepancy, notes
     FROM asset_count_lines WHERE org_id = $1 AND cycle_id = $2 ORDER BY asset_tag ASC`,
    [orgId, cycleId],
  );
  return rows.map(rowToLine);
}

export async function startCountCycle(pool: Pool, orgId: string, name: string, dueDate: string | null, createdBy: string): Promise<AssetCountCycleRecord> {
  const client = await pool.connect();
  let cycleId: string;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO asset_count_cycles (org_id, name, due_date, status, created_by) VALUES ($1, $2, $3, 'open', $4) RETURNING id`,
      [orgId, name, dueDate, createdBy],
    );
    cycleId = rows[0]!.id;
    const { rows: activeAssets } = await client.query<{ asset_tag: string; location: string | null }>(
      `SELECT asset_tag, location FROM assets WHERE org_id = $1 AND status != 'retired'`,
      [orgId],
    );
    for (const asset of activeAssets) {
      await client.query(`INSERT INTO asset_count_lines (cycle_id, org_id, asset_tag, expected_location) VALUES ($1, $2, $3, $4)`, [cycleId, orgId, asset.asset_tag, asset.location]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return (await getCountCycle(pool, orgId, cycleId))!;
}

export async function markCounted(
  pool: Pool,
  orgId: string,
  lineId: string,
  input: { actualLocation?: string | null | undefined; notes?: string | null | undefined; countedBy: string },
): Promise<AssetCountLineRecord | null> {
  const { rows } = await pool.query<LineRow>(
    `UPDATE asset_count_lines SET
       counted = true, counted_at = now(), counted_by = $3,
       actual_location = $4::text, notes = COALESCE($5::text, notes),
       discrepancy = ($4::text IS NOT NULL AND $4::text IS DISTINCT FROM expected_location)
     WHERE id = $1 AND org_id = $2
     RETURNING id, cycle_id, asset_tag, expected_location, counted, counted_at, counted_by, actual_location, discrepancy, notes`,
    [lineId, orgId, input.countedBy, input.actualLocation ?? null, input.notes ?? null],
  );
  return rows[0] ? rowToLine(rows[0]) : null;
}

export async function closeCountCycle(pool: Pool, orgId: string, cycleId: string): Promise<AssetCountCycleRecord | null> {
  const { rowCount } = await pool.query(`UPDATE asset_count_cycles SET status = 'closed', closed_at = now() WHERE id = $1 AND org_id = $2`, [cycleId, orgId]);
  if (!rowCount) return null;
  return getCountCycle(pool, orgId, cycleId);
}
