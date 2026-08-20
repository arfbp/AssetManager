// executor ตอน confirm สำหรับ admin action ที่ผ่านการ resolve จาก
// security/adminGuardrail.ts มาแล้ว — ถูกเรียกจาก POST /api/command/:id/confirm
// หลังจากมนุษย์ตรวจสอบและยืนยัน suspend/reactivate/delete ขององค์กรหรือผู้ใช้
// เรียก store function จริงตรง ๆ (ไม่ผ่าน registry.sendCommand/WS เพราะ action
// พวกนี้ไม่มี device เกี่ยวข้อง) เป็นฟังก์ชันชุดเดียวกับที่หน้า Organizations/Users
// ของ dashboard เรียกใช้ ดังนั้น action ที่สั่งผ่าน AI console จะให้ผลลัพธ์
// เหมือนกับสั่งผ่าน dashboard ทุกประการ (สถานะใน DB, audit trail, การ reload
// credential cache) ส่วน create_organization/create_user/generate_installer
// ไม่มีทางมาถึงจุดนี้ — สองตัวแรก resolve เป็น "admin_form" (ให้มนุษย์กรอกฟอร์มจริง)
// ส่วนตัวสุดท้าย resolve เป็น "allowed" และตอบกลับตรงใน routes.ts เลย
import type { Pool } from "pg";
import { setOrgStatus, deleteOrganization } from "../orgs/orgsStore.js";
import { setUserStatus, deleteUser } from "../auth/users.js";
import { recordAuditEvent } from "../audit/auditStore.js";
import type { OrgCredentialCache } from "../orgs/orgCredentials.js";
import type { ConfirmableAdminAction } from "../security/adminGuardrail.js";

export async function executeAdminAction(
  pool: Pool,
  resolved: ConfirmableAdminAction,
  actorUsername: string,
  orgCredentials: OrgCredentialCache,
): Promise<string> {
  switch (resolved.action) {
    case "suspend_organization":
    case "reactivate_organization": {
      const status = resolved.action === "suspend_organization" ? "suspended" : "active";
      await setOrgStatus(pool, resolved.orgId, status);
      await orgCredentials.reload(pool);
      await recordAuditEvent(pool, {
        actorUsername,
        orgId: resolved.orgId,
        action: "org.status_changed",
        details: { orgName: resolved.orgName, status, via: "ai_console" },
      });
      return status === "suspended" ? `Suspended "${resolved.orgName}".` : `Reactivated "${resolved.orgName}".`;
    }

    case "delete_organization": {
      await deleteOrganization(pool, resolved.orgId);
      await orgCredentials.reload(pool);
      await recordAuditEvent(pool, {
        actorUsername,
        orgId: null,
        action: "org.deleted",
        details: { orgName: resolved.orgName, via: "ai_console" },
      });
      return `Deleted "${resolved.orgName}" and everything in it.`;
    }

    case "suspend_user":
    case "reactivate_user": {
      const status = resolved.action === "suspend_user" ? "suspended" : "active";
      await setUserStatus(pool, resolved.orgId, resolved.userId, status);
      await recordAuditEvent(pool, {
        actorUsername,
        orgId: resolved.orgId,
        action: "user.status_changed",
        details: { targetUsername: resolved.username, status, via: "ai_console" },
      });
      return status === "suspended" ? `Suspended user "${resolved.username}".` : `Reactivated user "${resolved.username}".`;
    }

    case "delete_user": {
      await deleteUser(pool, resolved.orgId, resolved.userId);
      await recordAuditEvent(pool, {
        actorUsername,
        orgId: resolved.orgId,
        action: "user.deleted",
        details: { targetUsername: resolved.username, via: "ai_console" },
      });
      return `Deleted user "${resolved.username}".`;
    }

    default: {
      const exhaustive: never = resolved;
      throw new Error(`executeAdminAction: unhandled resolved action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
