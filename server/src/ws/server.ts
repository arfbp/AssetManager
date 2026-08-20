// WebSocket hub สำหรับ agent connection จำนวนมากที่เชื่อมต่อพร้อมกัน จัดการ
// auth, การเก็บกวาด connection ที่ตายแล้วด้วย heartbeat และส่งต่อข้อความ
// telemetry/heartbeat/command_result/alert ขาเข้าไปยัง registry และ log
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFileSync, createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type { Config } from "../config.js";
import { log, audit } from "../logger.js";
import { AgentRegistry } from "./registry.js";
import type { CommandHistoryStore } from "../history/commandHistory.js";
import type {
  AlertPayload,
  CommandOutputPayload,
  CommandResultPayload,
  ConfigUpdatePayload,
  Envelope,
  HeartbeatPayload,
  SelfUpdatePayload,
  TelemetryPayload,
} from "../protocol.js";
import { notifyAll } from "../notifications/dispatcher.js";
import type { NotifyConfig } from "../notifications/types.js";
import type { AgentBuildRegistry } from "../agentBuilds.js";
import type { DesiredAgentConfig } from "../agentConfig.js";
import { signSelfUpdate, signConfigUpdate } from "../crypto/commandSigner.js";
import type { OrgCredentialCache, OrgCredential } from "../orgs/orgCredentials.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 256 * 1024; // telemetry snapshot หนึ่งอันมีขนาดเล็ก นี่คือเพดานที่กว้างพอกันการโจมตี

interface ConnState {
  agentId: string | null;
  isAlive: boolean;
  remoteIp: string | null;
  // Resolve ครั้งเดียวตอน connect จาก bearer token ที่ยื่นมา (ดู
  // resolveOrgByAgentToken ด้านล่าง) และเก็บไว้ตลอดอายุ connection — secret
  // ที่ rotate แล้วจะมีผลตอน agent reconnect ครั้งถัดไปเท่านั้น ทำงานแบบ
  // trade-off "cache ตลอดอายุ connection" เดียวกับ OrgCredentialCache เอง
  orgId: string;
  hmacSecret: string;
}

// เดิมทุก agent (และทุก plain-HTTP download route ด้านล่าง) เทียบกับ
// OPTIFLEET_AGENT_AUTH_TOKEN string เดียวที่ใช้ทั้ง fleet — ตอนนี้ token ที่
// ยื่นมาแต่ละครั้งจะถูก lookup กับ token ของแต่ละ organization เอง ดังนั้น
// agent ของลูกค้าคนหนึ่งจะ authenticate ด้วย credential ที่ org อื่นไม่มี
// รวมไว้ตรงนี้เพราะเช็คแบบเดียวกันนี้เดิมถูก copy-paste ไว้ 3 ที่ (verifyClient,
// /agent-download/exe, /agent-download/custom/:id)
function resolveOrgByAgentToken(credentials: OrgCredentialCache, authHeader: string | undefined): OrgCredential | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  if (!token) return null;
  return credentials.resolveByToken(token);
}

