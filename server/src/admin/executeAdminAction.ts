// Confirm-time executor for admin actions resolved by security/adminGuardrail.ts
// — called from POST /api/command/:id/confirm once a human has reviewed and
// confirmed a suspend/reactivate/delete on an organization or user. Calls
// the real store functions directly (never registry.sendCommand/WS — there
// is no device involved in any of these), the exact same functions the
// dashboard's own Organizations/Users pages call, so an AI-console-
// triggered action is indistinguishable from a dashboard-triggered one in
// every downstream effect (DB state, audit trail, credential-cache reload).
// create_organization/create_user/generate_installer never reach here —
// the first two resolve to "admin_form" (a human completes the real form),
// the last resolves to "allowed" and is answered directly in routes.ts.
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
