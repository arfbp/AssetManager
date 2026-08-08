// Dashboard-facing HTTP API: natural-language command submission, human
// confirmation for flagged actions, direct process control, AI remediation
// suggestions, and read-only fleet/history status.
//
// Pipeline for POST /api/command: parseNaturalLanguageCommand (LLM, untrusted
// parse of intent) -> evaluateParsedIntent (guardrail, the actual authority)
// -> either dispatch immediately, stash as a pending confirmation, or reject.
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { log, audit } from "../logger.js";
import type { Config } from "../config.js";
import type { AgentRegistry } from "../ws/registry.js";
import type { DeviceGroups } from "../groups/deviceGroups.js";
import type { CommandHistoryStore } from "../history/commandHistory.js";
import { dispatchToTargets } from "../ws/dispatch.js";
import { parseNaturalLanguageCommand, ParseRefusedError, ParseFailedError, RateLimitedError } from "../llm/actionParser.js";
import { suggestRemediation } from "../llm/remediationAdvisor.js";
import { analyzeDeviceForReplacement } from "../llm/deviceAnalysis.js";
import { answerDeviceQuery } from "../llm/queryAnswerer.js";
import { evaluateParsedIntent } from "../security/guardrail.js";
import { scanForBlacklistedContent } from "../security/blacklist.js";
import { loginRateLimiter, createOrgRateLimiter } from "../security/rateLimiter.js";
import { PendingActionStore } from "./pendingActions.js";
import { verifyCredentials, listUsers, createUser, updateUserRole, updateUserProfile, resetPassword, deleteUser, otherAdminCount, DuplicateUsernameError } from "../auth/users.js";
import { resolveOrgBySubdomain } from "../auth/orgResolver.js";
import { createSetupToken, consumeSetupToken } from "../auth/passwordSetup.js";
import { sendSetupLinkEmail } from "../notifications/channels/email.js";
import { createSession, deleteSession, validateSession, type Session } from "../auth/sessions.js";
import { requireRole } from "../auth/roles.js";
import { listAssets, listUnregisteredAgents, nextAssetTag, createAsset, updateAsset, deleteAsset } from "../assets/assetsStore.js";
import { listIncidents, listIncidentSummary } from "../incidents/incidentsStore.js";
import { listConnectionHistory } from "../assets/connectionHistoryStore.js";
import { lookupGeolocation } from "../geolocation/ipGeo.js";
import type { AgentBuildRegistry } from "../agentBuilds.js";
import { createOrganization, listOrganizations, getOrganizationCredentials, isValidSubdomain, DuplicateSubdomainError, PLATFORM_ORG_ID, setCustomDomain, DuplicateCustomDomainError, isValidCustomDomain } from "../orgs/orgsStore.js";
import type { OrgCredentialCache } from "../orgs/orgCredentials.js";
import { streamOrgInstallerZip } from "../orgs/installerGenerator.js";

const MASS_ACTION_THRESHOLD = 3;

// requestedBy is never taken from the request body — it's derived from the
// authenticated session (req.user.username) below. A client-supplied
// "who did this" field would be exactly the kind of unverified identity the
// login system exists to replace; see AuthedRequest / the auth middleware.
const CommandRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  // Optional device/group override from the dashboard's device selector —
  // when the operator has already picked a target device, trust that
  // instead of asking the LLM to also extract scope from free text. This
  // sidesteps an entire class of bugs this project hit repeatedly (the
  // model putting a device name in the wrong field, or misreading it
  // entirely) for the common case where the UI already knows the target.
  scope: z.string().min(1).max(200).optional(),
});

const KillProcessRequestSchema = z
  .object({
    pid: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
  })
  .refine((v) => v.pid !== undefined || v.name !== undefined, {
    message: "either pid or name is required",
  });

const RunScriptRequestSchema = z.object({
  script: z.string().min(1).max(32_768), // matches configs/agent.yaml's max_script_bytes
});

const SuggestRemediationRequestSchema = z.object({
  pid: z.number().int().positive(),
});

const LoginRequestSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const RoleEnum = z.enum(["admin", "it_support", "viewer"]);

const CreateUserRequestSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
  role: RoleEnum,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  // Optional — not every organization wants to store this, and it's not
  // needed for login (username/password already handle that).
  email: z.string().email().max(200).optional(),
});

const ResetOrgUserPasswordRequestSchema = z.object({
  password: z.string().min(8).max(200),
});

// adminPassword is optional — when omitted (the dashboard's default, see
// CreateOrgModal), the new admin gets a self-service setup link instead of
// the platform admin choosing a password and relaying it manually. Kept
// available for CLI/scripted org creation, where there's no natural way to
// deliver a setup link and the caller controls the account directly.
const CreateOrgRequestSchema = z.object({
  name: z.string().min(1).max(200),
  subdomain: z.string().min(1).max(63),
  adminUsername: z.string().min(1).max(100),
  adminPassword: z.string().min(8).max(200).optional(),
  adminFirstName: z.string().min(1).max(100),
  adminLastName: z.string().min(1).max(100),
  adminEmail: z.string().email().max(200).optional(),
});

const SetupPasswordRequestSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

// customDomain: null clears it, reverting the org to the shared
// subdomain-under-orgDomainSuffix pattern every other org uses.
const SetCustomDomainRequestSchema = z.object({
  customDomain: z.string().min(1).max(253).nullable(),
});

// Every field optional: PATCH /users/:id can change role alone, password
// alone, profile fields alone, or any combination in one call — never
// required to resend the whole record.
const UpdateUserRequestSchema = z.object({
  role: RoleEnum.optional(),
  password: z.string().min(8).max(200).optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  email: z.string().email().max(200).optional(),
});

const AssetStatusEnum = z.enum(["ready_to_deploy", "deployed", "in_repair", "retired"]);
const AssetTypeEnum = z.enum(["computer", "peripheral"]);

const CreateAssetSchema = z.object({
  assetTag: z.string().min(1).max(100).optional(),
  agentId: z.string().max(200).nullable().optional(),
  status: AssetStatusEnum.optional(),
  category: z.string().max(200).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  orderNumber: z.string().max(200).nullable().optional(),
  checkedOutTo: z.string().max(200).nullable().optional(),
  checkoutDate: z.string().max(30).nullable().optional(),
  expectedCheckinDate: z.string().max(30).nullable().optional(),
  eolDate: z.string().max(30).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  manualSerialNumber: z.string().max(200).nullable().optional(),
  assetType: AssetTypeEnum.optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  parentAgentId: z.string().max(200).nullable().optional(),
});

const UpdateAssetSchema = CreateAssetSchema.omit({ assetTag: true });

// Bulk import (Asset Registry's "Import" flow) — each row is validated with
// the exact same rules as a single manual "New asset" submission
// (CreateAssetSchema), just as an array. Capped at 1000 rows: generous for
// a real spreadsheet import, small enough that one request can't be used to
// hang the server processing an unbounded CSV.
const ImportAssetsRequestSchema = z.object({
  rows: z.array(CreateAssetSchema).min(1).max(1000),
});

