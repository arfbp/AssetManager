// The admin-command counterpart to guardrail.ts — the choke point every
// parsed AdminParsedIntent passes through before it can touch an
// organization or a user account. Same trust posture as guardrail.ts:
// nothing here is authorization by itself, and every creation action opens
// an already-validated dashboard form for a human to review rather than
// executing blind (see the AI-console admin-commands plan's own design
// note on why). Permission checks mirror the REST routes exactly —
// *_organization actions need the same platform-admin boundary
// routes.ts's requirePlatformAdmin already enforces, *_user actions need
// the same org-admin boundary the /users routes already enforce — this is
// not a new policy, just the same one reachable from a second entry point.
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

// Only the tier of actions this file ever actually resolves to
// "needs_confirmation" — create_organization/create_user resolve to
// "admin_form" instead (a human completes the real dashboard form) and
// generate_installer resolves to "allowed" (nothing to confirm) — see
// evaluateAdminIntent below. Narrowed here (not just at the executor) so
// the whole chain from guardrail verdict to admin/executeAdminAction.ts
// stays exhaustively type-checked against exactly what can occur.
export type ConfirmableAdminAction = Exclude<ResolvedAdminAction, { action: "create_organization" | "create_user" | "generate_installer" }>;

export type AdminGuardrailVerdict =
  | { verdict: "blocked"; reason: string }
  | { verdict: "admin_form"; formAction: "create_organization" | "create_user"; prefill: Record<string, string> }
  | { verdict: "needs_confirmation"; resolved: ConfirmableAdminAction; reason: string }
  | { verdict: "allowed"; resolved: ResolvedAdminAction };

function blocked(reason: string): AdminGuardrailVerdict {
  return { verdict: "blocked", reason };
}

// Case-insensitive exact match first, then substring — same two-pass shape
// for both orgs and users below. Ambiguous (multiple substring matches) is
// treated as a failure, not a guess: the caller has to be more specific
// rather than the system silently picking one of several same-ish names.
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
