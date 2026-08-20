// Timeline ประวัติของพนักงานแต่ละคนแบบรวมศูนย์ — merge handovers กับคำขอ asset
// แบบ self-service เข้าเป็นลิสต์เดียวที่เรียงลำดับแล้ว ใช้แสดงในแท็บ "History"
// ของหน้ารายละเอียดพนักงาน รูปแบบเดียวกับ assets/assetHistory.ts คือ query
// แยกตามตารางต้นทาง แล้ว merge ในหน่วยความจำและ sort ครั้งเดียวตอนท้าย ไม่ใช้
// SQL UNION ก้อนใหญ่ ด้วยเหตุผลเดียวกัน (แต่ละตารางมีรูปร่างต่างกัน และจำนวน
// row ต่อพนักงานก็น้อย)
//
// จงใจไม่รวม event ของ maintenance/connection/transfer/adjustment/retirement
// เพราะเหตุการณ์เหล่านั้นเป็นข้อเท็จจริงของ *asset* ไม่ใช่ของคน และอยู่ในแท็บ
// History ของหน้ารายละเอียด asset อยู่แล้ว ถ้าเอามาซ้ำที่นี่จะกลายเป็นบอกเป็นนัยว่า
// พนักงานเป็นคนทำสิ่งเหล่านั้น ซึ่งไม่มีข้อมูลใน schema รองรับ
import type { Pool } from "pg";
import { getEmployee } from "./employeesStore.js";

export type EmployeeHistoryEventKind = "handover_out" | "handover_returned" | "request_created" | "request_approved" | "request_rejected" | "request_cancelled";

// ต่างจาก AssetHistoryEvent ตรงที่มี assetTag ติดมาด้วย — timeline ของพนักงาน
// คนหนึ่งครอบคลุมหลาย asset ดังนั้น tag คือฟิลด์เดียวที่ UI ต้องแสดงและลิงก์ไปได้
export interface EmployeeHistoryEvent {
  kind: EmployeeHistoryEventKind;
  at: string;
  summary: string;
  assetTag: string;
}

export async function getEmployeeHistory(pool: Pool, orgId: string, employeeId: string): Promise<EmployeeHistoryEvent[]> {
  const employee = await getEmployee(pool, orgId, employeeId);
  if (!employee) return [];
  const events: EmployeeHistoryEvent[] = [];

  // เงื่อนไข OR นี้เป็นสะพานแบบอ่านอย่างเดียว/แสดงผลอย่างเดียว ไปยัง handover
  // ที่สร้างก่อนที่ระบบ employee directory จะมีอยู่ (row พวกนั้น employee_id
  // เป็น null มีแต่ชื่อแบบ free-text) เลือกใช้วิธีนี้แทนการ backfill แบบ fuzzy
  // ใน migrations/0030 (ดู doc comment ของไฟล์นั้นเอง) ไม่มีการเขียนกลับ ดังนั้น
  // ถ้าจับชื่อผิดคนก็แค่เป็นปัญหาความสวยงามของหน้านี้หน้าเดียว ไม่กระทบข้อมูลจริง
  const { rows: handovers } = await pool.query<{ asset_tag: string; employee_name: string; created_at: string; returned_at: string | null }>(
    `SELECT asset_tag, employee_name, created_at, returned_at FROM handovers
     WHERE org_id = $1 AND (employee_id = $2 OR (employee_id IS NULL AND lower(employee_name) = lower($3)))
     ORDER BY created_at DESC`,
    [orgId, employeeId, employee.name],
  );
  for (const h of handovers) {
    events.push({ kind: "handover_out", at: h.created_at, summary: `Checked out ${h.asset_tag}`, assetTag: h.asset_tag });
    if (h.returned_at) events.push({ kind: "handover_returned", at: h.returned_at, summary: `Checked in ${h.asset_tag}`, assetTag: h.asset_tag });
  }

  // แนวคิดเดียวกับ "เชื่อมโยง row ก่อนยุค directory ผ่าน login username ของ
  // ผู้ขอ" แค่ห่างออกไปหนึ่งชั้น: on_behalf_of_employee_id จะถูกตั้งค่าตอนอนุมัติ
  // เท่านั้น (ดู routes.ts) ดังนั้นคำขอที่อนุมัติก่อนพนักงานคนนี้จะมี record ใน
  // directory — หรืออนุมัติโดยไม่ได้เลือกใครเลย — ก็ยังจะโผล่ที่นี่ถ้า login
  // OptiFleet ของผู้ขอถูกเชื่อมกับพนักงานคนนี้
  const { rows: requests } = await pool.query<{
    asset_tag: string;
    status: string;
    note: string | null;
    created_at: string;
    approved_at: string | null;
    updated_at: string;
  }>(
    `SELECT ar.asset_tag, ar.status, ar.note, ar.created_at, ar.approved_at, ar.updated_at
     FROM asset_requests ar
     LEFT JOIN employees e ON e.id = $2 AND e.org_id = ar.org_id
     LEFT JOIN users u ON u.id = e.user_id
     WHERE ar.org_id = $1 AND (ar.on_behalf_of_employee_id = $2 OR (u.username IS NOT NULL AND ar.requested_by = u.username))
     ORDER BY ar.created_at DESC`,
    [orgId, employeeId],
  );
  for (const r of requests) {
    events.push({ kind: "request_created", at: r.created_at, summary: `Requested ${r.asset_tag}${r.note ? `: ${r.note}` : ""}`, assetTag: r.asset_tag });
    if (r.status === "approved" && r.approved_at) {
      events.push({ kind: "request_approved", at: r.approved_at, summary: `Request for ${r.asset_tag} approved`, assetTag: r.asset_tag });
    } else if (r.status === "rejected" && r.approved_at) {
      events.push({ kind: "request_rejected", at: r.approved_at, summary: `Request for ${r.asset_tag} rejected`, assetTag: r.asset_tag });
    } else if (r.status === "cancelled") {
      events.push({ kind: "request_cancelled", at: r.updated_at, summary: `Request for ${r.asset_tag} cancelled`, assetTag: r.asset_tag });
    }
  }

  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
