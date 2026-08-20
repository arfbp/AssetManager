// คู่หูของ guardrail.ts สำหรับคำสั่งฝั่ง admin — จุดตรวจจุดเดียวที่ทุก
// AdminParsedIntent ที่ parse มาแล้วต้องผ่านก่อนจะไปแตะต้อง organization หรือ
// user account ได้ ท่าทีความน่าเชื่อถือเดียวกับ guardrail.ts: ตัวมันเองไม่ได้
// เป็น authorization และทุก action ที่สร้างของใหม่จะเปิดฟอร์ม dashboard ที่
// validate ไว้แล้วให้มนุษย์ตรวจก่อนเสมอ ไม่ใช่ execute แบบไม่เห็นหน้า (ดู
// design note ของ plan สำหรับ admin-commands บน AI console ว่าทำไม) การเช็ค
// สิทธิ์สะท้อนตาม REST routes เป๊ะๆ — action ที่ลงท้าย *_organization ต้องการ
// ขอบเขต platform-admin เดียวกับที่ requirePlatformAdmin ใน routes.ts บังคับ
// ใช้อยู่แล้ว action ที่ลงท้าย *_user ต้องการขอบเขต org-admin เดียวกับที่
// route /users บังคับใช้อยู่แล้ว — ไม่ใช่ policy ใหม่ แค่เป็น policy เดิมที่
// เข้าถึงได้จาก entry point ที่สอง
import type { Pool } from "pg";
import type { AdminParsedIntent } from "../llm/adminSchema.js";
import { listOrganizations } from "../orgs/orgsStore.js";
import { listUsers, otherAdminCount } from "../auth/users.js";
import { isRole, type Role } from "../auth/roles.js";

export interface AdminGuardrailContext {
  role: Role;
  orgId: string;
  isPlatformAdmin: boolean;
  pool: Pool;
}

export type ResolvedAdminAction =
  | { action: "create_organization"; fields: { name: string; subdomain: string; adminUsername: string; adminEmail: string } }
  | { action: "create_user"; orgId: string; fields: { username: string; role: Role; firstName: string; lastName: string } }
  | { action: "suspend_organization" | "reactivate_organization" | "delete_organization"; orgId: string; orgName: string }
  | { action: "suspend_user" | "reactivate_user" | "delete_user"; orgId: string; userId: string; username: string }
  | { action: "generate_installer"; orgId: string; orgName: string; subdomain: string };

// เฉพาะ tier ของ action ที่ไฟล์นี้จะ resolve ไปเป็น "needs_confirmation"
// จริงๆ — create_organization/create_user จะ resolve ไปเป็น "admin_form"
// แทน (ให้มนุษย์กรอกฟอร์ม dashboard จริง) และ generate_installer จะ
// resolve ไปเป็น "allowed" (ไม่มีอะไรต้องยืนยัน) — ดู evaluateAdminIntent
// ด้านล่าง ตีกรอบไว้ตรงนี้ (ไม่ใช่แค่ที่ executor) เพื่อให้ทั้งสาย ตั้งแต่ผล
// ตัดสินของ guardrail ไปจนถึง admin/executeAdminAction.ts ถูก type-check
// แบบ exhaustive ตรงกับสิ่งที่เกิดขึ้นได้จริงเป๊ะๆ
export type ConfirmableAdminAction = Exclude<ResolvedAdminAction, { action: "create_organization" | "create_user" | "generate_installer" }>;

export type AdminGuardrailVerdict =
  | { verdict: "blocked"; reason: string }
  | { verdict: "admin_form"; formAction: "create_organization" | "create_user"; prefill: Record<string, string> }
  | { verdict: "needs_confirmation"; resolved: ConfirmableAdminAction; reason: string }
  | { verdict: "allowed"; resolved: ResolvedAdminAction };

function blocked(reason: string): AdminGuardrailVerdict {
  return { verdict: "blocked", reason };
}