export function startWsServer(
  cfg: Config,
  registry: AgentRegistry,
  history: CommandHistoryStore,
  buildRegistry: AgentBuildRegistry,
  desiredConfig: DesiredAgentConfig | null,
  credentials: OrgCredentialCache,
): WebSocketServer {
  const httpOrHttps: HttpServer | HttpsServer =
    cfg.ws.tlsCertPath && cfg.ws.tlsKeyPath
      ? createHttpsServer({
          cert: readFileSync(cfg.ws.tlsCertPath),
          key: readFileSync(cfg.ws.tlsKeyPath),
        })
      : createHttpServer();

  if (!cfg.ws.tlsCertPath) {
    log.warn(
      "ws: no TLS cert configured — serving plaintext ws:// (dev only; config.ts refuses this in production)",
    );
  }

  // Plain HTTP GET บน listener ตัวเดียวกับที่ WebSocket upgrade ใช้อยู่ —
  // agent เชื่อถือ host:port:cert ตัวนี้อยู่แล้ว (มันคือสิ่งที่ dial เพื่อ
  // connection ของตัวเอง) ดังนั้น self-update จึงดึงจากที่นี่แทนที่จะต้องมี
  // address/cert ที่สองที่ agent ต้องตั้งค่าให้เชื่อถือแยกต่างหาก
  // http(s).Server ของ Node จะ route เฉพาะ upgrade request ไปยัง
  // WebSocketServer; request อื่นๆ ทั้งหมดยังคงมาถึง "request" handler
  // ธรรมดานี้เหมือนเดิม
  httpOrHttps.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }

    if (req.url === "/agent-download/exe") {
      if (!resolveOrgByAgentToken(credentials, req.headers["authorization"])) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const active = buildRegistry.getActive();
      if (!active) {
        res.writeHead(404).end("no build available");
        return;
      }
      // Content-Length ช่วยให้สคริปต์ที่กำลังดาวน์โหลดคำนวณ progress จริง
      // (bytes-received / total) ได้ — ถ้าไม่มีค่านี้ response แบบ stream
      // ธรรมดาจะไม่มีขนาดที่ประกาศไว้ ดังนั้นสคริปต์จึงไม่มีทางแปลง "ได้รับ
      // byte มาบ้างแล้ว" เป็นเปอร์เซ็นต์ได้ ดูสคริปต์ที่ generate จากหน้า
      // Software Deploy
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(active.exePath).size });
      createReadStream(active.exePath).pipe(res);
      return;
    }

    // เชื่อถือ bearer-token ต่อ org แบบเดียวกับ /agent-download/exe ด้านบน
    // (token ที่ org ของ agent นี้ถืออยู่ ไม่ใช่ secret ต่อ request) — ดู
    // POST /software-uploads ใน api/routes.ts ว่า `id` มาถึงตรงนี้ได้อย่างไร
    // path.basename ตัดส่วน directory ออกจาก URL segment ก่อนที่มันจะแตะ
    // filesystem เลย ดังนั้นตรงนี้จะ resolve ไปได้แค่ไฟล์ที่อยู่ตรงใน
    // subdirectory ของ org นี้เองใน customInstallersDir เท่านั้น ไม่มีทางไป
    // ที่อื่นบนดิสก์ได้ — และเนื่องจาก org ถูก resolve ใหม่จาก token ที่ยื่นมา
    // ทุก request (ไม่เชื่อจาก URL) จึงไปที่ subdirectory ของ org อื่นไม่ได้
    // เช่นกัน แม้ว่าชื่อไฟล์ที่มี UUID prefix แบบสุ่มของ org นั้นจะรั่วออกมา
    // ก็ตาม
    if (req.url?.startsWith("/agent-download/custom/")) {
      const org = resolveOrgByAgentToken(credentials, req.headers["authorization"]);
      if (!org) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const id = path.basename(decodeURIComponent(req.url.slice("/agent-download/custom/".length)));
      const filePath = path.join(cfg.customInstallersDir, org.orgId, id);
      if (!id || !existsSync(filePath)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(filePath).size });
      createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server: httpOrHttps,
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: (info, cb) => {
      const org = resolveOrgByAgentToken(credentials, info.req.headers["authorization"]);
      if (!org) {
        log.warn({ remote: info.req.socket.remoteAddress }, "ws: rejected connection, bad auth token");
        cb(false, 401, "unauthorized");
        return;
      }
      // connection handler ของ ws ด้านล่างจะได้รับ `req` object ตัวเดียวกันนี้
      // เป็น argument ตัวที่สอง — การเก็บ org ที่ resolve แล้วไว้ตรงนี้คือวิธี
      // มาตรฐานในการส่งข้อมูลต่อจาก verifyClient เพราะไม่มีช่องทางอื่นระหว่าง
      // สองจุดนี้
      (info.req as IncomingMessage & { orgCredential?: OrgCredential }).orgCredential = org;
      cb(true);
    },
  });

  const connStates = new WeakMap<WebSocket, ConnState>();

  wss.on("connection", (socket, req) => {
    const remoteIp = normalizeIp(req.socket.remoteAddress);
    // มีค่าเสมอ — verifyClient จะปฏิเสธ upgrade ก่อนที่ handler นี้จะทำงาน
    // ถ้าไม่มี org ถูก resolve ดังนั้นค่านี้จึงไม่มีทางเป็น undefined จริงๆ
    const org = (req as IncomingMessage & { orgCredential?: OrgCredential }).orgCredential!;
    const state: ConnState = { agentId: null, isAlive: true, remoteIp, orgId: org.orgId, hmacSecret: org.hmacSecret };
    connStates.set(socket, state);
    log.info({ remote: remoteIp, orgId: state.orgId }, "ws: agent connected (awaiting identification)");

    socket.on("pong", () => {
      state.isAlive = true;
    });

    socket.on("message", (raw: RawData) => {
      // ข้อความที่ผิดรูปแบบหรือมุ่งร้ายจาก agent ตัวเดียวต้องไม่ทำให้
      // process ล่มสำหรับ agent อื่นที่เชื่อมต่ออยู่ทุกตัว
      try {
        handleMessage(socket, state, raw, registry, history, cfg.notifications, buildRegistry, desiredConfig, cfg.ws.publicHost);
      } catch (err) {
        log.warn({ agentId: state.agentId, err: (err as Error).message }, "ws: error handling inbound message, dropping it");
      }
    });

    socket.on("close", (code, reason) => {
      if (state.agentId) {
        registry.unregister(state.orgId, state.agentId, socket);
        log.info({ agentId: state.agentId, code, reason: reason.toString() }, "ws: agent disconnected");
      }
    });

    socket.on("error", (err) => {
      log.warn({ agentId: state.agentId, err: err.message }, "ws: connection error");
    });
  });

  // เก็บกวาด connection ที่ตายแล้ว: ping ทุกคนทุกช่วงเวลา ใครที่ไม่ pong กลับ
  // ตั้งแต่รอบกวาดล่าสุดจะถูก terminate นี่คือสิ่งที่ทำให้ "agent จำนวนมาก
  // เชื่อมต่ออยู่พร้อมกัน อย่างเสถียร" เป็นจริงได้ในระยะหลายชั่วโมง/หลายวัน
  // แทนที่จะสะสม socket ที่ค้างครึ่งๆ กลางๆ จากปัญหาเครือข่ายที่ไม่เคยส่ง
  // close frame มา
  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      const state = connStates.get(socket);
      if (!state) continue;
      if (!state.isAlive) {
        log.warn({ agentId: state.agentId }, "ws: no pong since last sweep, terminating connection");
        socket.terminate();
        continue;
      }
      state.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(heartbeatTimer));

  httpOrHttps.listen(cfg.ws.port, () => {
    log.info({ port: cfg.ws.port, tls: Boolean(cfg.ws.tlsCertPath) }, "ws: listening for agent connections");
  });

  return wss;
}

