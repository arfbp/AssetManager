// คู่หูของ security/adminGuardrail.ts สำหรับคำสั่งฝั่ง ERP — จุดตรวจจุดเดียว
// ที่ทุก ErpParsedIntent ที่ parse มาแล้วต้องผ่านก่อนจะไปแตะต้อง vendor,
// purchase order, maintenance record หรือ handover ได้ ท่าทีความน่าเชื่อถือ
// เดียวกัน: ตัวมันเองไม่ได้เป็น authorization และทุก action ที่สร้างของใหม่
// จะเปิดฟอร์ม dashboard ที่ validate ไว้แล้วให้มนุษย์ตรวจก่อนเสมอ ไม่ใช่
// execute แบบไม่เห็นหน้า การเช็คสิทธิ์สะท้อนตาม REST routes เป๊ะๆ (ส่วน
// vendors/purchase-orders/maintenance/handovers ใน routes.ts) — ไม่ใช่
// policy ใหม่ แค่เป็น policy เดิมที่เข้าถึงได้จาก entry point ที่สอง
import type { Pool } from "pg";
import type { ErpParsedIntent } from "../llm/erpSchema.js";
import { findVendorByName } from "../vendors/vendorsStore.js";
import { findEmployeeByName } from "../employees/employeesStore.js";
import { findPurchaseOrderByNumber } from "../procurement/purchaseOrdersStore.js";
import { listMaintenanceRecords } from "../maintenance/maintenanceStore.js";
import { getAssetByTag } from "../assets/assetsStore.js";
import type { Role } from "../auth/roles.js";

export interface ErpGuardrailContext {
  role: Role;
  orgId: string;
  pool: Pool;
}

export type ResolvedErpAction =
  | { action: "create_vendor"; fields: { name: string; contactName: string; email: string; phone: string } }
  | { action: "create_purchase_order"; fields: { vendorId: string; vendorName: string; itemDescription: string; quantity: string; unitCost: string } }
  | { action: "approve_purchase_order" | "reject_purchase_order"; poId: string; poNumber: string }
  | { action: "schedule_maintenance"; assetTag: string; fields: { description: string; scheduledDate: string } }
  | { action: "complete_maintenance"; recordId: string; assetTag: string; description: string }
  | { action: "handover_asset"; assetTag: string; fields: { employeeId: string; employeeName: string; employeeEmail: string; employeeDepartment: string } };

// เฉพาะ tier ของ action ที่ไฟล์นี้จะ resolve ไปเป็น "needs_confirmation"
// จริงๆ — create_vendor/create_purchase_order จะ resolve ไปเป็น
// "admin_form" แทน (ให้มนุษย์กรอกฟอร์ม dashboard จริง) — ดู evaluateErpIntent
// ด้านล่าง ตีกรอบไว้ตรงนี้ด้วยเหตุผลเดียวกับที่ ConfirmableAdminAction ใน
// adminGuardrail.ts ต้องการ type-check แบบ exhaustive
export type ConfirmableErpAction = Exclude<ResolvedErpAction, { action: "create_vendor" | "create_purchase_order" }>;

export type ErpGuardrailVerdict =
  | { verdict: "blocked"; reason: string }
  | { verdict: "admin_form"; formAction: "create_vendor" | "create_purchase_order"; prefill: Record<string, string> }
  | { verdict: "needs_confirmation"; resolved: ConfirmableErpAction; reason: string };

function blocked(reason: string): ErpGuardrailVerdict {
  return { verdict: "blocked", reason };
}

