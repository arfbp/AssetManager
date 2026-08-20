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
import { notifyAll } from "./notifications/dispatcher.js";
import { AgentBuildRegistry } from "./agentBuilds.js";
import { loadDesiredAgentConfig } from "./agentConfig.js";
import { OrgCredentialCache } from "./orgs/orgCredentials.js";
import { listOrganizations } from "./orgs/orgsStore.js";
import { listAssetsWithExpiringWarranty } from "./assets/assetsStore.js";
import { listUpcomingMaintenance } from "./maintenance/maintenanceStore.js";
import { listLicensesWithExpiring } from "./licenses/licensesStore.js";
import type pg from "pg";
import type { NotifyConfig } from "./notifications/types.js";

// Digest ประจำวันของ Asset Management ERP — งานแรกในโค้ดเบสนี้ที่เป็นแบบ
// scheduled (ต่างจากแบบ event-driven) ดู plan doc ของโมดูล ERP ว่าทำไมถึงใช้
// setInterval ธรรมดาแทนที่จะเพิ่ม dependency ของ cron เช็คทุกชั่วโมงแต่จะทำงาน
// จริงก็ต่อเมื่อวันที่ปัจจุบันเปลี่ยนไปจาก lastDigestDate เท่านั้น ดังนั้นแม้
// restart กลางวันก็ทำให้ส่งซ้ำได้มากสุดแค่ครั้งเดียว (กรณีแย่สุด: ส่งซ้ำวัน
// เดียวกันถ้า process restart หลังจากส่งไปแล้ว — ยอมรับได้สำหรับ summary
// วันละครั้ง ไม่คุ้มที่จะทำ guard แยกผ่าน DB) เผื่อ lookahead 7 วัน — สั้นกว่า
// หน้าต่าง "needs attention" 30 วันของ dashboard เอง เพราะ push notification
// ควรพูดถึงสิ่งที่ใกล้จะถึงจริงๆ ไม่ใช่แจ้งล่วงหน้าไกลเกินไป
const DIGEST_LOOKAHEAD_DAYS = 7;
let lastDigestDate: string | null = null;

async function runDailyDigestIfDue(pool: pg.Pool, notifyConfig: NotifyConfig): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastDigestDate) return;
  lastDigestDate = today;

  if (!notifyConfig.slackWebhookUrl && !notifyConfig.teamsWebhookUrl && !notifyConfig.email) return;

  try {
    const orgs = await listOrganizations(pool);
    const lines: string[] = [];
    for (const org of orgs) {
      const [warranties, maintenance, licenses] = await Promise.all([
        listAssetsWithExpiringWarranty(pool, org.id, DIGEST_LOOKAHEAD_DAYS),
        listUpcomingMaintenance(pool, org.id, DIGEST_LOOKAHEAD_DAYS),
        listLicensesWithExpiring(pool, org.id, DIGEST_LOOKAHEAD_DAYS),
      ]);
      if (warranties.length === 0 && maintenance.length === 0 && licenses.length === 0) continue;
      const parts: string[] = [];
      if (warranties.length > 0) parts.push(`${warranties.length} warrant${warranties.length === 1 ? "y" : "ies"} expiring`);
      if (maintenance.length > 0) parts.push(`${maintenance.length} maintenance item(s) due`);
      if (licenses.length > 0) parts.push(`${licenses.length} license(s) expiring`);
      lines.push(`${org.name}: ${parts.join(", ")}`);
    }
    if (lines.length === 0) return;

    notifyAll(notifyConfig, {
      kind: "erp_digest",
      agentId: "Asset Management",
      message: `Daily asset digest (next ${DIGEST_LOOKAHEAD_DAYS} days):\n${lines.join("\n")}`,
      severity: "info",
    });
    log.info({ orgCount: lines.length }, "erp: daily digest sent");
  } catch (err) {
    log.error({ err }, "erp: daily digest failed");
  }
}