function handleMessage(
  socket: WebSocket,
  state: ConnState,
  raw: RawData,
  registry: AgentRegistry,
  history: CommandHistoryStore,
  notifyCfg: NotifyConfig,
  buildRegistry: AgentBuildRegistry,
  desiredConfig: DesiredAgentConfig | null,
  publicHost: string,
): void {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw.toString());
  } catch {
    log.warn({ agentId: state.agentId }, "ws: dropping malformed envelope (not JSON)");
    return;
  }

  switch (envelope.type) {
    case "heartbeat": {
      const payload = envelope.payload as HeartbeatPayload;
      identifyIfNeeded(socket, state, payload.agent_id, registry);
      registry.touch(state.orgId, payload.agent_id);
      if (payload.version) {
        registry.recordVersion(state.orgId, payload.agent_id, payload.version);
        maybeOfferUpdate(registry, state.orgId, payload.agent_id, buildRegistry, state.hmacSecret, publicHost);
      }
      if (payload.config_hash) {
        registry.recordConfigHash(state.orgId, payload.agent_id, payload.config_hash);
        maybeOfferConfigUpdate(registry, state.orgId, payload.agent_id, desiredConfig, state.hmacSecret);
      }
      break;
    }
    case "telemetry": {
      const payload = envelope.payload as TelemetryPayload;
      if (!state.agentId) {
        log.warn("ws: telemetry received before agent identified itself, dropping");
        return;
      }
      registry.recordTelemetry(state.orgId, state.agentId, payload.snapshot);
      if (payload.snapshot.mode === "alert") {
        log.warn(
          { agentId: state.agentId, cpu: payload.snapshot.cpu_percent, mem: payload.snapshot.mem_percent },
          "ws: agent reporting alert-mode telemetry",
        );
      }
      break;
    }
    case "command_result": {
      const payload = envelope.payload as CommandResultPayload;
      audit.info({ agentId: state.agentId, ...payload }, "command_result received");
      history.recordResult(payload.command_id, payload.success, payload.message);
      break;
    }
    case "command_output": {
      const payload = envelope.payload as CommandOutputPayload;
      if (!state.agentId) {
        log.warn("ws: command_output received before agent identified itself, dropping");
        return;
      }
      registry.recordCommandOutput(state.orgId, state.agentId, payload);
      break;
    }
    case "alert": {
      const payload = envelope.payload as AlertPayload;
      audit.warn({ agentId: state.agentId, ...payload }, "self-heal alert received");
      if (state.agentId) {
        notifyAll(notifyCfg, { kind: payload.kind, agentId: state.agentId, message: payload.message, severity: "warning" });
      }
      break;
    }
    default:
      log.debug({ type: envelope.type }, "ws: ignoring unexpected message type");
  }
}

