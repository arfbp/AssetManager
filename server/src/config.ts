// โหลดและตรวจสอบ environment configuration แบบ fail closed: ถ้าตั้งค่าด้าน
// security ที่จำเป็นขาดไป จะ throw ตั้งแต่ startup แทนที่จะรันต่อแบบเงียบๆ
// ด้วยค่า default ที่ operator ไม่ได้เลือกเอง
import "dotenv/config";
import type { NotifyConfig } from "./notifications/types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`config: missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  ws: {
    port: number;
    tlsCertPath: string | null;
    tlsKeyPath: string | null;
    /** host:port ที่ agent ควรใช้เพื่อเข้าถึง GET /agent-download/exe บน
     * agent-hub listener ตัวเดียวกันนี้ (self-update — ดู ws/server.ts) —
     * เป็น address ที่เข้าถึงได้จากภายนอก ซึ่งเซิร์ฟเวอร์ไม่มีทางรู้เองได้
     * (รู้แค่ port ที่ตัวเอง listen อยู่ ไม่รู้ว่า agent ที่อยู่นอกอินเทอร์เน็ต
     * จะ dial เข้ามาที่ host ไหน) ต้องตรงกับที่ server.url ใน agent.yaml ชี้ไว้ */
    publicHost: string;
  };
  http: {
    port: number;
    /** Origin ที่ dashboard บนเบราว์เซอร์เรียก REST API ตัวนี้ได้ (CORS) */
    dashboardOrigins: string[];
    /** ส่วนท้าย (เช่น ".27-254-142-51.sslip.io" ตอนนี้ หรือ ".optifleet.ai"
     * เมื่อโดเมนจริงของ Phase 6 พร้อมใช้งาน) ที่ subdomain ของ org ไหนก็ได้
     * เรียก API ได้ นอกเหนือจาก dashboardOrigins ที่ fix ไว้ด้านบน — frontend
     * build เดียวเสิร์ฟให้ทุก subdomain ของทุก org (ดู currentOrgSubdomain ใน
     * frontend/src/lib/session.ts ซึ่งต้องใช้ NEXT_PUBLIC_ORG_DOMAIN_SUFFIX
     * ที่ตรงกันตอน build) ดังนั้นการ list origin ของแต่ละ org แบบเจาะจงทีละตัว
     * จึงทำไม่ไหว ใส่ null เพื่อปิดฟีเจอร์นี้ (origin ที่ไม่อยู่ใน list ก็ยัง
     * ถูก reject ตามปกติ) */
    orgDomainSuffix: string | null;
    /** TLS สำหรับ REST API + dashboard WebSocket ที่ browser เรียก
     * (index.ts/ws/dashboardServer.ts) — เดิมเป็น plain HTTP/WS เสมอไม่ว่า
     * ตั้งค่านี้ไว้อย่างไร ต่างจาก agent hub ที่มี TLS option ของตัวเองมาตั้งแต่
     * แรก ค่า default จะใช้ cert/key ชุดเดียวกับที่ตั้งไว้ให้ agent hub แล้ว
     * (`ws.tlsCertPath`/`tlsKeyPath`) ถ้าไม่ได้ตั้งตัวแปร
     * OPTIFLEET_HTTP_TLS_* แยกไว้ — ใช้ cert เดียวคลุมทั้งคู่คือ case ปกติ
     * แต่ deployment จริงที่ terminate ฝั่ง browser หลังโดเมน public ด้วย cert
     * คนละใบ ในขณะที่ agent ใช้ cert internal ก็ยังชี้ตัวแปรพวกนี้ไปคนละไฟล์ได้ */
    tlsCertPath: string | null;
    tlsKeyPath: string | null;
  };
  hmacSecret: string;
  deviceGroupsPath: string;
  /** Agent build ทุกตัวที่เคย push มา บวกกับตัวที่ "active" อยู่ — ดู
   * AgentBuildRegistry ใน agentBuilds.ts การ rollback ไปเวอร์ชันเก่า หรือ
   * roll-forward ไปเวอร์ชันใหม่กว่า คือแค่เปลี่ยน activeVersion ไม่ต้อง
   * restart เซิร์ฟเวอร์ */
  agentBuildsDir: string;
  /** agent.yaml ที่ fleet ต้องการ — ดู loadDesiredAgentConfig ใน
   * agentConfig.ts และ needsConfigUpdate ใน ws/registry.ts เป็น optional:
   * ถ้ายังไม่มีไฟล์ก็แค่ปิดการ convergence ของ config-push ไม่ใช่ startup
   * failure */
  agentConfigTemplatePath: string;
  /** ที่เก็บ installer ที่ admin อัปโหลดเอง (จากหน้า Software Deploy ปุ่ม
   * "upload your own installer") — ดู POST /software-uploads ใน
   * api/routes.ts และ GET /agent-download/custom/:id ใน ws/server.ts
   * คนละส่วนกับไฟล์ installer .zip ของแต่ละ org (อันนั้นเป็น build artifact
   * ของ agent เอง สร้างตามคำขอ); โฟลเดอร์นี้เก็บไฟล์ installer ของ third-party
   * ที่ admin เลือก push ไปยังเครื่องเอง */
  customInstallersDir: string;
  /** เพดานขนาดรวมของ customInstallersDir ต่อ org (ไม่ใช่เพดานต่อไฟล์ —
   * POST /software-uploads เพดานไฟล์เดียวไว้ที่ 300MB อยู่แล้วไม่ว่าค่านี้
   * จะเป็นเท่าไหร่) ถ้าไม่มีค่านี้ org เดียวอัปโหลด installer สะสมไปเรื่อยๆ
   * อาจทำให้ดิสก์ของ VPS เต็มจนกระทบทุก tenant */
  customInstallersMaxBytesPerOrg: number;
  /** โลโก้ที่ org กำหนดเองได้ org ละหนึ่งไฟล์ คีย์ด้วย org id ไม่มีนามสกุลไฟล์
   * (content-type จริงเก็บอยู่ใน organizations.logo_content_type ไม่ได้เดา
   * จากชื่อไฟล์) — ดู GET/POST/DELETE /orgs/:id/logo */
  orgLogosDir: string;
  /** ทุกอย่างที่ installer .zip ของแต่ละ org ต้องใช้ ยกเว้นตัว agent binary
   * เอง (อันนั้นดึงมาจาก active build ใน agentBuildsDir สดใหม่เสมอ ดังนั้น
   * installer ที่สร้างขึ้นจะไม่มีทาง ship exe ที่เก่าค้าง) และ credentials
   * (สร้างแยกต่อ org ไม่เก็บลงดิสก์) — agent.yaml, nssm.exe,
   * optifleet-cert.pem, README.txt, RUN-ME.bat และ install.ps1 เป็น template
   * ที่มี placeholder `__ENV_BLOCK__` ดู orgs/installerGenerator.ts และ
   * GET /api/orgs/:id/installer */
  agentInstallerTemplateDir: string;
  enableRunScriptDispatch: boolean;
  isProduction: boolean;
  /** Connection string ของ Postgres จำเป็นต้องมี — บัญชีผู้ใช้และ session
   * (src/auth/) เก็บอยู่ใน Postgres ไม่ใช่หน่วยความจำ ดังนั้นถ้าไม่มีค่านี้
   * ระบบ login จริงจะไม่มีที่เก็บเลย ประวัติ telemetry/command (src/db/
   * persistence.ts) ก็ใช้ connection เดียวกันนี้ */
  databaseUrl: string;
  /** การแจ้งเตือนออกไปภายนอก (Slack/Teams/email) — ดู notifications/
   * แต่ละ channel เป็น optional แยกอิสระจากกัน ถ้าไม่ตั้งค่าเลยสักตัวก็แค่
   * ไม่มีอะไรถูกส่งออกไปไหน แจ้งเตือนจะโชว์แค่ใน dashboard เหมือนก่อนมี
   * ฟีเจอร์นี้ */
  notifications: NotifyConfig;
}

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === "production";

  const tlsCertPath = process.env.OPTIFLEET_TLS_CERT_PATH || null;
  const tlsKeyPath = process.env.OPTIFLEET_TLS_KEY_PATH || null;
  const httpTlsCertPath = process.env.OPTIFLEET_HTTP_TLS_CERT_PATH || tlsCertPath;
  const httpTlsKeyPath = process.env.OPTIFLEET_HTTP_TLS_KEY_PATH || tlsKeyPath;

  if (isProduction && (!tlsCertPath || !tlsKeyPath)) {
    throw new Error(
      "config: NODE_ENV=production requires OPTIFLEET_TLS_CERT_PATH and " +
        "OPTIFLEET_TLS_KEY_PATH — refusing to serve plaintext ws:// to agents in production",
    );
  }
  if (isProduction && (!httpTlsCertPath || !httpTlsKeyPath)) {
    throw new Error(
      "config: NODE_ENV=production requires OPTIFLEET_HTTP_TLS_CERT_PATH and " +
        "OPTIFLEET_HTTP_TLS_KEY_PATH (or the OPTIFLEET_TLS_* pair to reuse the agent hub's cert) — " +
        "refusing to serve the dashboard API/login over plaintext http:// in production",
    );
  }

  const wsPort = Number(optional("OPTIFLEET_WS_PORT", "8443"));
  return {
    ws: {
      port: wsPort,
      tlsCertPath,
      tlsKeyPath,
      publicHost: optional("OPTIFLEET_WS_PUBLIC_HOST", `localhost:${wsPort}`),
    },
    http: {
      port: Number(optional("OPTIFLEET_HTTP_PORT", "8080")),
      dashboardOrigins: optional("OPTIFLEET_DASHBOARD_ORIGIN", "http://localhost:3000")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      orgDomainSuffix: optional("OPTIFLEET_ORG_DOMAIN_SUFFIX", "") || null,
      tlsCertPath: httpTlsCertPath,
      tlsKeyPath: httpTlsKeyPath,
    },
    hmacSecret: required("OPTIFLEET_HMAC_SECRET"),
    deviceGroupsPath: optional("OPTIFLEET_DEVICE_GROUPS_PATH", "./config/device-groups.json"),
    agentBuildsDir: optional("OPTIFLEET_AGENT_BUILDS_DIR", "./downloads/agent-builds"),
    agentConfigTemplatePath: optional("OPTIFLEET_AGENT_CONFIG_TEMPLATE_PATH", "./config/agent-config-template.yaml"),
    customInstallersDir: optional("OPTIFLEET_CUSTOM_INSTALLERS_DIR", "./downloads/custom-installers"),
    customInstallersMaxBytesPerOrg: Number(optional("OPTIFLEET_CUSTOM_INSTALLERS_MAX_MB_PER_ORG", "2048")) * 1024 * 1024,
    orgLogosDir: optional("OPTIFLEET_ORG_LOGOS_DIR", "./uploads/org-logos"),
    agentInstallerTemplateDir: optional("OPTIFLEET_AGENT_INSTALLER_TEMPLATE_DIR", "./agent-installer-template"),
    enableRunScriptDispatch: optional("OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH", "false") === "true",
    isProduction,
    databaseUrl: required("OPTIFLEET_DATABASE_URL"),
    notifications: loadNotifyConfig(),
  };
}

function loadNotifyConfig(): NotifyConfig {
  const emailHost = process.env.OPTIFLEET_NOTIFY_EMAIL_HOST || "";
  return {
    slackWebhookUrl: process.env.OPTIFLEET_NOTIFY_SLACK_WEBHOOK || null,
    teamsWebhookUrl: process.env.OPTIFLEET_NOTIFY_TEAMS_WEBHOOK || null,
    email: emailHost
      ? {
          host: emailHost,
          port: Number(optional("OPTIFLEET_NOTIFY_EMAIL_PORT", "587")),
          user: optional("OPTIFLEET_NOTIFY_EMAIL_USER", ""),
          pass: optional("OPTIFLEET_NOTIFY_EMAIL_PASS", ""),
          from: optional("OPTIFLEET_NOTIFY_EMAIL_FROM", "OptiFleet AI <noreply@optifleet.local>"),
          to: optional("OPTIFLEET_NOTIFY_EMAIL_TO", "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : null,
  };
}