// จับคู่แบบตรงเป๊ะโดยไม่สนตัวพิมพ์ก่อน แล้วค่อย substring — รูปแบบสอง pass
// เดียวกันสำหรับทั้ง org และ user ด้านล่าง กรณีกำกวม (substring match ได้
// มากกว่าหนึ่ง) ถือเป็นความล้มเหลว ไม่ใช่การเดา: ผู้เรียกต้องระบุให้ชัดเจนขึ้น
// แทนที่ระบบจะเดาเลือกเอาชื่อใดชื่อหนึ่งที่คล้ายกันแบบเงียบๆ
function resolveByName<T extends { id: string }>(items: T[], name: (item: T) => string, query: string): T | "none" | "ambiguous" {
  const needle = query.trim().toLowerCase();
  if (!needle) return "none";
  const exact = items.filter((item) => name(item).toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return "ambiguous";
  const partial = items.filter((item) => name(item).toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) return "ambiguous";
  return "none";
}

export async function evaluateAdminIntent(parsed: AdminParsedIntent, ctx: AdminGuardrailContext): Promise<AdminGuardrailVerdict> {
  switch (parsed.action) {
    case "create_organization": {
      if (!ctx.isPlatformAdmin) return blocked("Only the platform's own admins can create organizations.");
      return {
        verdict: "admin_form",
        formAction: "create_organization",
        prefill: {
          name: parsed.fields.name,
          subdomain: parsed.fields.subdomain,
          adminUsername: parsed.fields.adminUsername,
          adminEmail: parsed.fields.adminEmail,
        },
      };
    }

    case "create_user": {
      if (ctx.role !== "admin") return blocked("Only an organization's own admin can create users.");
      return {
        verdict: "admin_form",
        formAction: "create_user",
        prefill: {
          username: parsed.fields.username,
          role: isRole(parsed.fields.role) ? parsed.fields.role : "",
          firstName: parsed.fields.firstName,
          lastName: parsed.fields.lastName,
        },
      };
    }

    case "suspend_organization":
    case "reactivate_organization":
    case "delete_organization": {
      if (!ctx.isPlatformAdmin) return blocked("Only the platform's own admins can manage other organizations.");
      const orgs = await listOrganizations(ctx.pool);
      const match = resolveByName(orgs, (o) => o.name, parsed.targetName);
      if (match === "none") return blocked(`No organization matches "${parsed.targetName}".`);
      if (match === "ambiguous") return blocked(`"${parsed.targetName}" matches more than one organization — be more specific.`);
      const reason =
        parsed.action === "delete_organization"
          ? "Deleting an organization is permanent — this removes every device, asset, and user account that belongs to it."
          : parsed.action === "suspend_organization"
            ? "This immediately blocks every login and agent connection for this organization."
            : "Reactivating restores this organization's logins and agent connections.";
      return { verdict: "needs_confirmation", resolved: { action: parsed.action, orgId: match.id, orgName: match.name }, reason };
    }

    case "suspend_user":
    case "reactivate_user":
    case "delete_user": {
      if (ctx.role !== "admin") return blocked("Only an organization's own admin can manage its users.");
      const users = await listUsers(ctx.pool, ctx.orgId);
      const match = resolveByName(users, (u) => u.username, parsed.targetName);
      if (match === "none") return blocked(`No user matches "${parsed.targetName}" in your organization.`);
      if (match === "ambiguous") return blocked(`"${parsed.targetName}" matches more than one user — be more specific.`);
      if ((parsed.action === "suspend_user" || parsed.action === "delete_user") && match.role === "admin") {
        const remaining = await otherAdminCount(ctx.pool, ctx.orgId, match.id);
        if (remaining === 0) {
          return blocked(`Can't ${parsed.action === "delete_user" ? "delete" : "suspend"} "${match.username}" — they're the last remaining admin.`);
        }
      }
      const reason =
        parsed.action === "delete_user"
          ? "Deleting a user account is permanent."
          : parsed.action === "suspend_user"
            ? "This blocks their login immediately, including any session they already have open."
            : "Reactivating restores their ability to log in.";
      return {
        verdict: "needs_confirmation",
        resolved: { action: parsed.action, orgId: ctx.orgId, userId: match.id, username: match.username },
        reason,
      };
    }

    case "generate_installer": {
      let orgId = ctx.orgId;
      let orgMatch: { id: string; name: string; subdomain: string } | null = null;
      if (parsed.targetName.trim()) {
        if (!ctx.isPlatformAdmin) return blocked("Only the platform's own admins can generate an installer for another organization.");
        const orgs = await listOrganizations(ctx.pool);
        const match = resolveByName(orgs, (o) => o.name, parsed.targetName);
        if (match === "none") return blocked(`No organization matches "${parsed.targetName}".`);
        if (match === "ambiguous") return blocked(`"${parsed.targetName}" matches more than one organization — be more specific.`);
        orgMatch = match;
        orgId = match.id;
      } else {
        const orgs = await listOrganizations(ctx.pool);
        const own = orgs.find((o) => o.id === ctx.orgId);
        if (!own) return blocked("Could not resolve your own organization.");
        orgMatch = own;
      }
      return { verdict: "allowed", resolved: { action: "generate_installer", orgId, orgName: orgMatch.name, subdomain: orgMatch.subdomain } };
    }

    default: {
      const exhaustive: never = parsed.action;
      return blocked(`unhandled admin action: ${exhaustive}`);
    }
  }
}
