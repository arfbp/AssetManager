// WebSocket endpoint ตัวที่สอง แยกจาก agent hub ใน ws/server.ts สำหรับ
// browser dashboard client push สถานะ agent สดๆ และอัปเดตประวัติคำสั่งไป
// ให้ เพื่อไม่ต้องให้ frontend คอย poll
//
// ต่อพ่วงกับ HTTP server ตัวเดียวกับที่ Express listen อยู่ (ดู index.ts)
// แทนที่จะเปิด port ใหม่ของตัวเอง — เปิด port/firewall น้อยลงหนึ่งช่อง สำหรับ
// TLS termination บน production ให้ใส่ reverse proxy (nginx/Caddy) ไว้ด้านหน้า
// แบบที่ Node deployment ส่วนใหญ่ทำ; agent hub ใน ws/server.ts จัดการ TLS เอง
// โดยตรงแทน เพราะเป็นตัวที่ต้องรัน standalone ได้ใน default setup ของ repo นี้
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Pool } from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "../config.js";
import { log } from "../logger.js";
import { validateSession } from "../auth/sessions.js";
import type { AgentRegistry, AgentSummary } from "./registry.js";
import type { CommandHistoryStore, HistoryEntry } from "../history/commandHistory.js";
import type { CommandOutputPayload } from "../protocol.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export function startDashboardWsServer(
  cfg: Config,
  httpServer: HttpServer | HttpsServer,
  registry: AgentRegistry,
  history: CommandHistoryStore,
  pool: Pool,
): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws/dashboard",
    verifyClient: (info, cb) => {
      // เบราว์เซอร์ตั้ง custom header บน native WebSocket ไม่ได้ ดังนั้น
      // session token ส่งเป็น Authorization header แบบที่ bearer auth ของ
      // agent hub ทำไม่ได้ เดิมทีมันเดินทางผ่าน query string ของ URL แทน —
      // ซึ่ง access-log format default ของ nginx บันทึกไว้เต็มๆ แปลว่า token
      // ของทุก dashboard session ถูกเขียนลงดิสก์แบบ plaintext ทุกครั้งที่
      // connect Sec-WebSocket-Protocol คือทางแก้มาตรฐานสำหรับข้อจำกัดนี้ของ
      // เบราว์เซอร์โดยเฉพาะ: client ตั้งค่าผ่าน `new WebSocket(url, [token])`
      // (ดู useDashboardSocket.ts) ซึ่งจะกลายเป็น request *header* ไม่ใช่ส่วน
      // หนึ่งของ URL — nginx/access log จะไม่เห็นมันเลย ยังคงเป็น session
      // จริง เพิกถอนได้ ต่อ user เดียวกัน ที่ lookup จาก Postgres
      // (src/auth/sessions.ts) — ไม่ใช่ shared static secret แค่เปลี่ยนวิธี
      // ขนส่งเท่านั้น
      const token = (info.req.headers["sec-websocket-protocol"] ?? "").split(",")[0]?.trim() ?? "";
      validateSession(pool, token)
        .then((session) => {
          if (!session) {
            log.warn({ remote: info.req.socket.remoteAddress }, "dashboard ws: rejected connection, bad/expired session");
            cb(false, 401, "unauthorized");
            return;
          }
          // connection handler ของ ws ด้านล่างจะได้รับ `req` object ตัวเดียวกัน
          // นี้เป็น argument ตัวที่สอง — การเก็บ org ที่ resolve แล้วไว้ตรงนี้
          // คือวิธีมาตรฐานในการส่งข้อมูลต่อจาก verifyClient เหมือนกับที่
          // verifyClient ของ agent-hub ใน ws/server.ts ใช้สำหรับ resolve org
          // ต่อ connection ของตัวเอง
          (info.req as IncomingMessage & { orgId?: string }).orgId = session.orgId;
          cb(true);
        })
        .catch((err) => {
          log.error({ err }, "dashboard ws: session validation failed");
          cb(false, 500, "internal error");
        });
    },
  });

  const alive = new WeakMap<WebSocket, boolean>();
  // ทุก event ที่ broadcast ด้านล่างจะแนบ orgId ของ org ที่มันเกี่ยวข้องมาด้วย
  // — นี่คือสิ่งที่ทำให้ multi-tenancy เป็นจริงในเลเยอร์ที่มีโอกาสรั่วไหลแบบ
  // เงียบๆ มากที่สุด: ถ้าไม่มีส่วนนี้ browser tab ที่เชื่อมต่ออยู่จะเห็นการ
  // อัปเดต agent/telemetry/command สดๆ ของทุก org อื่นทันทีที่มันเกิดขึ้น
  // ไม่ว่า REST API จะกรองข้อมูลของ org ไหนถูกต้องแค่ไหนก็ตาม socketOrg ถูก
  // set ครั้งเดียวตอน connect (org ของ dashboard session ไม่มีวันเปลี่ยนกลาง
  // connection) และไม่เคยถูกอ่านใหม่จากที่อื่นเลย
  const socketOrg = new WeakMap<WebSocket, string>();

  wss.on("connection", (socket, req) => {
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    // มีค่าเสมอ — verifyClient จะปฏิเสธ upgrade ก่อนที่ handler นี้จะทำงาน
    // ถ้าไม่มี session (และไม่มี org) ถูก resolve
    const orgId = (req as IncomingMessage & { orgId?: string }).orgId!;
    socketOrg.set(socket, orgId);

    // ส่ง snapshot เต็มตอน connect เพื่อไม่ให้ dashboard tab ที่เพิ่งเปิดใหม่
    // ว่างเปล่าจนกว่า state change ครั้งถัดไปจะเกิดขึ้นเอง — กรองเฉพาะ org ของ
    // socket นี้ ขอบเขตเดียวกับทุกการอ่านผ่าน REST
    send(socket, {
      type: "snapshot",
      agents: registry.listAll().filter((a) => a.orgId === orgId),
      history: history.recent().filter((e) => e.orgId === orgId),
    });

    socket.on("close", () => {
      /* ไม่มีอะไรต้องเคลียร์นอกจาก entry ใน WeakMap ซึ่ง GC จัดการเองอยู่แล้ว */
    });
  });

  const onAgentUpdate = (agent: AgentSummary) => broadcast(wss, socketOrg, agent.orgId, { type: "agent_update", agent });
  const onHistoryEntry = (entry: HistoryEntry) => broadcast(wss, socketOrg, entry.orgId, { type: "history_entry", entry });
  const onCommandOutput = (evt: { orgId: string; agentId: string; payload: CommandOutputPayload }) =>
    broadcast(wss, socketOrg, evt.orgId, { type: "command_output", agentId: evt.agentId, output: evt.payload });
  registry.on("update", onAgentUpdate);
  history.on("entry", onHistoryEntry);
  registry.on("command_output", onCommandOutput);

  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => {
    clearInterval(heartbeatTimer);
    registry.off("update", onAgentUpdate);
    history.off("entry", onHistoryEntry);
    registry.off("command_output", onCommandOutput);
  });

  log.info("dashboard ws: listening at /ws/dashboard");
  return wss;
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

// ส่งถึงเฉพาะ socket ที่ org ของ session ตัวเองตรงกับ org ของ event เท่านั้น —
// ดู doc comment ของ socketOrg ด้านบนว่าทำไมถึงต้องมีสิ่งนี้
function broadcast(wss: WebSocketServer, socketOrg: WeakMap<WebSocket, string>, orgId: string, msg: unknown): void {
  const raw = JSON.stringify(msg);
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN && socketOrg.get(socket) === orgId) socket.send(raw);
  }
}
