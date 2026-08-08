import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import express from "express";
import cors from "cors";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { DeviceGroups } from "./groups/deviceGroups.js";
import { AgentRegistry } from "./ws/registry.js";
import { startWsServer } from "./ws/server.js";
import { startDashboardWsServer } from "./ws/dashboardServer.js";
import { CommandHistoryStore } from "./history/commandHistory.js";
import { buildRouter } from "./api/routes.js";
import { initPool } from "./db/pool.js";
import { wirePersistence, loadRecentHistory, loadPersistedAgents } from "./db/persistence.js";
import { wireNotifications } from "./notifications/alertWatcher.js";
import { AgentBuildRegistry } from "./agentBuilds.js";
import { loadDesiredAgentConfig } from "./agentConfig.js";
import { OrgCredentialCache } from "./orgs/orgCredentials.js";

// Per-message errors are already caught in ws/server.ts so one bad agent
// payload can't take the process down. These are the last-resort backstops
// for anything that still escapes — log with full context, then exit so a
// process supervisor (systemd/pm2/Docker restart policy — see
// server/README.md) restarts into a clean state rather than continuing to
// serve agents from a potentially corrupted process.
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception, exiting for supervisor restart");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.fatal({ reason }, "unhandled promise rejection, exiting for supervisor restart");
  process.exit(1);
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  const registry = new AgentRegistry();
  const deviceGroups = DeviceGroups.loadFromFile(cfg.deviceGroupsPath, (orgId) =>
    registry
      .listAll()
      .filter((a) => a.orgId === orgId)
      .map((a) => a.agentId),
  );
  const history = new CommandHistoryStore();

  const pool = initPool(cfg.databaseUrl);
  wirePersistence(pool, registry, history, cfg.notifications);
  log.info("db: persistence wired to Postgres (run `npm run db:migrate` once before first use)");

  // Without this, every server restart silently blanked the dashboard/AI
  // console/Commands tab's "who did what" view back to empty — the durable
  // command_history table itself was always fine, only this in-memory
  // operational copy reset. Best-effort: a failure here (e.g. migration not
  // run yet on a brand-new deployment) logs and continues with an empty
  // history rather than blocking startup.
  try {
    const recentHistory = await loadRecentHistory(pool);
    history.hydrate(recentHistory);
    log.info({ count: recentHistory.length }, "history: rehydrated from command_history");
  } catch (err) {
    log.error({ err }, "history: failed to rehydrate from command_history, starting empty");
  }

  // Same reasoning as the history rehydration above — without this, every
  // restart made a perfectly healthy, still-connected device look like it
  // had no telemetry (Live tab, Asset Registry's CPU/RAM/storage/IP columns)
  // until its next scheduled poll landed.
  try {
    const persistedAgents = await loadPersistedAgents(pool);
    registry.hydrate(persistedAgents);
    log.info({ count: persistedAgents.length }, "registry: rehydrated from agents table");
  } catch (err) {
    log.error({ err }, "registry: failed to rehydrate from agents table, starting empty");
  }

  wireNotifications(registry, cfg.notifications);
  const enabledChannels = [
    cfg.notifications.slackWebhookUrl && "slack",
    cfg.notifications.teamsWebhookUrl && "teams",
    cfg.notifications.email && "email",
  ].filter(Boolean);
  log.info({ channels: enabledChannels }, enabledChannels.length ? "notifications: channels enabled" : "notifications: no channels configured");

  // getActive() returning null (no build history yet, or an empty
  // manifest) just means self-update stays disabled (every connected
  // agent's needsUpdate check short-circuits on it) rather than failing
  // startup — see agentBuilds.ts.
  const agentBuildRegistry = await AgentBuildRegistry.load(cfg.agentBuildsDir);
  const desiredAgentConfig = await loadDesiredAgentConfig(cfg.agentConfigTemplatePath);

  // Per-org agent auth token + HMAC secret, replacing the single fleet-wide
  // pair — warm-started once here (see orgs/orgCredentials.ts) and reloaded
  // whenever a new org is provisioned (org:create / the future "create
  // organization" dashboard flow both call credentials.reload() after
  // inserting a row, so a freshly created org's agents can connect without
  // a server restart).
  const orgCredentials = await OrgCredentialCache.load(pool);

  const wss = startWsServer(cfg, registry, history, agentBuildRegistry, desiredAgentConfig, orgCredentials);

  const app = express();
  // Every real deployment of this server sits behind nginx on the same host
  // (see the VPS deployment's nginx config) — "loopback" trusts
  // X-Forwarded-For only when it's nginx itself (127.0.0.1) making the
  // request, so req.ip reflects the real client for rate limiting/audit
  // logging instead of everyone appearing to be nginx. express-rate-limit
  // refuses to start at all if it detects a forwarded-for header with this
  // unset, rather than silently sharing one bucket across every client.
  app.set("trust proxy", "loopback");
  // The dashboard is a browser app on a different origin (localhost:3000 vs
  // this server's localhost:8080) — every REST call it makes carries a
  // custom Authorization header, which makes it a CORS-preflighted request
  // regardless of method. Without this, the browser blocks the request
  // client-side before it ever reaches Express; curl/fetch-from-Node never
  // hit this because CORS is a browser-enforced restriction, not a server
  // one — that's why this gap survived every non-browser test.
  app.use(
    cors({
      // A function, not the fixed dashboardOrigins array alone — one shared
      // frontend build serves every org's subdomain (Phase 6/7 of the
      // multi-tenant migration), so the allowed-origins list can't be a
      // static config value hand-edited per org. Anything in
      // dashboardOrigins is allowed outright (dev/localhost, the base
      // hostname); anything else is allowed if orgDomainSuffix is
      // configured and the origin ends with it (verified live: without
      // this, a real org's own subdomain — e.g.
      // https://360qm.27-254-142-51.sslip.io — got its login blocked
      // client-side by the browser's CORS preflight before ever reaching
      // Express, exactly the same failure mode the fixed-array config had
      // no way to avoid), or if it matches an org's own fully-owned custom
      // domain (organizations.custom_domain, e.g. https://assets.360qm.co.th
      // — see orgs/orgCredentials.ts's warm-started customDomainOrigins set).
      origin: (origin, callback) => {
        if (!origin || cfg.http.dashboardOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        if (cfg.http.orgDomainSuffix && origin.endsWith(cfg.http.orgDomainSuffix)) {
          callback(null, true);
          return;
        }
        if (orgCredentials.hasCustomDomainOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`origin not allowed: ${origin}`));
      },
      // Every method the API actually exposes (assets/users CRUD use PUT/
      // PATCH/DELETE) — GET/POST-only was never noticed on the base
      // sslip.io host because dashboard and API share that origin there
      // (no preflight at all, same-origin), but any org on its own
      // subdomain or custom domain is genuinely cross-origin from the API
      // host, so a write there hit a real preflight rejection (caught live
      // against https://assets.360qm.co.th: "Method PUT is not allowed by
      // Access-Control-Allow-Methods").
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      // X-Org-Subdomain: sent only on POST /auth/login (see
      // session.ts's currentOrgSubdomain()) — a custom header on any
      // cross-origin request triggers a CORS preflight regardless of
      // method, so it has to be explicitly allowed here the same as
      // Authorization already is, or the browser blocks the login request
      // client-side before it ever reaches Express.
      allowedHeaders: ["Content-Type", "Authorization", "X-Org-Subdomain"],
    }),
  );
  app.use("/api", buildRouter(cfg, registry, deviceGroups, history, pool, agentBuildRegistry, orgCredentials));
  // Actually checks Postgres, not just "this process is still running" — a
  // process supervisor/uptime monitor watching this needs to be able to
  // tell a genuinely dead DB apart from a healthy one; a bare 200 can never
  // do that. A 2s cap on the check itself so a hanging pool can't also hang
  // the health check that's supposed to catch it.
  app.get("/healthz", async (_req, res) => {
    try {
      await Promise.race([
        pool.query("SELECT 1"),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("db health check timed out")), 2000)),
      ]);
      res.status(200).send("ok");
    } catch (err) {
      log.warn({ err }, "healthz: database check failed");
      res.status(503).send("db unavailable");
    }
  });

  // Previously always plain http:// regardless of any TLS config — logins,
  // session tokens, and every dispatched command crossed the network in
  // cleartext even when the agent hub right below it was already using
  // wss://. Same conditional-TLS pattern as ws/server.ts's startWsServer.
  const useTls = Boolean(cfg.http.tlsCertPath && cfg.http.tlsKeyPath);
  if (!useTls) {
    log.warn("http: no TLS cert configured — serving the dashboard API/login over plaintext http:// (dev only; config.ts refuses this in production)");
  }
  const httpServer = useTls
    ? createHttpsServer({ cert: readFileSync(cfg.http.tlsCertPath!), key: readFileSync(cfg.http.tlsKeyPath!) }, app)
    : createHttpServer(app);

  httpServer.listen(cfg.http.port, () => {
    log.info({ port: cfg.http.port, tls: useTls }, "http: dashboard API listening");
  });

  // Attached to the same server app.listen() just created — see
  // ws/dashboardServer.ts for why this doesn't need its own port.
  const dashboardWss = startDashboardWsServer(cfg, httpServer, registry, history, pool);

  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    httpServer.close();
    dashboardWss.close();
    wss.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error:", err);
  process.exit(1);
});
