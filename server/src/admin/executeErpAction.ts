// executor ตอน confirm สำหรับ ERP action ที่ผ่านการ resolve จาก
// security/erpGuardrail.ts มาแล้ว — ถูกเรียกจาก POST /api/command/:id/confirm
// หลังจากมนุษย์ตรวจสอบและยืนยัน approve/reject/schedule/complete/handover
// เรียก store function จริงตรง ๆ เป็นฟังก์ชันชุดเดียวกับที่หน้า Purchase Orders/
// Maintenance/Handovers ของ dashboard เรียกใช้ ดังนั้น action ที่สั่งผ่าน
// AI console จะให้ผลลัพธ์เหมือนกับสั่งผ่าน dashboard ทุกประการ — แนวทางเดียวกับ
// admin/executeAdminAction.ts ส่วน create_vendor/create_purchase_order
// ไม่มีทางมาถึงจุดนี้ — resolve เป็น "admin_form" (ให้มนุษย์กรอกฟอร์มจริง)
// ใน erpGuardrail.ts
import type { Pool } from "pg";
import { setPurchaseOrderStatus } from "../procurement/purchaseOrdersStore.js";
import { createMaintenanceRecord, completeMaintenanceRecord } from "../maintenance/maintenanceStore.js";
import { createHandover } from "../handovers/handoversStore.js";
import { recordAuditEvent } from "../audit/auditStore.js";
import type { ConfirmableErpAction } from "../security/erpGuardrail.js";

export async function executeErpAction(pool: Pool, orgId: string, resolved: ConfirmableErpAction, actorUsername: string): Promise<string> {
  switch (resolved.action) {
    case "approve_purchase_order":
    case "reject_purchase_order": {
      const toStatus = resolved.action === "approve_purchase_order" ? "approved" : "rejected";
      await setPurchaseOrderStatus(pool, orgId, resolved.poId, toStatus, actorUsername);
      await recordAuditEvent(pool, {
        actorUsername,
        orgId,
        action: `purchase_order.${toStatus}`,
        details: { poNumber: resolved.poNumber, via: "ai_console" },
      });
      return toStatus === "approved" ? `Approved purchase order "${resolved.poNumber}".` : `Rejected purchase order "${resolved.poNumber}".`;
    }

    case "schedule_maintenance": {
      await createMaintenanceRecord(pool, orgId, {
        assetTag: resolved.assetTag,
        description: resolved.fields.description,
        scheduledDate: resolved.fields.scheduledDate || null,
      });
      await recordAuditEvent(pool, {
        actorUsername,
        orgId,
        action: "maintenance.scheduled",
        details: { assetTag: resolved.assetTag, description: resolved.fields.description, via: "ai_console" },
      });
      return `Scheduled maintenance on "${resolved.assetTag}": ${resolved.fields.description}.`;
    }

    case "complete_maintenance": {
      await completeMaintenanceRecord(pool, orgId, resolved.recordId, new Date().toISOString().slice(0, 10), null);
      await recordAuditEvent(pool, {
        actorUsername,
        orgId,
        action: "maintenance.completed",
        details: { assetTag: resolved.assetTag, description: resolved.description, via: "ai_console" },
      });
      return `Marked "${resolved.description}" on "${resolved.assetTag}" as complete.`;
    }

    case "handover_asset": {
      await createHandover(pool, orgId, actorUsername, {
        assetTag: resolved.assetTag,
        employeeId: resolved.fields.employeeId || null,
        employeeName: resolved.fields.employeeName,
        employeeEmail: resolved.fields.employeeEmail || null,
        employeeDepartment: resolved.fields.employeeDepartment || null,
      });
      await recordAuditEvent(pool, {
        actorUsername,
        orgId,
        action: "asset.handed_over",
        details: { assetTag: resolved.assetTag, employeeName: resolved.fields.employeeName, employeeId: resolved.fields.employeeId || null, via: "ai_console" },
      });
      return `Handed over "${resolved.assetTag}" to ${resolved.fields.employeeName}.`;
    }

    default: {
      const exhaustive: never = resolved;
      throw new Error(`executeErpAction: unhandled resolved action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