// จุดเดียวที่ self_update ถูกสร้างและส่งออกไป — ดู doc comment ของ
// SelfUpdatePayload ใน protocol.ts ว่าทำไมเรื่องนี้ถึงสำคัญ: ไม่มีอะไรที่อยู่
// ปลายทางจาก AI console/guardrail เข้าถึงฟังก์ชันนี้ได้เลย มันทำงานเฉพาะตอนที่
// heartbeat ของ agent เองรายงาน version ที่เก่ากว่าตัวที่อยู่บนดิสก์ใน
// downloads/ เท่านั้น URL ชี้กลับไปที่ agent-hub listener ตัวเดียวกันนี้เสมอ
// (publicHost:cfg.ws.port) ไม่มีอะไรที่เซิร์ฟเวอร์ส่งมาต่อ request เลย ดังนั้น
// secret ที่ใช้เซ็นถูกขโมยไปเท่านั้นที่จะทำให้สิ่งนี้ถูก redirect ไปที่อื่นได้
function maybeOfferUpdate(
  registry: AgentRegistry,
  orgId: string,
  agentId: string,
  buildRegistry: AgentBuildRegistry,
  hmacSecret: string,
  publicHost: string,
): void {
  const active = buildRegistry.getActive();
  if (!active) return;
  if (!registry.needsUpdate(orgId, agentId, active.version)) return;

  const issuedAtUnix = Math.floor(Date.now() / 1000);
  const unsigned = { version: active.version, url: `https://${publicHost}/agent-download/exe`, sha256: active.sha256, issuedAtUnix };
  const payload: SelfUpdatePayload = {
    version: unsigned.version,
    url: unsigned.url,
    sha256: unsigned.sha256,
    issued_at_unix: issuedAtUnix,
    signature: signSelfUpdate(unsigned, hmacSecret),
  };

  if (registry.sendSelfUpdate(orgId, agentId, payload)) {
    registry.markUpdateOffered(orgId, agentId);
    audit.info({ orgId, agentId, toVersion: active.version }, "selfupdate: pushed to agent");
  }
}

