// ค่าเสื่อมราคาสะสมที่อ้างอิงจาก GL ของ asset หนึ่งชิ้น — คือผลรวมของ
// depreciation_run_lines ที่ *posted* แล้วเท่านั้น แยกออกจาก computeBookValue
// ใน depreciation.ts โดยตั้งใจ (ซึ่งเป็นสูตรคำนวณสดล้วน ๆ ที่ไม่แตะบัญชีเลย)
// ค่านี้จะมีความหมายก็ต่อเมื่อ org รัน depreciation run และ post จริง ๆ
// เท่านั้น ส่วน org อื่นจะได้ค่าศูนย์ เหมือนกับว่าไม่มีฟีเจอร์นี้อยู่เลย
import type { Pool } from "pg";

export async function getAccumulatedDepreciation(pool: Pool, orgId: string, assetTag: string): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT SUM(drl.amount) AS total
     FROM depreciation_run_lines drl
     JOIN depreciation_runs dr ON dr.id = drl.run_id
     WHERE drl.org_id = $1 AND drl.asset_tag = $2 AND dr.status = 'posted'`,
    [orgId, assetTag],
  );
  return rows[0]?.total ? Number(rows[0].total) : 0;
}

// เวอร์ชัน batch สำหรับหน้าลิสต์ — query เดียวแทนที่จะเป็น N ครั้ง แนวทาง
// "หลีกเลี่ยง N+1" เดียวกับ query แยกตามแหล่งข้อมูลใน assetHistory.ts
export async function getAccumulatedDepreciationForAssets(pool: Pool, orgId: string): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ asset_tag: string; total: string }>(
    `SELECT drl.asset_tag, SUM(drl.amount) AS total
     FROM depreciation_run_lines drl
     JOIN depreciation_runs dr ON dr.id = drl.run_id
     WHERE drl.org_id = $1 AND dr.status = 'posted'
     GROUP BY drl.asset_tag`,
    [orgId],
  );
  return new Map(rows.map((r) => [r.asset_tag, Number(r.total)]));
}