interface AuthedRequest extends Request {
  user?: Session;
}

// Total bytes currently stored in an org's custom-installers subdirectory —
// used to enforce a per-org quota on POST /software-uploads (that route
// already caps a single file at 300MB, but nothing previously capped how
// many of those an org could accumulate; one org uploading enough installers
// could fill the VPS disk for every tenant). Missing directory (an org that
// has never uploaded anything) is treated as empty, not an error.
async function getDirSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      try {
        return (await stat(path.join(dir, entry))).size;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export function buildRouter(
  cfg: Config,
  registry: AgentRegistry,
  deviceGroups: DeviceGroups,
  history: CommandHistoryStore,
  pool: Pool,
  agentBuildRegistry: AgentBuildRegistry,
  orgCredentials: OrgCredentialCache,
): express.Router {
  const router = express.Router();
  const pending = new PendingActionStore();

  // Per-org limiters for routes that are expensive per-call (real $ cost,
  // or real CPU/disk/bandwidth work) — see security/rateLimiter.ts's doc
  // comment on why these key by orgId rather than IP.
  const commandRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 1000,
    limit: 30,
    message: "Too many commands dispatched. Try again in a minute.",
  });
  const installerRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: "Too many installer downloads. Try again later.",
  });
  const uploadRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: "Too many uploads. Try again later.",
  });
  const assetImportRateLimiter = createOrgRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    message: "Too many bulk imports. Try again later.",
  });

  router.use(express.json({ limit: "64kb" }));

  // POST /auth/login is the one route reachable without a session — you
  // can't present a token to get a token. Everything else requires a valid,
  // unexpired session row in Postgres (src/auth/sessions.ts); there is no
  // shared static fallback token anymore.
  router.post("/auth/login", loginRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = LoginRequestSchema.parse(req.body);
      // Sent by the frontend from window.location.hostname, not read off
      // this request's own Host — see orgResolver.ts's doc comment. Falls
      // back to "legacy" (the pre-multi-tenant fleet) so a client that
      // hasn't been updated yet, or is hitting the API directly by IP/
      // sslip.io hostname with no subdomain to parse, still resolves to the
      // one org that existed before this header existed.
      const orgSubdomain = (req.headers["x-org-subdomain"] as string | undefined)?.trim() || "legacy";
      const org = await resolveOrgBySubdomain(pool, orgSubdomain);
      if (!org) {
        // Deliberately the same generic message as a bad password — this
        // must not let a caller distinguish "wrong org" from "wrong
        // credentials" (org existence shouldn't be enumerable).
        audit.warn({ orgSubdomain, username: body.username }, "auth: login failed (unknown org)");
        res.status(401).json({ error: "invalid username or password" });
        return;
      }
      const user = await verifyCredentials(pool, org.id, body.username, body.password);
      if (!user) {
        audit.warn({ orgSubdomain, username: body.username }, "auth: login failed");
        res.status(401).json({ error: "invalid username or password" });
        return;
      }
      const token = await createSession(pool, user.id);
      audit.info({ orgSubdomain, username: user.username, role: user.role }, "auth: login succeeded");
      // Lets the frontend show the "Organizations" nav item only for the
      // platform owner's own admins — see orgsStore.ts's PLATFORM_ORG_ID.
      const isPlatformAdmin = user.role === "admin" && org.id === PLATFORM_ORG_ID;
      res.json({ token, username: user.username, role: user.role, isPlatformAdmin });
    } catch (err) {
      next(err);
    }
  });

  // Public — gated purely by possession of the one-time token, same as
  // login is gated by possession of a password. Lets a freshly created
  // org's admin set their own password from the setup link instead of a
  // platform admin choosing one and relaying it manually (see POST /orgs).
  router.post("/auth/setup-password", loginRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = SetupPasswordRequestSchema.parse(req.body);
      const ok = await consumeSetupToken(pool, body.token, body.password);
      if (!ok) {
        // Generic on purpose — don't distinguish "never existed" from
        // "expired" from "already used" to a caller who only has the token.
        res.status(400).json({ error: "This setup link is invalid or has expired." });
        return;
      }
      audit.info({}, "auth: password set via setup link");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.use(async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const session = await validateSession(pool, token);
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.user = session;
    next();
  });

  router.post("/auth/logout", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      await deleteSession(pool, req.user!.token);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/auth/me", (req: AuthedRequest, res: Response) => {
    const isPlatformAdmin = req.user!.role === "admin" && req.user!.orgId === PLATFORM_ORG_ID;
    res.json({ username: req.user!.username, role: req.user!.role, isPlatformAdmin });
  });

  // User account management — admin-only (see auth/roles.ts). Everything
  // here is a second, independent enforcement point on top of the client
  // simply hiding the Users nav item for non-admins: a non-admin session
  // calling these directly still gets a real 403.
  router.get("/users", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const users = await listUsers(pool, req.user!.orgId);
      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  router.post("/users", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateUserRequestSchema.parse(req.body);
      const user = await createUser(pool, req.user!.orgId, body.username, body.password, body.role, {
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email ?? null,
      });
      audit.info({ requestedBy: req.user!.username, username: user.username, role: user.role }, "users: created");
      res.status(201).json({ user });
    } catch (err) {
      if (err instanceof DuplicateUsernameError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.patch("/users/:id", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.orgId;
      const targetId = req.params.id ?? "";
      const body = UpdateUserRequestSchema.parse(req.body);

      // A role change that would leave zero admins is a real lockout (no
      // self-registration path exists to recover) — checked before writing,
      // not just left to the UI to prevent, since this endpoint is the
      // actual authority. otherAdminCount/listUsers are both org-scoped, so
      // a targetId belonging to a different org simply won't be found below
      // (404), never silently acted on.
      if (body.role && body.role !== "admin") {
        const remainingAdmins = await otherAdminCount(pool, orgId, targetId);
        const targetIsCurrentlyAdmin = (await listUsers(pool, orgId)).find((u) => u.id === targetId)?.role === "admin";
        if (targetIsCurrentlyAdmin && remainingAdmins === 0) {
          res.status(409).json({ error: "Can't change this account's role — it's the last remaining admin." });
          return;
        }
      }

      if (body.role) await updateUserRole(pool, orgId, targetId, body.role);
      if (body.password) await resetPassword(pool, orgId, targetId, body.password);
      if (body.firstName !== undefined || body.lastName !== undefined || body.email !== undefined) {
        await updateUserProfile(pool, orgId, targetId, { firstName: body.firstName, lastName: body.lastName, email: body.email });
      }
      audit.info({ requestedBy: req.user!.username, targetId, roleChanged: Boolean(body.role), passwordReset: Boolean(body.password) }, "users: updated");
      const users = await listUsers(pool, orgId);
      const updated = users.find((u) => u.id === targetId);
      if (!updated) {
        res.status(404).json({ error: "user not found" });
        return;
      }
      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/users/:id", requireRole("admin"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.orgId;
      const targetId = req.params.id ?? "";
      if (targetId === req.user!.userId) {
        res.status(409).json({ error: "You can't delete your own account." });
        return;
      }
      const target = (await listUsers(pool, orgId)).find((u) => u.id === targetId);
      if (!target) {
        res.status(404).json({ error: "user not found" });
        return;
      }
      if (target.role === "admin" && (await otherAdminCount(pool, orgId, targetId)) === 0) {
        res.status(409).json({ error: "Can't delete the last remaining admin account." });
        return;
      }
      await deleteUser(pool, orgId, targetId);
      audit.info({ requestedBy: req.user!.username, targetId, targetUsername: target.username }, "users: deleted");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Organization (tenant) management — deliberately NOT gated by the normal
  // requireRole("admin") alone, since that would let any org's own admin
  // create or enumerate every other org on this deployment. Gated to admins
  // of the platform-owner org specifically (see orgsStore.ts's
  // PLATFORM_ORG_ID) — today that's exactly one person, the operator of
  // this whole install, not a capability any customer org's admin has.
  function requirePlatformAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
    if (req.user!.role !== "admin" || req.user!.orgId !== PLATFORM_ORG_ID) {
      res.status(403).json({ error: "Your account does not have permission to manage organizations." });
      return;
    }
    next();
  }

  router.get("/orgs", requirePlatformAdmin, async (_req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgs = await listOrganizations(pool);
      res.json({ orgs });
    } catch (err) {
      next(err);
    }
  });

  router.post("/orgs", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateOrgRequestSchema.parse(req.body);
      const subdomain = body.subdomain.trim().toLowerCase();
      if (!isValidSubdomain(subdomain)) {
        res.status(422).json({ error: "Subdomain must be lowercase letters, digits, or hyphens, and can't start or end with a hyphen." });
        return;
      }

      const created = await createOrganization(pool, body.name, subdomain);
      // The new org's agent credentials only exist in Postgres until this
      // in-memory cache reloads — without it, an agent installed with the
      // freshly generated token would be rejected by verifyClient until the
      // next server restart, since ws/server.ts never re-queries Postgres
      // per-connection (see orgCredentials.ts's own doc comment on why it's
      // cached at all).
      await orgCredentials.reload(pool);

      // No adminPassword supplied (the dashboard's default) → generate one
      // that's never surfaced anywhere and mint a self-service setup link
      // instead, so the real password is chosen by the customer, not typed
      // by the platform admin and relayed over chat/email. Supplying
      // adminPassword explicitly (CLI/scripted org creation) skips all of
      // this and behaves exactly as before.
      const usesSetupLink = !body.adminPassword;
      const adminPassword = body.adminPassword ?? randomBytes(32).toString("hex");
      const firstAdmin = await createUser(pool, created.org.id, body.adminUsername, adminPassword, "admin", {
        firstName: body.adminFirstName,
        lastName: body.adminLastName,
        email: body.adminEmail ?? null,
      });

      let setupLink: string | null = null;
      let setupLinkEmailed = false;
      if (usesSetupLink) {
        const token = await createSetupToken(pool, firstAdmin.id);
        const base = cfg.http.orgDomainSuffix ? `https://${subdomain}${cfg.http.orgDomainSuffix}` : cfg.http.dashboardOrigins[0];
        setupLink = `${base}/setup-password?token=${token}`;
        if (cfg.notifications.email && body.adminEmail) {
          try {
            await sendSetupLinkEmail(cfg.notifications.email, body.adminEmail, created.org.name, setupLink);
            setupLinkEmailed = true;
          } catch (err) {
            // Not fatal — the org and admin account both exist and the
            // link is still returned below for the platform admin to relay
            // manually, so an SMTP hiccup here shouldn't look like the
            // whole org-creation request failed.
            audit.warn({ err, orgId: created.org.id }, "orgs: setup link email failed to send");
          }
        }
      }

      audit.info(
        { requestedBy: req.user!.username, orgId: created.org.id, subdomain, adminUsername: firstAdmin.username, usesSetupLink },
        "orgs: created",
      );
      res.status(201).json({
        org: created.org,
        agentAuthToken: created.agentAuthToken,
        agentHmacSecret: created.agentHmacSecret,
        admin: firstAdmin,
        setupLink,
        setupLinkEmailed,
      });
    } catch (err) {
      if (err instanceof DuplicateSubdomainError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof DuplicateUsernameError) {
        // The org itself was already created and committed above — a
        // colliding admin username here is real but narrow (this org has no
        // usable admin account yet), so it's reported distinctly rather
        // than looking like the whole org creation failed.
        res.status(409).json({ error: `Organization created, but ${err.message}. Add its first admin from the Users page instead.` });
        return;
      }
      next(err);
    }
  });

  // Generates and streams a ready-to-run installer .zip for this org,
  // rebuilt fresh on every request — always ships whatever agent build is
  // currently active (agentBuildRegistry.getActive()), never a stale copy,
  // and re-reads this org's credentials from Postgres rather than requiring
  // the caller to have copied them down earlier (see orgsStore.ts's
  // getOrganizationCredentials doc comment on why that's safe to re-serve).
  router.get("/orgs/:id/installer", requirePlatformAdmin, installerRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      const found = await getOrganizationCredentials(pool, orgId);
      if (!found) {
        res.status(404).json({ error: "organization not found" });
        return;
      }
      const active = agentBuildRegistry.getActive();
      if (!active) {
        res.status(409).json({ error: "No agent build has been uploaded yet (see Agent Updates) — nothing to package." });
        return;
      }
      audit.info({ requestedBy: req.user!.username, orgId, subdomain: found.org.subdomain }, "orgs: installer generated");
      streamOrgInstallerZip(res, { templateDir: cfg.agentInstallerTemplateDir, agentExePath: active.exePath }, found.org.subdomain, found.agentAuthToken, found.agentHmacSecret);
    } catch (err) {
      next(err);
    }
  });

  // Support tooling for exactly the "a customer's own admin forgot their
  // password and it's the only account in that org, so they can't log in
  // to use the normal self-service reset on the Users page at all" case —
  // the platform admin's own org-scoped session can't reach another org's
  // users through the regular /users routes (req.user.orgId gates those),
  // so this pair exists as a deliberate, explicitly platform-admin-gated
  // exception. listUsers/resetPassword (auth/users.ts) already take an
  // explicit orgId param rather than assuming the caller's own — reused
  // as-is here, just supplied the URL's :id instead of req.user!.orgId.
  router.get("/orgs/:id/users", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const users = await listUsers(pool, req.params.id ?? "");
      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/orgs/:id/users/:userId/reset-password",
    requirePlatformAdmin,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const orgId = req.params.id ?? "";
        const userId = req.params.userId ?? "";
        const body = ResetOrgUserPasswordRequestSchema.parse(req.body);
        await resetPassword(pool, orgId, userId, body.password);
        audit.info({ requestedBy: req.user!.username, orgId, targetUserId: userId }, "orgs: user password reset by platform admin");
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  // For the "setup link expired before the customer used it" case — mints
  // a fresh token (the old one, if any, is simply left to expire; it's
  // already single-use so it can't be replayed) and returns/re-sends it,
  // same shape as POST /orgs's original setup-link response.
  router.post(
    "/orgs/:id/users/:userId/resend-invite",
    requirePlatformAdmin,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const orgId = req.params.id ?? "";
        const userId = req.params.userId ?? "";
        const { rows } = await pool.query<{ email: string | null; org_name: string; subdomain: string }>(
          `SELECT u.email, o.name AS org_name, o.subdomain
           FROM users u JOIN organizations o ON o.id = u.org_id
           WHERE u.id = $1 AND u.org_id = $2`,
          [userId, orgId],
        );
        const row = rows[0];
        if (!row) {
          res.status(404).json({ error: "user not found" });
          return;
        }

        const token = await createSetupToken(pool, userId);
        const base = cfg.http.orgDomainSuffix ? `https://${row.subdomain}${cfg.http.orgDomainSuffix}` : cfg.http.dashboardOrigins[0];
        const setupLink = `${base}/setup-password?token=${token}`;

        let setupLinkEmailed = false;
        if (cfg.notifications.email && row.email) {
          try {
            await sendSetupLinkEmail(cfg.notifications.email, row.email, row.org_name, setupLink);
            setupLinkEmailed = true;
          } catch (err) {
            audit.warn({ err, orgId, targetUserId: userId }, "orgs: resend-invite email failed to send");
          }
        }

        audit.info({ requestedBy: req.user!.username, orgId, targetUserId: userId }, "orgs: setup link resent by platform admin");
        res.json({ setupLink, setupLinkEmailed });
      } catch (err) {
        next(err);
      }
    },
  );

  // Lets a single org be reached at its own fully-owned domain (e.g.
  // assets.360qm.co.th) instead of the shared subdomain-under-
  // orgDomainSuffix pattern — see migrations/0007 and orgResolver.ts. Must
  // reload orgCredentials afterward (same as org creation above) so the
  // CORS check and login resolution pick up the change without a restart.
  router.post("/orgs/:id/custom-domain", requirePlatformAdmin, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.id ?? "";
      const body = SetCustomDomainRequestSchema.parse(req.body);
      const domain = body.customDomain ? body.customDomain.trim().toLowerCase() : null;
      if (domain && !isValidCustomDomain(domain)) {
        res.status(422).json({ error: "Custom domain must be a valid hostname (e.g. assets.example.com)." });
        return;
      }
      const org = await setCustomDomain(pool, orgId, domain);
      await orgCredentials.reload(pool);
      audit.info({ requestedBy: req.user!.username, orgId, customDomain: domain }, "orgs: custom domain updated");
      res.json({ org });
    } catch (err) {
      if (err instanceof DuplicateCustomDomainError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/agents", (req: AuthedRequest, res: Response) => {
    res.json({ agents: registry.listAll().filter((a) => a.orgId === req.user!.orgId) });
  });

  router.get("/agents/:id/telemetry", (req: AuthedRequest, res: Response) => {
    const agentId = req.params.id ?? "";
    const snapshot = registry.getTelemetry(req.user!.orgId, agentId);
    if (!snapshot) {
      res.status(404).json({ error: "no telemetry available (agent offline or hasn't reported yet)" });
      return;
    }
    res.json({ snapshot });
  });

  // Historical CPU/RAM/Disk trend for one device, backing the dashboard's
  // history chart. Reads telemetry_snapshots directly (durable, unlike
  // AgentRegistry's in-memory "last known" state) — this is the reason that
  // table exists rather than just overwriting a single row per agent.
  // Capped at 2000 points regardless of range: no time-bucketed downsampling
  // yet, so a long range with the agent in alert mode (10s interval) can hit
  // the cap before the full window is covered — good enough for spotting a
  // trend, not a substitute for querying Postgres directly for finer detail.
  router.get("/agents/:id/history", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const hours = Math.min(Math.max(Number(req.query.hours ?? 6) || 6, 1), 168);

      // A plain "ORDER BY recorded_at ASC LIMIT 2000" silently truncates to
      // whichever 2000 rows are oldest in the window — during a sustained
      // alert-mode burst (polling drops to every 10s while CPU/mem stays
      // over threshold), that alone can produce thousands of rows within a
      // single day, exhausting the cap before the query ever reaches later
      // days. Verified: a 7-day request came back showing only one day's
      // worth of (very densely packed) points, never the other six. Fixed
      // by bucketing the requested range into a fixed number of evenly
      // spaced windows and taking one (the latest) sample per bucket, so
      // coverage always spans the full requested range regardless of how
      // unevenly the underlying polling interval made the raw data.
      const targetPoints = 500;
      const bucketSeconds = Math.max(1, Math.ceil((hours * 3600) / targetPoints));

      const { rows } = await pool.query<{
        recorded_at: Date;
        cpu_percent: number;
        mem_percent: number;
        disks: { mount_point: string; used_percent: number; free_gb: number; total_gb: number }[] | null;
      }>(
        `WITH bucketed AS (
           SELECT
             recorded_at, cpu_percent, mem_percent, snapshot->'disks' AS disks,
             date_bin(($3 || ' seconds')::interval, recorded_at, TIMESTAMPTZ '2000-01-01') AS bucket
           FROM telemetry_snapshots
           WHERE org_id = $4 AND agent_id = $1 AND recorded_at > now() - (interval '1 hour' * $2::double precision)
         )
         SELECT recorded_at, cpu_percent, mem_percent, disks
         FROM (
           SELECT DISTINCT ON (bucket) recorded_at, cpu_percent, mem_percent, disks, bucket
           FROM bucketed
           ORDER BY bucket, recorded_at DESC
         ) sampled
         ORDER BY recorded_at ASC`,
        [agentId, hours, bucketSeconds, req.user!.orgId],
      );
      res.json({
        points: rows.map((r) => ({
          recordedAt: r.recorded_at,
          cpuPercent: r.cpu_percent,
          memPercent: r.mem_percent,
          disks: r.disks ?? [],
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // Assembles a device's recent resource-usage/reliability summary and asks
  // the LLM for a plain-language replacement recommendation — see
  // llm/deviceAnalysis.ts for why this reasons from usage patterns rather
  // than a hardware age this system has no way to know.
  router.get("/agents/:id/report", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const windowDays = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 30);
      const orgId = req.user!.orgId;

      const snapshot = registry.getTelemetry(orgId, agentId);
      if (!snapshot) {
        res.status(404).json({ error: "No telemetry available for this device yet." });
        return;
      }

      const { rows: statRows } = await pool.query<{
        avg_cpu: number | null;
        max_cpu: number | null;
        avg_mem: number | null;
        max_mem: number | null;
        sample_count: string;
      }>(
        `SELECT AVG(cpu_percent) AS avg_cpu, MAX(cpu_percent) AS max_cpu,
                AVG(mem_percent) AS avg_mem, MAX(mem_percent) AS max_mem,
                COUNT(*) AS sample_count
         FROM telemetry_snapshots
         WHERE org_id = $3 AND agent_id = $1 AND recorded_at > now() - (interval '1 day' * $2::double precision)`,
        [agentId, windowDays, orgId],
      );
      const stats = statRows[0];

      const { rows: diskRows } = await pool.query<{ worst_disk: number | null }>(
        `SELECT MAX((d->>'used_percent')::double precision) AS worst_disk
         FROM telemetry_snapshots, jsonb_array_elements(snapshot->'disks') AS d
         WHERE org_id = $3 AND agent_id = $1 AND recorded_at > now() - (interval '1 day' * $2::double precision)`,
        [agentId, windowDays, orgId],
      );

      const { rows: incidentRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM device_incidents
         WHERE org_id = $3 AND agent_id = $1 AND kind = 'process_not_responding' AND occurred_at > now() - (interval '1 day' * $2::double precision)`,
        [agentId, windowDays, orgId],
      );

      const report = {
        deviceId: agentId,
        model: snapshot.model || null,
        manufacturer: snapshot.manufacturer || null,
        osVersion: snapshot.os_version || null,
        uptimeSeconds: snapshot.uptime_seconds,
        windowDays,
        avgCpuPercent: stats?.avg_cpu ?? 0,
        maxCpuPercent: stats?.max_cpu ?? 0,
        avgMemPercent: stats?.avg_mem ?? 0,
        maxMemPercent: stats?.max_mem ?? 0,
        worstDiskUsedPercent: diskRows[0]?.worst_disk ?? null,
        incidentCount: Number(incidentRows[0]?.count ?? 0),
        sampleCount: Number(stats?.sample_count ?? 0),
      };

      const analysis = await analyzeDeviceForReplacement(report);
      res.json({ report, analysis });
    } catch (err) {
      next(err);
    }
  });

  router.get("/agents/:id/incidents", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const incidents = await listIncidents(pool, req.user!.orgId, agentId);
      res.json({ incidents });
    } catch (err) {
      next(err);
    }
  });

  // Fleet-wide "devices with the most issues" ranking for the Dashboard —
  // see listIncidentSummary's own comment for why this is a plain incident
  // count, never an LLM call per device.
  router.get("/fleet/incident-summary", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 90);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 10) || 10, 1), 50);
      const devices = await listIncidentSummary(pool, req.user!.orgId, days, limit);
      res.json({ days, devices });
    } catch (err) {
      next(err);
    }
  });

  // "Live Tracking" map data — each known agent's approximate location via
  // IP geolocation (see geolocation/ipGeo.ts for why this is IP-based, not
  // real GPS, and its accuracy/privacy-IP caveats). Deduplicates lookups by
  // IP first since multiple agents on the same office network share one
  // address — no reason to look the same IP up twice in one request.
  router.get("/fleet/locations", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agents = registry.listAll().filter((a) => a.orgId === req.user!.orgId);
      const geoByIp = new Map<string, Awaited<ReturnType<typeof lookupGeolocation>>>();

      // Prefer the agent's own self-reported public IP (telemetry's
      // public_ip, an external lookup from the agent's own network
      // position — see internal/telemetry/publicip.go) over remoteIp (what
      // this server's WebSocket connection sees, which is only the real
      // public address if this server itself lives on the internet rather
      // than the same LAN as the agent — for an on-prem/LAN deployment
      // that's just another private address). Fall back to remoteIp only
      // when the agent hasn't reported a public IP yet (e.g. right after
      // connecting, before its background lookup completes).
      const ipFor = (agent: (typeof agents)[number]): string | null => agent.lastTelemetry?.public_ip || agent.remoteIp;

      for (const agent of agents) {
        const ip = ipFor(agent);
        if (!ip || geoByIp.has(ip)) continue;
        geoByIp.set(ip, await lookupGeolocation(pool, ip));
      }

      const devices = agents.map((agent) => {
        const ip = ipFor(agent);
        const geo = ip ? geoByIp.get(ip) : undefined;
        return {
          agentId: agent.agentId,
          status: agent.status,
          remoteIp: ip,
          isPrivate: geo?.isPrivate ?? null,
          city: geo?.city ?? null,
          region: geo?.region ?? null,
          country: geo?.country ?? null,
          lat: geo?.lat ?? null,
          lon: geo?.lon ?? null,
          isp: geo?.isp ?? null,
          asn: geo?.asn ?? null,
          zip: geo?.zip ?? null,
          timezone: geo?.timezone ?? null,
        };
      });
      res.json({ devices });
    } catch (err) {
      next(err);
    }
  });

  router.get("/command-history", (req: AuthedRequest, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    // history.recent() itself stays org-agnostic (same reasoning as
    // AgentRegistry.listAll()) — filter to this caller's own org here,
    // taking the max the store holds before slicing to `limit` so a busy
    // fleet's most recent org-scoped entries aren't crowded out by other
    // orgs' entries occupying the front of the shared ring buffer.
    const entries = history.recent(500).filter((e) => e.orgId === req.user!.orgId).slice(0, limit);
    res.json({ entries });
  });

  // Asset registry — inventory/procurement metadata (location, checked out
  // to, order number, EOL date, ...) an operator enters by hand, joined
  // read-only against whatever the linked agent already reports
  // automatically (serial/model/manufacturer/live status). See
  // src/assets/assetsStore.ts.
  router.get("/assets", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const [assets, unregisteredAgents] = await Promise.all([
        listAssets(pool, req.user!.orgId),
        listUnregisteredAgents(pool, req.user!.orgId),
      ]);
      res.json({ assets, unregisteredAgents });
    } catch (err) {
      next(err);
    }
  });

  router.post("/assets", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CreateAssetSchema.parse(req.body);
      const assetTag = body.assetTag || (await nextAssetTag(pool, req.user!.orgId));
      const asset = await createAsset(pool, req.user!.orgId, assetTag, body);
      audit.info({ assetTag, requestedBy: req.user!.username }, "assets: created");
      res.status(201).json({ asset });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "That asset tag or linked device is already registered to another asset." });
        return;
      }
      next(err);
    }
  });

  // Bulk import — the frontend parses/previews the CSV client-side and only
  // calls this once the operator has actually reviewed it and clicked
  // "Confirm import" (see ImportAssetsModal.tsx); this endpoint never sees
  // the raw file, just already-parsed rows shaped like a normal asset. Rows
  // are applied one at a time, in order, rather than in a single
  // transaction — a spreadsheet with 40 good rows and 3 typos should still
  // import the 40, with the 3 reported back individually, not roll
  // everything back over a handful of bad rows. Sequential (not
  // Promise.all) specifically so nextAssetTag()'s "count current rows,
  // return count+1" logic can't hand out the same generated tag to two rows
  // in the same request.
  router.post("/assets/import", requireRole("admin", "it_support"), assetImportRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = ImportAssetsRequestSchema.parse(req.body);
      const results: { index: number; assetTag: string; action: "created" | "updated" | "failed"; error?: string }[] = [];

      for (let i = 0; i < body.rows.length; i++) {
        const row = body.rows[i]!;
        try {
          if (row.assetTag) {
            const updated = await updateAsset(pool, req.user!.orgId, row.assetTag, row);
            if (updated) {
              results.push({ index: i, assetTag: row.assetTag, action: "updated" });
              continue;
            }
            // Tag given but doesn't exist yet — create it with that exact
            // tag (an operator importing their own existing asset-tag
            // scheme expects those tags to be used verbatim, not replaced
            // with an auto-generated one).
            const created = await createAsset(pool, req.user!.orgId, row.assetTag, row);
            results.push({ index: i, assetTag: created.assetTag, action: "created" });
          } else {
            const assetTag = await nextAssetTag(pool, req.user!.orgId);
            const created = await createAsset(pool, req.user!.orgId, assetTag, row);
            results.push({ index: i, assetTag: created.assetTag, action: "created" });
          }
        } catch (err) {
          const message =
            err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505"
              ? "Asset tag or linked device already registered to another asset."
              : err instanceof Error
                ? err.message
                : "Unknown error";
          results.push({ index: i, assetTag: row.assetTag ?? "", action: "failed", error: message });
        }
      }

      const summary = {
        created: results.filter((r) => r.action === "created").length,
        updated: results.filter((r) => r.action === "updated").length,
        failed: results.filter((r) => r.action === "failed").length,
      };
      audit.info({ requestedBy: req.user!.username, ...summary }, "assets: bulk import");
      res.json({ results, summary });
    } catch (err) {
      next(err);
    }
  });

  router.get("/assets/:assetTag/connection-history", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = req.params.assetTag ?? "";
      const entries = await listConnectionHistory(pool, req.user!.orgId, assetTag);
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  router.put("/assets/:assetTag", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = req.params.assetTag ?? "";
      const body = UpdateAssetSchema.parse(req.body);
      const asset = await updateAsset(pool, req.user!.orgId, assetTag, body);
      if (!asset) {
        res.status(404).json({ error: "asset not found" });
        return;
      }
      audit.info({ assetTag, requestedBy: req.user!.username }, "assets: updated");
      res.json({ asset });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "That linked device is already registered to another asset." });
        return;
      }
      next(err);
    }
  });

  router.delete("/assets/:assetTag", requireRole("admin", "it_support"), async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const assetTag = req.params.assetTag ?? "";
      const deleted = await deleteAsset(pool, req.user!.orgId, assetTag);
      if (!deleted) {
        res.status(404).json({ error: "asset not found" });
        return;
      }
      audit.info({ assetTag, requestedBy: req.user!.username }, "assets: deleted");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/command", commandRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = CommandRequestSchema.parse(req.body);
      const requestedBy = req.user!.username;

      let parsed;
      try {
        parsed = await parseNaturalLanguageCommand(body.text, deviceGroups.listScopes(req.user!.orgId), body.scope);
      } catch (err) {
        if (err instanceof ParseRefusedError) {
          audit.warn({ requestedBy, text: body.text, category: err.category }, "command: LLM refused to parse request");
          res.status(422).json({ error: "Request could not be processed by the language model's safety filters." });
          return;
        }
        if (err instanceof ParseFailedError) {
          audit.warn({ requestedBy, text: body.text }, "command: LLM produced an invalid tool call");
          res.status(422).json({ error: "Could not confidently map this request to a supported action — try rephrasing it more simply." });
          return;
        }
        if (err instanceof RateLimitedError) {
          audit.warn({ requestedBy, text: body.text, retryAfterSeconds: err.retryAfterSeconds }, "command: LLM provider rate-limited this request");
          if (err.retryAfterSeconds !== null) res.set("Retry-After", String(err.retryAfterSeconds));
          res.status(429).json({
            error: err.retryAfterSeconds !== null
              ? `The AI is temporarily out of requests for today — try again in about ${Math.ceil(err.retryAfterSeconds / 60)} minute(s).`
              : "The AI is temporarily out of requests for today — try again later.",
          });
          return;
        }
        throw err;
      }

      // The operator picked a specific device in the UI — that's a stronger
      // signal than anything the model extracted from free text, so it wins
      // outright rather than being "one more vote" alongside the model's guess.
      if (body.scope) {
        parsed = { ...parsed, scope: body.scope };
      }

      // query_info never dispatches anything, so it never goes near the
      // guardrail — evaluateParsedIntent's whole job is deciding whether to
      // dispatch a CommandAction, which a pure read doesn't have. Scope
      // resolution still applies (an unknown device is still unknown), and
      // it always requires exactly one device: answering a shared "what's
      // your IP" across a whole group isn't a single sentence.
      if (parsed.action === "query_info") {
        const targets = deviceGroups.resolve(req.user!.orgId, parsed.scope);
        if (targets.length === 0) {
          audit.warn({ requestedBy, text: body.text, scope: parsed.scope }, "query_info: unknown scope");
          res.status(422).json({
            error: `Unknown device/group scope "${parsed.scope}". Known scopes: ${deviceGroups.listScopes(req.user!.orgId).join(", ")}`,
            parsed,
          });
          return;
        }
        if (targets.length > 1) {
          res.status(422).json({
            error: "query_info only answers about one device at a time — name a specific device, not a group.",
            parsed,
          });
          return;
        }
        const agentId = targets[0]!;
        const snapshot = registry.getTelemetry(req.user!.orgId, agentId);
        if (!snapshot) {
          res.status(404).json({ error: `No telemetry available for ${agentId} yet (offline, or hasn't reported since it connected).` });
          return;
        }
        const result = await answerDeviceQuery({ deviceId: agentId, question: body.text, topicHint: parsed.target, snapshot });
        audit.info({ requestedBy, agentId, question: body.text, result }, "query_info: answered");
        res.json({ status: "answered", agentId, answerable: result.answerable, answer: result.answer, reasoning: parsed.reasoning });
        return;
      }

      // The model couldn't confidently map this to a specific supported
      // action — rather than dead-ending on "sorry, I don't understand",
      // fall back to the same live-data answering path query_info uses,
      // as long as exactly one real device is identifiable and reporting.
      // The operator still gets *something* useful (the device's actual
      // current state) instead of nothing, even though the request itself
      // was too ambiguous/malformed to execute as a specific command.
      // Destructive actions are never at risk here: this only ever
      // produces a read-only answer, the same as query_info — it can't
      // fall through into dispatching anything.
      if (parsed.action === "unsupported") {
        const fallbackTargets = deviceGroups.resolve(req.user!.orgId, parsed.scope);
        if (fallbackTargets.length === 1) {
          const agentId = fallbackTargets[0]!;
          const snapshot = registry.getTelemetry(req.user!.orgId, agentId);
          if (snapshot) {
            const result = await answerDeviceQuery({
              deviceId: agentId,
              question: body.text,
              topicHint: parsed.target || parsed.reasoning,
              snapshot,
            });
            audit.info({ requestedBy, agentId, question: body.text, result }, "command: unsupported action, fell back to live device data");
            res.json({
              status: "answered",
              agentId,
              answerable: result.answerable,
              answer: result.answer,
              reasoning: parsed.reasoning,
              fallback: true,
            });
            return;
          }
        }
      }

      // Everything above this point (query_info, the unsupported→read-only
      // fallback) is read-only and stays open to every role. Anything that
      // reaches here is a real dispatchable action, which a 'viewer' can
      // never execute — checked here rather than with requireRole on the
      // whole route, since that would also block a viewer's read-only
      // questions, which this same endpoint handles.
      if (req.user!.role === "viewer") {
        audit.warn({ requestedBy, text: body.text, action: parsed.action }, "command: blocked, viewer role cannot dispatch");
        res.status(403).json({ error: "Your account is read-only and cannot dispatch commands." });
        return;
      }

      const verdict = evaluateParsedIntent(parsed, {
        orgId: req.user!.orgId,
        deviceGroups,
        enableRunScriptDispatch: cfg.enableRunScriptDispatch,
        massActionThreshold: MASS_ACTION_THRESHOLD,
      });

      if (verdict.verdict === "blocked") {
        res.status(422).json({ error: verdict.reason, parsed });
        return;
      }

      if (verdict.verdict === "needs_confirmation") {
        const action = pending.create({
          resolved: verdict.resolved,
          targets: verdict.targets,
          reason: verdict.reason,
          requestedBy,
          originalText: body.text,
        });
        res.status(202).json({
          status: "needs_confirmation",
          pendingId: action.id,
          reason: verdict.reason,
          resolved: verdict.resolved,
          targets: verdict.targets,
          expiresInSeconds: 300,
          reasoning: parsed.reasoning,
        });
        return;
      }

      const hmacSecret = orgCredentials.resolveByOrgId(req.user!.orgId);
      if (!hmacSecret) {
        res.status(500).json({ error: "organization is missing agent credentials" });
        return;
      }
      const results = dispatchToTargets(req.user!.orgId, verdict.resolved, verdict.targets, registry, history, hmacSecret, requestedBy, body.text);
      res.status(200).json({ status: "dispatched", resolved: verdict.resolved, results, reasoning: parsed.reasoning });
    } catch (err) {
      next(err);
    }
  });

  router.post("/command/:id/confirm", requireRole("admin", "it_support"), (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const confirmedBy = req.user!.username;
      const pendingId = req.params.id ?? "";
      const action = pending.take(pendingId);
      if (!action) {
        res.status(404).json({ error: "pending action not found — it may have expired (5 min TTL) or already been confirmed." });
        return;
      }

      audit.info(
        { pendingId, originalRequestedBy: action.requestedBy, confirmedBy, resolved: action.resolved, targets: action.targets },
        "command: human confirmed pending action, dispatching",
      );

      const hmacSecret = orgCredentials.resolveByOrgId(req.user!.orgId);
      if (!hmacSecret) {
        res.status(500).json({ error: "organization is missing agent credentials" });
        return;
      }
      const results = dispatchToTargets(req.user!.orgId, action.resolved, action.targets, registry, history, hmacSecret, confirmedBy, action.originalText);
      res.status(200).json({ status: "dispatched", resolved: action.resolved, results });
    } catch (err) {
      next(err);
    }
  });

  // Direct process control for the Task Manager UI's "Force Close" button —
  // deliberately bypasses the LLM (the UI already knows exactly what it
  // wants) but still goes through the same signed-dispatch path as every
  // other command, so it's audited and history-logged identically.
  router.post("/agents/:id/kill-process", requireRole("admin", "it_support"), (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const body = KillProcessRequestSchema.parse(req.body);
      const params = body.pid !== undefined ? { pid: String(body.pid) } : { name: body.name! };

      const hmacSecret = orgCredentials.resolveByOrgId(req.user!.orgId);
      if (!hmacSecret) {
        res.status(500).json({ error: "organization is missing agent credentials" });
        return;
      }
      const results = dispatchToTargets(
        req.user!.orgId,
        { action: "kill_process", params },
        [agentId],
        registry,
        history,
        hmacSecret,
        req.user!.username,
      );
      res.status(200).json({ status: "dispatched", results });
    } catch (err) {
      next(err);
    }
  });

  // The one explicit, human-reviewed run_script dispatch path guardrail.ts's
  // resolveAction refers to when it blocks run_script from ever being
  // inferred by the LLM parser (see that file's "run_script cannot be
  // dispatched from a natural-language request" comment) — the script body
  // comes verbatim from an authenticated admin's own request, never from
  // free text a model interpreted. Still gated on the same
  // OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH server flag the NL path checks
  // (so flipping that flag off takes this path down too), still scanned by
  // the same blacklist tripwire the vetted uninstall templates go through,
  // and admin-only rather than admin+it_support — this is the single
  // highest-risk action the fleet can dispatch (arbitrary SYSTEM/root
  // script), and still ultimately requires the target agent's own local
  // run_script allowlist entry + OPTIFLEET_ENABLE_RUN_SCRIPT env var, which
  // is a separate opt-in per internal/config/config.go's validate().
  router.post("/agents/:id/run-script", requireRole("admin"), (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      if (!cfg.enableRunScriptDispatch) {
        res.status(403).json({ error: "run_script dispatch is disabled on this server (OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH)." });
        return;
      }
      const agentId = req.params.id ?? "";
      const body = RunScriptRequestSchema.parse(req.body);

      const hit = scanForBlacklistedContent(body.script);
      if (hit) {
        audit.warn({ agentId, requestedBy: req.user!.username, reason: hit.reason }, "run-script: blocked by blacklist tripwire");
        res.status(422).json({ error: `Script blocked: matches a known-destructive pattern (${hit.reason}).` });
        return;
      }

      const hmacSecret = orgCredentials.resolveByOrgId(req.user!.orgId);
      if (!hmacSecret) {
        res.status(500).json({ error: "organization is missing agent credentials" });
        return;
      }
      const results = dispatchToTargets(
        req.user!.orgId,
        { action: "run_script", params: { script: body.script } },
        [agentId],
        registry,
        history,
        hmacSecret,
        req.user!.username,
      );
      audit.info({ agentId, requestedBy: req.user!.username }, "run-script: dispatched");
      res.status(200).json({ status: "dispatched", results });
    } catch (err) {
      next(err);
    }
  });

  // Backs the Software Deploy page's "upload your own installer" path — an
  // admin-supplied .exe/.msi the operator wants pushed to a device, as
  // opposed to a Ninite silent-install URL. Stored under
  // cfg.customInstallersDir with a random id prefix (never the client's
  // literal path, and stripped to a basename) so nothing here can write
  // outside that directory. The uploaded id is only useful paired with the
  // run-script endpoint above — this route alone doesn't install anything.
  // express.raw() (not the router-wide express.json()) is scoped to just
  // this one route: a multi-hundred-MB installer binary is not JSON, and
  // giving every other route this same body-size ceiling would be an
  // unnecessary DoS surface.
  router.post(
    "/software-uploads",
    requireRole("admin"),
    uploadRateLimiter,
    express.raw({ type: () => true, limit: "300mb" }),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: "no file body received" });
          return;
        }
        const rawName = String(req.query.filename ?? "installer.bin");
        const safeName = path.basename(rawName).replace(/[^A-Za-z0-9._-]/g, "_") || "installer.bin";
        const id = `${randomUUID()}-${safeName}`;

        // Per-org subdirectory, not a flat shared one — GET
        // /agent-download/custom/:id (ws/server.ts) only ever looks inside
        // the requesting org's own subdirectory, so one org's upload is
        // unreachable to another even if its random id somehow leaked.
        const orgUploadsDir = path.join(cfg.customInstallersDir, req.user!.orgId);
        const currentUsage = await getDirSize(orgUploadsDir);
        if (currentUsage + req.body.length > cfg.customInstallersMaxBytesPerOrg) {
          res.status(413).json({
            error: `Storage limit reached (${Math.round(cfg.customInstallersMaxBytesPerOrg / (1024 * 1024))}MB per organization). Delete old uploads before adding more.`,
          });
          return;
        }
        await mkdir(orgUploadsDir, { recursive: true });
        await writeFile(path.join(orgUploadsDir, id), req.body);

        audit.info(
          { requestedBy: req.user!.username, id, bytes: req.body.length },
          "software-uploads: installer stored",
        );
        // downloadUrl/agentAuthToken let the dashboard build a run_script
        // body that fetches this file back down on the target device — the
        // caller's own org's agent token (server/src/orgs/orgCredentials.ts
        // — /agent-download/custom/:id now checks per-org tokens, not one
        // fleet-wide secret), the same one already baked into that org's
        // own install.ps1, not a new secret exposed by this endpoint.
        const { rows: orgRows } = await pool.query<{ agent_auth_token: string }>(
          `SELECT agent_auth_token FROM organizations WHERE id = $1`,
          [req.user!.orgId],
        );
        res.status(201).json({
          id,
          filename: safeName,
          bytes: req.body.length,
          downloadUrl: `https://${cfg.ws.publicHost}/agent-download/custom/${encodeURIComponent(id)}`,
          agentAuthToken: orgRows[0]?.agent_auth_token ?? "",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Backs the Agent Updates page: every build ever pushed (agentBuilds.ts's
  // AgentBuildRegistry), which one is active (what the fleet converges to —
  // see ws/registry.ts's needsUpdate), and a per-agent pending-update view
  // derived from each connected agent's own reported version.
  router.get("/agent-builds", requireRole("admin"), (req: AuthedRequest, res: Response) => {
    const activeVersion = agentBuildRegistry.activeVersion;
    const agents = registry
      .listAll()
      .filter((a) => a.orgId === req.user!.orgId)
      .map((a) => ({
        agentId: a.agentId,
        status: a.status,
        version: a.version,
        updateStatus: !a.version ? "unknown" : activeVersion && a.version === activeVersion ? "up_to_date" : "pending",
      }));
    res.json({ activeVersion, builds: agentBuildRegistry.list(), agents });
  });

  // Uploads a new agent build under a given version — same raw-body pattern
  // as POST /software-uploads above, for the same reason (a multi-MB
  // binary is not JSON). Storing it here doesn't activate it — that's a
  // separate, explicit step below, so a bad upload can be reviewed/deleted
  // by hand on disk before it's ever offered to a single agent.
  router.post(
    "/agent-builds",
    requireRole("admin"),
    express.raw({ type: () => true, limit: "100mb" }),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: "no file body received" });
          return;
        }
        const version = String(req.query.version ?? "").trim();
        if (!version) {
          res.status(400).json({ error: "version query param is required" });
          return;
        }
        const info = await agentBuildRegistry.addBuild(version, req.body);
        audit.info({ requestedBy: req.user!.username, version, sha256: info.sha256 }, "agent-builds: new build uploaded");
        res.status(201).json({ build: info });
      } catch (err) {
        next(err);
      }
    },
  );

  // Rollback (an older version) and roll-forward (the newest) are the same
  // call — see AgentBuildRegistry.setActive's doc comment. Takes effect on
  // every connected agent's next heartbeat, no server restart required.
  router.post(
    "/agent-builds/:version/activate",
    requireRole("admin"),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const version = req.params.version ?? "";
        await agentBuildRegistry.setActive(version);
        audit.info({ requestedBy: req.user!.username, version }, "agent-builds: active version changed");
        res.json({ activeVersion: version });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("unknown build version")) {
          res.status(404).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // AI-suggested remediation for the process manager's one-click helper.
  // Returns a recommendation only — nothing is applied here. The frontend
  // shows the suggestion and lets the operator click through to the
  // kill-process endpoint above if they agree.
  router.post("/agents/:id/suggest-remediation", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.id ?? "";
      const body = SuggestRemediationRequestSchema.parse(req.body);
      const snapshot = registry.getTelemetry(req.user!.orgId, agentId);
      const proc = snapshot?.top_processes.find((p) => p.pid === body.pid);
      if (!proc) {
        res.status(404).json({ error: "process not found in the device's most recent telemetry snapshot" });
        return;
      }

      const suggestion = await suggestRemediation({
        deviceId: agentId,
        processName: proc.name,
        pid: proc.pid,
        cpuPercent: proc.cpu_percent,
        memMb: proc.mem_mb,
      });
      res.json({ suggestion, process: proc });
    } catch (err) {
      next(err);
    }
  });

  // Backs the dashboard's Downloads page — every org's own admin/it_support
  // downloads THEIR OWN org's installer (req.user!.orgId, no :id param,
  // unlike the platform-admin-only GET /orgs/:id/installer above which
  // targets an arbitrary org). Previously served one static pre-built zip
  // off disk (cfg.agentInstallerPath) containing the ORIGINAL legacy org's
  // real agent_auth_token/agent_hmac_secret hardcoded into install.ps1 —
  // reachable by every tenant's admin/it_support with no org check at all,
  // so any customer could extract the legacy org's real credentials AND a
  // device installed from it would silently enroll into the legacy org
  // instead of the downloading org. Fixed to build a fresh per-org zip the
  // same way the platform-admin route does (streamOrgInstallerZip + this
  // org's own credentials from getOrganizationCredentials).
  router.get("/downloads/agent-installer", requireRole("admin", "it_support"), installerRateLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const found = await getOrganizationCredentials(pool, req.user!.orgId);
      if (!found) {
        res.status(404).json({ error: "organization not found" });
        return;
      }
      const active = agentBuildRegistry.getActive();
      if (!active) {
        res.status(409).json({ error: "No agent build has been uploaded yet — nothing to package." });
        return;
      }
      audit.info({ requestedBy: req.user!.username, orgId: req.user!.orgId }, "downloads: agent installer generated");
      streamOrgInstallerZip(res, { templateDir: cfg.agentInstallerTemplateDir, agentExePath: active.exePath }, found.org.subdomain, found.agentAuthToken, found.agentHmacSecret);
    } catch (err) {
      next(err);
    }
  });

  // Central error handler: validation errors -> 400, everything else -> 500
  // with the detail logged but not echoed to the client.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "invalid request", details: err.issues });
      return;
    }
    log.error({ err }, "api: unhandled error");
    res.status(500).json({ error: "internal server error" });
  });

  return router;
}