// Error รายข้อความถูกดักไว้แล้วใน ws/server.ts เพื่อไม่ให้ payload ของ agent
// ตัวเดียวที่พังทำให้ process ตายทั้งตัว สองตัวนี้คือ backstop สุดท้ายสำหรับ
// อะไรก็ตามที่หลุดรอดมาได้ — log พร้อม context เต็มๆ แล้ว exit ให้ process
// supervisor (systemd/pm2/Docker restart policy — ดู server/README.md)
// restart เข้าสู่สถานะสะอาดใหม่ แทนที่จะรันต่อไปในสถานะที่ process อาจเสียหาย
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

  // ถ้าไม่มีส่วนนี้ ทุกครั้งที่เซิร์ฟเวอร์ restart หน้า "who did what" ของ
  // dashboard/AI console/แท็บ Commands จะว่างเปล่าไปเงียบๆ — ตาราง
  // command_history ที่เก็บถาวรไม่มีปัญหาอะไร มีแค่สำเนาที่ใช้งานใน
  // หน่วยความจำตัวนี้เท่านั้นที่ reset ไป ทำแบบ best-effort: ถ้าล้มเหลว (เช่น
  // ยังไม่ได้รัน migration บน deployment ใหม่) จะ log แล้วรันต่อด้วย history
  // ว่างเปล่าแทนที่จะบล็อก startup
  try {
    const recentHistory = await loadRecentHistory(pool);
    history.hydrate(recentHistory);
    log.info({ count: recentHistory.length }, "history: rehydrated from command_history");
  } catch (err) {
    log.error({ err }, "history: failed to rehydrate from command_history, starting empty");
  }

  // เหตุผลเดียวกับการ rehydrate history ด้านบน — ถ้าไม่มีส่วนนี้ ทุกครั้งที่
  // restart อุปกรณ์ที่เชื่อมต่ออยู่ปกติดีจะดูเหมือนไม่มี telemetry เลย (แท็บ
  // Live, คอลัมน์ CPU/RAM/storage/IP ใน Asset Registry) จนกว่าจะถึงรอบ poll
  // ครั้งถัดไป
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

  // getActive() คืนค่า null (ยังไม่มีประวัติ build เลย หรือ manifest ว่างเปล่า)
  // แปลว่าแค่ปิดใช้งาน self-update (ทุก agent ที่เชื่อมต่ออยู่จะ short-circuit
  // ใน needsUpdate check) ไม่ใช่ startup failure — ดู agentBuilds.ts
  const agentBuildRegistry = await AgentBuildRegistry.load(cfg.agentBuildsDir);
  const desiredAgentConfig = await loadDesiredAgentConfig(cfg.agentConfigTemplatePath);

  // Auth token ของ agent + HMAC secret แยกต่อ org แทนที่คู่เดียวที่ใช้ร่วมกัน
  // ทั้ง fleet — warm-start ครั้งเดียวที่นี่ (ดู orgs/orgCredentials.ts) แล้ว
  // reload ใหม่ทุกครั้งที่มี org ใหม่ถูก provision (ทั้ง org:create และ flow
  // "create organization" ของ dashboard ในอนาคตจะเรียก credentials.reload()
  // หลัง insert แถวใหม่ เพื่อให้ agent ของ org ที่เพิ่งสร้างเชื่อมต่อได้โดยไม่
  // ต้อง restart เซิร์ฟเวอร์)
  const orgCredentials = await OrgCredentialCache.load(pool);

  const wss = startWsServer(cfg, registry, history, agentBuildRegistry, desiredAgentConfig, orgCredentials);

  // ดู doc comment ของ runDailyDigestIfDue เอง — เช็คทุกชั่วโมง แต่ทำงานจริง
  // แค่ครั้งเดียวต่อวันที่ ยิงครั้งแรกตอน startup ด้วย (ไม่ใช่แค่รอ tick
  // รายชั่วโมงครั้งแรก) เพื่อให้เซิร์ฟเวอร์ที่ down มาทั้งวันยังส่ง digest ของ
  // วันนั้นได้ทันทีที่กลับมาออนไลน์
  void runDailyDigestIfDue(pool, cfg.notifications);
  setInterval(() => void runDailyDigestIfDue(pool, cfg.notifications), 60 * 60 * 1000);

  const app = express();
  // Deployment จริงทุกตัวของเซิร์ฟเวอร์นี้อยู่หลัง nginx บนโฮสต์เดียวกันเสมอ
  // (ดู nginx config ของ VPS deployment) — "loopback" เชื่อ X-Forwarded-For
  // เฉพาะตอนที่ nginx เองเป็นคนยิง request มา (127.0.0.1) ดังนั้น req.ip จึง
  // สะท้อน client จริงสำหรับ rate limiting/audit logging แทนที่ทุกคนจะดู
  // เหมือนเป็น nginx ไปหมด express-rate-limit จะปฏิเสธไม่ยอม start เลยถ้า
  // เจอ forwarded-for header ทั้งที่ยังไม่ได้ตั้งค่านี้ แทนที่จะแชร์ bucket
  // เดียวกันข้าม client ทุกคนแบบเงียบๆ
  app.set("trust proxy", "loopback");
  // Dashboard เป็นแอปบนเบราว์เซอร์ที่อยู่คนละ origin (localhost:3000 vs
  // localhost:8080 ของเซิร์ฟเวอร์นี้) — ทุก REST call ที่มันยิงจะแนบ custom
  // Authorization header มาด้วย ทำให้กลายเป็น CORS-preflighted request ไม่ว่า
  // จะ method ไหนก็ตาม ถ้าไม่มีส่วนนี้ เบราว์เซอร์จะบล็อก request ตั้งแต่ฝั่ง
  // client ก่อนที่จะไปถึง Express เลย ปัญหานี้ curl/fetch-from-Node ไม่มีทาง
  // เจอ เพราะ CORS เป็นข้อจำกัดที่เบราว์เซอร์บังคับใช้ ไม่ใช่ฝั่งเซิร์ฟเวอร์ —
  // นั่นคือเหตุผลที่ gap นี้รอดพ้นทุก test ที่ไม่ได้รันผ่านเบราว์เซอร์มาตลอด
  app.use(
    cors({
      // เป็นฟังก์ชัน ไม่ใช่ array dashboardOrigins คงที่เพียงอย่างเดียว —
      // frontend build เดียวเสิร์ฟให้ทุก subdomain ของทุก org (Phase 6/7 ของ
      // การย้ายไป multi-tenant) ดังนั้น list ของ origin ที่อนุญาตจึงเป็นค่า
      // config ตายตัวที่แก้มือทีละ org ไม่ได้ อะไรที่อยู่ใน dashboardOrigins
      // อนุญาตตรงๆ (dev/localhost, hostname หลัก); อย่างอื่นอนุญาตถ้าตั้งค่า
      // orgDomainSuffix ไว้และ origin ลงท้ายด้วยค่านั้น (ยืนยันจากของจริงแล้ว:
      // ถ้าไม่มีส่วนนี้ subdomain ของ org จริง — เช่น
      // https://360qm.27-254-142-51.sslip.io — จะถูกบล็อกตอน login ตั้งแต่
      // ฝั่งเบราว์เซอร์ก่อนถึง Express เลย ซึ่งเป็น failure mode เดียวกับที่
      // config แบบ array คงที่ไม่มีทางเลี่ยงได้) หรือถ้าตรงกับโดเมนของตัวเอง
      // ที่ org เป็นเจ้าของเต็มรูปแบบ (organizations.custom_domain เช่น
      // https://assets.360qm.co.th — ดู customDomainOrigins set ที่
      // warm-start ไว้ใน orgs/orgCredentials.ts)
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
      // ทุก method ที่ API นี้เปิดใช้งานจริง (assets/users CRUD ใช้ PUT/
      // PATCH/DELETE) — ปัญหา GET/POST-only ไม่เคยถูกสังเกตเห็นบน sslip.io
      // host หลัก เพราะ dashboard กับ API แชร์ origin เดียวกันที่นั่น (ไม่มี
      // preflight เลย เป็น same-origin) แต่ org ไหนก็ตามที่อยู่บน subdomain
      // หรือ custom domain ของตัวเองจะ cross-origin จาก API host จริงๆ ดังนั้น
      // การเขียนข้อมูลจึงเจอ preflight rejection จริง (ตรวจสอบจากของจริงกับ
      // https://assets.360qm.co.th แล้ว: "Method PUT is not allowed by
      // Access-Control-Allow-Methods")
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      // X-Org-Subdomain: ส่งเฉพาะตอน POST /auth/login (ดู
      // currentOrgSubdomain() ใน session.ts) — custom header ใน
      // cross-origin request ใดๆ จะ trigger CORS preflight ไม่ว่า method
      // ไหน ดังนั้นต้องอนุญาตไว้ตรงนี้อย่างชัดเจนเหมือนกับ Authorization
      // ไม่งั้นเบราว์เซอร์จะบล็อก login request ตั้งแต่ฝั่ง client ก่อนถึง
      // Express
      allowedHeaders: ["Content-Type", "Authorization", "X-Org-Subdomain"],
    }),
  );
  app.use("/api", buildRouter(cfg, registry, deviceGroups, history, pool, agentBuildRegistry, orgCredentials));
  // เช็ค Postgres จริงๆ ไม่ใช่แค่ "process นี้ยังรันอยู่" — process
  // supervisor/uptime monitor ที่คอยดูจุดนี้ต้องแยกออกว่า DB ตายจริงๆ กับ
  // DB ที่ยังสุขภาพดีต่างกันอย่างไร ตอบ 200 เปล่าๆ ทำแบบนั้นไม่ได้เลย จำกัด
  // เวลาการเช็คไว้ที่ 2 วินาที เพื่อไม่ให้ pool ที่ค้างทำให้ health check ที่
  // ควรจะจับปัญหานี้ค้างไปด้วย
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

  // เดิมเป็น plain http:// เสมอไม่ว่าจะตั้งค่า TLS อย่างไร — login, session
  // token และทุกคำสั่งที่ dispatch ออกไปวิ่งผ่านเครือข่ายแบบ cleartext แม้ว่า
  // agent hub ด้านล่างจะใช้ wss:// อยู่แล้วก็ตาม ใช้ pattern TLS แบบมีเงื่อนไข
  // เดียวกับ startWsServer ใน ws/server.ts
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

  // ต่อพ่วงกับ server app.listen() ตัวเดียวกันที่เพิ่งสร้าง — ดูเหตุผลว่าทำไม
  // ไม่ต้องมี port แยกใน ws/dashboardServer.ts
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