// เหตุผลการแยกส่วนเดียวกับ maybeOfferUpdate ด้านบน: ไม่มีอะไรที่อยู่ปลายทาง
// จาก AI console/guardrail เข้าถึงฟังก์ชันนี้ได้เลย มันทำงานเฉพาะตอนที่
// heartbeat ของ agent เองรายงาน config hash ที่ไม่ตรงกับ config ที่ต้องการ
// ใน agentConfig.ts เท่านั้น
function maybeOfferConfigUpdate(
  registry: AgentRegistry,
  orgId: string,
  agentId: string,
  desiredConfig: DesiredAgentConfig | null,
  hmacSecret: string,
): void {
  if (!desiredConfig) return;
  if (!registry.needsConfigUpdate(orgId, agentId, desiredConfig.sha256)) return;

  const issuedAtUnix = Math.floor(Date.now() / 1000);
  const unsigned = {
    configYaml: desiredConfig.yaml,
    configSha256: desiredConfig.sha256,
    enableRunScript: desiredConfig.enableRunScript,
    issuedAtUnix,
  };
  const payload: ConfigUpdatePayload = {
    config_yaml: unsigned.configYaml,
    config_sha256: unsigned.configSha256,
    enable_run_script: unsigned.enableRunScript,
    issued_at_unix: issuedAtUnix,
    signature: signConfigUpdate(unsigned, hmacSecret),
  };

  if (registry.sendConfigUpdate(orgId, agentId, payload)) {
    registry.markConfigUpdateOffered(orgId, agentId);
    audit.info({ orgId, agentId, configSha256: desiredConfig.sha256 }, "configpush: pushed to agent");
  }
}

// Heartbeat หรือ telemetry message แรกของ agent คือสิ่งที่บอกตัวตนของมัน
// (agent_id = hostname) — ไม่มี handshake payload แยกต่างหาก ตรงกับวิธีที่
// transport.Client ของ Go agent implement ไว้ orgId มาจาก connection เอง
// (state.orgId ที่ resolve ครั้งเดียวตอน connect จาก bearer token ที่ยื่นมา
// — ดู resolveOrgByAgentToken) ไม่เคยมาจากอะไรที่ agent ส่งมาเองเลย ดังนั้น
// agent ที่ถูกแฮ็กหรือมุ่งร้ายจึงไม่มีทางอ้างว่าเป็นสมาชิกของ org อื่นที่ไม่ใช่
// org ที่ credential ที่มัน authenticate ด้วยจริงๆ เป็นเจ้าของได้
function identifyIfNeeded(
  socket: WebSocket,
  state: ConnState,
  agentId: string,
  registry: AgentRegistry,
): void {
  if (state.agentId === agentId) return;
  if (state.agentId && state.agentId !== agentId) {
    log.warn(
      { previous: state.agentId, new: agentId },
      "ws: agent_id changed mid-connection, re-registering under new id",
    );
    registry.unregister(state.orgId, state.agentId, socket);
  }
  state.agentId = agentId;
  registry.register(state.orgId, agentId, socket, state.remoteIp);
  log.info({ orgId: state.orgId, agentId, remoteIp: state.remoteIp }, "ws: agent identified");
}

// WebSocket connection ที่นี่เป็น TCP ตรง ไม่ได้อยู่หลัง reverse proxy (ดู
// comment เรื่อง TLS-termination ของไฟล์นี้เอง) ดังนั้น
// req.socket.remoteAddress คือ address ของ peer จริง — ไม่ต้องจัดการ
// X-Forwarded-For Node รายงาน IPv4 peer เป็น IPv6-mapped address
// ("::ffff:192.168.10.171") บน dual-stack socket; ตัดส่วนนี้ออกที่นี่เพื่อให้
// ทั้งการเช็ค private-IP ใน geolocation/ipGeo.ts และค่าที่แสดงผลธรรมดาทำงาน
// กับ address ที่คนดูคาดหวังจะเห็นจริงๆ
function normalizeIp(addr: string | undefined): string | null {
  if (!addr) return null;
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}