export async function evaluateErpIntent(parsed: ErpParsedIntent, ctx: ErpGuardrailContext): Promise<ErpGuardrailVerdict> {
  if (ctx.role === "viewer") return blocked("Your account is read-only and cannot make ERP changes.");

  switch (parsed.action) {
    case "create_vendor": {
      return {
        verdict: "admin_form",
        formAction: "create_vendor",
        prefill: {
          name: parsed.fields.name,
          contactName: parsed.fields.contactName,
          email: parsed.fields.email,
          phone: parsed.fields.phone,
        },
      };
    }

    case "create_purchase_order": {
      let vendorId = "";
      let vendorName = parsed.fields.vendorName;
      if (vendorName.trim()) {
        const match = await findVendorByName(ctx.pool, ctx.orgId, vendorName);
        if (match === "ambiguous") return blocked(`"${vendorName}" matches more than one vendor — be more specific.`);
        if (match !== "none") {
          vendorId = match.id;
          vendorName = match.name;
        }
        // "none" ไม่ถูก block — ฟอร์มที่ prefill ไว้ยังเปิดขึ้นมาพร้อมชื่อ
        // vendor เป็น free text ให้มนุษย์เลือกตัวที่ถูกต้องเอง (หรือสร้าง
        // vendor ใหม่ก่อน) แทนที่จะตันตรงนี้
      }
      return {
        verdict: "admin_form",
        formAction: "create_purchase_order",
        prefill: {
          vendorId,
          vendorName,
          itemDescription: parsed.fields.itemDescription,
          quantity: parsed.fields.quantity,
          unitCost: parsed.fields.unitCost,
        },
      };
    }

    case "approve_purchase_order":
    case "reject_purchase_order": {
      if (ctx.role !== "admin") return blocked("Only an organization admin can approve or reject purchase orders.");
      const match = await findPurchaseOrderByNumber(ctx.pool, ctx.orgId, parsed.targetName);
      if (match === "none") return blocked(`No purchase order matches "${parsed.targetName}".`);
      if (match === "ambiguous") return blocked(`"${parsed.targetName}" matches more than one purchase order — be more specific.`);
      if (match.status !== "pending_approval") {
        return blocked(`Purchase order "${match.poNumber}" is "${match.status}", not awaiting approval.`);
      }
      const reason =
        parsed.action === "approve_purchase_order"
          ? `This approves purchase order "${match.poNumber}" (${match.vendorName}, $${match.totalCost.toFixed(2)}).`
          : `This rejects purchase order "${match.poNumber}" (${match.vendorName}, $${match.totalCost.toFixed(2)}).`;
      return { verdict: "needs_confirmation", resolved: { action: parsed.action, poId: match.id, poNumber: match.poNumber }, reason };
    }

    case "schedule_maintenance": {
      const asset = await getAssetByTag(ctx.pool, ctx.orgId, parsed.targetName);
      if (!asset) return blocked(`No asset matches "${parsed.targetName}".`);
      if (!parsed.fields.description.trim()) return blocked("Say what maintenance/repair is needed, not just the asset.");
      return {
        verdict: "needs_confirmation",
        resolved: { action: "schedule_maintenance", assetTag: asset.assetTag, fields: { description: parsed.fields.description, scheduledDate: parsed.fields.scheduledDate } },
        reason: `This schedules maintenance on "${asset.assetTag}": ${parsed.fields.description}.`,
      };
    }

    case "complete_maintenance": {
      const asset = await getAssetByTag(ctx.pool, ctx.orgId, parsed.targetName);
      if (!asset) return blocked(`No asset matches "${parsed.targetName}".`);
      const records = await listMaintenanceRecords(ctx.pool, ctx.orgId, asset.assetTag);
      const openRecords = records.filter((r) => r.status === "scheduled");
      if (openRecords.length === 0) return blocked(`No scheduled maintenance is open for "${asset.assetTag}".`);
      if (openRecords.length > 1) return blocked(`"${asset.assetTag}" has more than one open maintenance record — complete it from the Maintenance page instead.`);
      const record = openRecords[0]!;
      return {
        verdict: "needs_confirmation",
        resolved: { action: "complete_maintenance", recordId: record.id, assetTag: asset.assetTag, description: record.description },
        reason: `This marks "${record.description}" on "${asset.assetTag}" as complete.`,
      };
    }

    case "handover_asset": {
      const asset = await getAssetByTag(ctx.pool, ctx.orgId, parsed.targetName);
      if (!asset) return blocked(`No asset matches "${parsed.targetName}".`);
      if (!parsed.fields.employeeName.trim()) return blocked("Say who the asset is being handed over to.");

      let employeeId = "";
      let { employeeName, employeeEmail, employeeDepartment } = parsed.fields;
      const match = await findEmployeeByName(ctx.pool, ctx.orgId, employeeName);
      if (match === "ambiguous") return blocked(`"${employeeName}" matches more than one employee — be more specific.`);
      if (match !== "none") {
        // Canonicalize จาก record ใน directory เหมือนกับการ resolve vendor
        // ของ create_purchase_order ด้านบน "none" ไม่ถูก block — พนักงานที่
        // ยังไม่มีใน directory ก็ยังทำ handover แบบ free-text ได้ ไม่ใช่ตัน
        // ตรงนี้สำหรับ operator
        employeeId = match.id;
        employeeName = match.name;
        employeeEmail = employeeEmail || match.email || "";
        employeeDepartment = employeeDepartment || match.departmentName || "";
      }

      return {
        verdict: "needs_confirmation",
        resolved: {
          action: "handover_asset",
          assetTag: asset.assetTag,
          fields: { employeeId, employeeName, employeeEmail, employeeDepartment },
        },
        reason: `This hands over "${asset.assetTag}" to ${employeeName}${employeeDepartment ? ` (${employeeDepartment})` : ""}${employeeId ? "" : " — not in the employee directory"}.`,
      };
    }

    default: {
      const exhaustive: never = parsed.action;
      return blocked(`unhandled erp action: ${exhaustive}`);
    }
  }
}
