// Registry ของ agent ในหน่วยความจำ registry แบบ single-process คือจุดเริ่มต้น
// ที่เหมาะสมสำหรับเซิร์ฟเวอร์อินสแตนซ์เดียว การ scale ไปหลาย process ของ
// เซิร์ฟเวอร์ต้องมี registry ที่ใช้ร่วมกัน (เช่น Redis) อยู่หลัง interface
// เดียวกันนี้ — ดูหัวข้อ "Scaling beyond one instance" ใน server/README.md
//
// Agent ไม่เคยถูกลบออกทั้งหมดตอน disconnect — จะเปลี่ยนสถานะเป็น "offline"
// และเก็บ telemetry ล่าสุดที่รู้ไว้ นั่นคือสิ่งที่ทำให้ dashboard แสดงอุปกรณ์
// ที่ตอนนี้เข้าถึงไม่ได้แทนที่จะหายไปจาก list เฉยๆ ซึ่งสำคัญสำหรับหน้าจอ
// ops/monitoring มากกว่าการประหยัดหน่วยความจำเปล่าๆ (fleet มีจำนวนอุปกรณ์ที่
// จำกัดและรู้ล่วงหน้า)
//
// ทุกการ lookup/mutation ที่นี่ใช้ orgId คู่กับ agentId เสมอ — agentId
// อย่างเดียวคือแค่ OS hostname ของเครื่อง (ดู os.Hostname() ใน
// cmd/agent/main.go) ซึ่งไม่ unique ข้าม organization ของลูกค้า
// ("DESKTOP-001" เป็น hostname ที่ Windows auto-generate บ่อยมาก) Map key
// ภายในคือ composite ของทั้งสองตัว (mapKey ด้านล่าง) เพื่อให้ agent ของสอง
// org ที่บังเอิญมี hostname ซ้ำกันอยู่ร่วมกันได้อย่างปลอดภัย แทนที่ตัวหนึ่งจะ
// เขียนทับ connection state ของอีกตัวแบบเงียบๆ
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { log } from "../logger.js";
import type { CommandOutputPayload, CommandPayload, ConfigUpdatePayload, SelfUpdatePayload, TelemetrySnapshot } from "../protocol.js";

export type AgentStatus = "online" | "offline";

export interface AgentSummary {
  orgId: string;
  agentId: string;
  status: AgentStatus;
  connectedAt: number;
  lastSeenAt: number;
  lastTelemetry: TelemetrySnapshot | null;
  /** IP ที่ WebSocket connection ปัจจุบัน (หรือล่าสุด) มาจาก — ดู connection
   * handler ใน ws/server.ts เป็น null เฉพาะ agent ที่ server process นี้ไม่เคย
   * เห็นการ connect จริงๆ (เช่น restore มาจาก DB ตอน startup ก่อนที่
   * persistence.ts จะถูก wire — ดูตอนสร้าง registry) */
  remoteIp: string | null;
  /** จาก heartbeat ของ agent เอง (internal/version.Version) — null สำหรับ
   * agent build ที่เก่าจนมาก่อนมี version reporting หรือตัวที่ยังไม่ได้ส่ง
   * heartbeat เลยใน connection นี้ เทียบกับ "build ล่าสุดที่มี" ของเซิร์ฟเวอร์
   * เอง (ดู AgentBuildRegistry.getActive() ใน index.ts's agentBuilds.ts)
   * เพื่อตัดสินใจว่าจะ push self_update หรือไม่ */
  version: string | null;
  /** จาก heartbeat ของ agent เอง (SHA256 ของ agent.yaml ที่ใช้งานอยู่ — ดู
   * internal/configpush) — null สำหรับ agent build ที่เก่าจนมาก่อนมี
   * config-hash reporting หรือตัวที่ยังไม่ได้ส่ง heartbeat เลยใน connection
   * นี้ เทียบกับ config ที่เซิร์ฟเวอร์ต้องการเอง (ดู loadDesiredAgentConfig
   * ใน agentConfig.ts) เพื่อตัดสินใจว่าจะ push config_update หรือไม่ */
  configHash: string | null;
}

interface AgentConnection extends AgentSummary {
  socket: WebSocket | null;
  /** ถูก set เมื่อมีการ push self_update ให้กับ version ที่ CURRENTLY-reported
   * ของ connection นี้แล้ว เพื่อไม่ให้ agent ที่ยังไม่ได้ reconnect และช้าใน
   * การ apply update (หรือตัวที่ update ล้มเหลวจริงๆ) ถูกส่งคำสั่งเดิมซ้ำทุก
   * heartbeat จะถูกล้างเมื่อ version ที่ agent รายงานเปลี่ยนไปจริงๆ */
  updateOfferedForVersion: string | null;
  /** เหตุผลเดียวกับ updateOfferedForVersion แต่สำหรับการ push config_update —
   * ล้างเมื่อ configHash ที่ agent รายงานเปลี่ยนไปจริงๆ */
  configUpdateOfferedForHash: string | null;
}

function mapKey(orgId: string, agentId: string): string {
  return `${orgId}:${agentId}`;
}

function toSummary(c: AgentConnection): AgentSummary {
  return {
    orgId: c.orgId,
    agentId: c.agentId,
    status: c.status,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
    lastTelemetry: c.lastTelemetry,
    remoteIp: c.remoteIp,
    version: c.version,
    configHash: c.configHash,
  };
}

/**
 * Emit "update" พร้อม {@link AgentSummary} ทุกครั้งที่ state เปลี่ยน (connect,
 * disconnect, heartbeat, telemetry) — dashboard WebSocket server
 * (ws/dashboardServer.ts) subscribe ตัวนี้เพื่อ push อัปเดตสดๆ ไปยัง browser
 * client ที่เชื่อมต่ออยู่โดยไม่ต้อง poll
 */
export class AgentRegistry extends EventEmitter {
  private readonly agents = new Map<string, AgentConnection>();

  register(orgId: string, agentId: string, socket: WebSocket, remoteIp: string | null): void {
    const key = mapKey(orgId, agentId);
    const existing = this.agents.get(key);
    if (existing?.socket && existing.socket !== socket) {
      // Connection ใหม่จาก agent ID เดิมจะแทนที่ตัวเก่า — socket เก่าที่ค้าง
      // อยู่จะถูกปิดแทนที่จะทิ้งไว้เป็น entry ซอมบี้ที่ไม่มีใครดูแล
      log.warn({ orgId, agentId }, "registry: replacing existing connection for agent");
      existing.socket.close(1000, "superseded by new connection");
    }
    const now = Date.now();
    const conn: AgentConnection = {
      orgId,
      agentId,
      status: "online",
      socket,
      connectedAt: now,
      lastSeenAt: now,
      lastTelemetry: existing?.lastTelemetry ?? null, // ส่งต่อ telemetry ล่าสุดที่รู้ข้าม reconnect
      remoteIp: remoteIp ?? existing?.remoteIp ?? null,
      version: existing?.version ?? null,
      updateOfferedForVersion: existing?.updateOfferedForVersion ?? null,
      configHash: existing?.configHash ?? null,
      configUpdateOfferedForHash: existing?.configUpdateOfferedForHash ?? null,
    };
    this.agents.set(key, conn);
    this.emit("update", toSummary(conn));
  }

  unregister(orgId: string, agentId: string, socket: WebSocket): void {
    const key = mapKey(orgId, agentId);
    const existing = this.agents.get(key);
    // เปลี่ยนเป็น offline เฉพาะกรณีที่ call นี้เป็นของ socket ที่ลงทะเบียน
    // อยู่ปัจจุบันเท่านั้น — close event ของ connection เก่าที่ยิงมาหลังจาก
    // reconnect ไปแล้วต้องไม่ทำให้ connection ใหม่กลายเป็น offline
    if (existing && existing.socket === socket) {
      existing.status = "offline";
      existing.socket = null;
      this.emit("update", toSummary(existing));
    }
  }

  touch(orgId: string, agentId: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn) {
      conn.lastSeenAt = Date.now();
      this.emit("update", toSummary(conn));
    }
  }

  /** บันทึก version ที่ agent รายงานมาเองจาก heartbeat — ดู
   * AgentSummary.version รีเซ็ต updateOfferedForVersion ทุกครั้งที่ version
   * ที่รายงานมาเปลี่ยนไปจริงๆ (version ใหม่แปลว่าการติดตาม "offer ไปแล้ว"
   * ในอดีตใช้ไม่ได้กับมันอีกต่อไป) */
  recordVersion(orgId: string, agentId: string, version: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn && conn.version !== version) {
      conn.version = version;
      conn.updateOfferedForVersion = null;
      this.emit("update", toSummary(conn));
    }
  }

  /** True ถ้า connection นี้ไม่ได้รัน latestVersion และยังไม่เคยถูก offer
   * update สำหรับ version ปัจจุบันของมัน
   *
   * ตั้งใจทำเป็นการเช็คความไม่เท่ากัน ไม่ใช่ "เก่ากว่า" — version string
   * ในที่นี้เป็นค่า opaque (internal/version.Version, bump มือ ไม่ได้ parse
   * แบบ semver) และโมเดล convergence ของ fleet คือ "build ไหนก็ตามที่อยู่ใน
   * โฟลเดอร์ downloads/ ของเซิร์ฟเวอร์คือตัวที่ถูกต้อง" ให้ agent ทุกตัว match
   * เข้าหามันไม่ว่าจะทิศทางไหน นั่นคือสิ่งที่ทำให้ rollback โดยตั้งใจทำได้:
   * เอา build เก่ากลับไปวางใน downloads/ restart เซิร์ฟเวอร์ แล้ว agent ทุกตัว
   * จะ downgrade ให้ตรงกัน — เป็นความสามารถที่มีประโยชน์จริง ไม่ใช่แค่ side
   * effect ที่ต้องระวัง ตัว guard จริงๆ ตรงนี้คือ updateOfferedForVersion:
   * มันหยุดไม่ให้ self_update ตัวเดิมถูกส่งซ้ำทุก heartbeat ในขณะที่ตัวหนึ่ง
   * กำลัง mid-flight หรือล้มเหลวไปแล้วครั้งหนึ่ง (ซึ่งต้องให้คนมาดู log ไม่ใช่
   * retry รัวๆ) — ไม่ใช่การเช็คลำดับ version เลย
   */
  needsUpdate(orgId: string, agentId: string, latestVersion: string): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn || !conn.version) return false;
    return conn.version !== latestVersion && conn.updateOfferedForVersion !== conn.version;
  }

  markUpdateOffered(orgId: string, agentId: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn) conn.updateOfferedForVersion = conn.version;
  }

  /** บันทึก config hash ที่ agent รายงานมาเองจาก heartbeat — ดู
   * AgentSummary.configHash รีเซ็ต configUpdateOfferedForHash ทุกครั้งที่
   * hash ที่รายงานมาเปลี่ยนไปจริงๆ เหตุผลเดียวกับ recordVersion */
  recordConfigHash(orgId: string, agentId: string, configHash: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn && conn.configHash !== configHash) {
      conn.configHash = configHash;
      conn.configUpdateOfferedForHash = null;
      this.emit("update", toSummary(conn));
    }
  }

  /** เหตุผล convergence เดียวกับ needsUpdate — เช็คความไม่เท่ากันกับ config
   * hash ที่เซิร์ฟเวอร์ต้องการ ไม่ใช่ "เก่ากว่า" (config hash ไม่มีลำดับใดๆ
   * เลย) configUpdateOfferedForHash คือ guard จริงตรงนี้ เหมือนกับ
   * updateOfferedForVersion ของ needsUpdate */
  needsConfigUpdate(orgId: string, agentId: string, desiredHash: string): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn || !conn.configHash) return false;
    return conn.configHash !== desiredHash && conn.configUpdateOfferedForHash !== conn.configHash;
  }

  markConfigUpdateOffered(orgId: string, agentId: string): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn) conn.configUpdateOfferedForHash = conn.configHash;
  }

  recordTelemetry(orgId: string, agentId: string, snapshot: TelemetrySnapshot): void {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (conn) {
      conn.lastTelemetry = snapshot;
      conn.lastSeenAt = Date.now();
      this.emit("update", toSummary(conn));
      // แยกจาก "update" เพื่อให้ listener ที่เก็บข้อมูลถาวร (db/persistence.ts)
      // เพิ่มแถว time-series ได้หนึ่งแถวต่อ snapshot โดยไม่ต้อง derive สิ่งนี้
      // จาก generic state-change event ที่ยิงตอน heartbeat ธรรมดาด้วยเช่นกัน
      this.emit("telemetry", { orgId, agentId, snapshot });
    }
  }

  /**
   * ส่งต่อผลลัพธ์ทีละส่วนของ streaming command (เช่น หนึ่ง hop ของ tracert)
   * ไปยังทุกอย่างที่กำลังฟังอยู่ — dashboard WebSocket server
   * (ws/dashboardServer.ts) ส่งต่อสิ่งนี้ไปยัง browser client ตรงๆ เพื่อให้
   * network_diagnostic ที่กำลังรันแสดงผลทีละบรรทัดแทนที่จะโผล่มาทีเดียวตอน
   * คำสั่งจบทั้งหมด แยกจาก "update"/"telemetry": นี่ไม่ใช่ agent state แต่
   * เป็น event ชั่วคราวที่ไม่มีค่าที่เก็บไว้ใน AgentConnection คู่กัน
   */
  recordCommandOutput(orgId: string, agentId: string, payload: CommandOutputPayload): void {
    this.emit("command_output", { orgId, agentId, payload });
  }

  // Warm-start registry ในหน่วยความจำนี้จาก durable storage (ตาราง agents
  // ของ Postgres — ดู loadPersistedAgents ใน db/persistence.ts) ทันทีหลัง
  // สร้าง ก่อนที่ agent จริงตัวไหนจะ reconnect ถ้าไม่มีส่วนนี้ ทุกครั้งที่
  // เซิร์ฟเวอร์ restart lastTelemetry/remoteIp จะกลายเป็น null จนกว่าจะถึงรอบ
  // poll ถัดไปของ agent นั้น (นานสุดถึง 5 นาทีตามช่วงปกติ) — แท็บ "Live" ของ
  // dashboard และคอลัมน์ CPU/RAM/storage/IP ของ Asset Registry ล้วนอ่านจาก
  // lastTelemetry ดังนั้นการ restart จะทำให้อุปกรณ์ที่สุขภาพดีและยังรายงานอยู่
  // ดูเหมือนไม่มีข้อมูลเลยในช่วงนั้น seed เป็น "offline" ไม่มี socket เสมอ
  // ไม่ว่า DB จะบอกอะไรไว้ก่อน restart — process นี้ยังไม่เคยเห็น connection
  // จริงๆ และ logic การส่งต่อค่าของ register() เอง
  // (`existing?.lastTelemetry ?? null`) จะอัปเกรดเป็น "online" พร้อม socket
  // จริงทันทีที่ agent นั้น reconnect เอง (พร้อม backoff) มาถึง เหมือนกับที่
  // มันทำอยู่แล้วสำหรับ reconnect ใน process เดียวกัน
  hydrate(agents: AgentSummary[]): void {
    for (const a of agents) {
      this.agents.set(mapKey(a.orgId, a.agentId), {
        ...a,
        status: "offline",
        socket: null,
        updateOfferedForVersion: null,
        configUpdateOfferedForHash: null,
      });
    }
  }

  isOnline(orgId: string, agentId: string): boolean {
    return this.agents.get(mapKey(orgId, agentId))?.status === "online";
  }

  /** Agent ทุกตัวที่เชื่อมต่ออยู่/รู้จักข้ามทุก org — ผู้เรียกที่ต้องไม่ให้ข้อมูล
   * รั่วข้าม tenant (การอ่านที่หน้าจอ dashboard ทุกจุด) ต้องกรอง result ด้วย
   * orgId เอง ตั้งใจไม่กรองไว้ตรงนี้ เพื่อให้ class นี้ยังคงเป็นแค่ที่เก็บ
   * connection state ธรรมดา ไม่ใช่ที่ที่ policy ของ tenant ต้องถูก duplicate
   * ให้ผู้เรียกทุกตัวในอนาคต */
  listAll(): AgentSummary[] {
    return [...this.agents.values()].map(toSummary);
  }

  getTelemetry(orgId: string, agentId: string): TelemetrySnapshot | null {
    return this.agents.get(mapKey(orgId, agentId))?.lastTelemetry ?? null;
  }

  /**
   * ส่งคำสั่งที่เซ็นแล้วไปยัง agent ตัวเดียว คืนค่า false (ไม่ throw) ถ้า
   * agent ไม่ได้เชื่อมต่ออยู่ตอนนี้ — ผู้เรียกเป็นคนตัดสินใจเองว่า target ที่
   * offline คือความล้มเหลวร้ายแรง หรือแค่สิ่งที่ต้องรายงานกลับไปให้ผู้เรียก
   */
  sendCommand(orgId: string, agentId: string, command: CommandPayload): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn?.socket || conn.socket.readyState !== conn.socket.OPEN) {
      return false;
    }
    conn.socket.send(JSON.stringify({ type: "command", payload: command }));
    return true;
  }

  /** ส่งคำสั่ง self_update ที่เซ็นแล้วไปยัง agent ตัวเดียว — เช็ค
   * connectivity แบบเดียวกับ sendCommand แต่แยก method ออกจากกันโดยโครงสร้าง
   * (ไม่ใช่ overload) เพื่อไม่ให้มีทางส่ง self_update ผ่าน code path ที่สร้าง
   * CommandPayload ได้เลย หรือในทางกลับกัน */
  sendSelfUpdate(orgId: string, agentId: string, payload: SelfUpdatePayload): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn?.socket || conn.socket.readyState !== conn.socket.OPEN) {
      return false;
    }
    conn.socket.send(JSON.stringify({ type: "self_update", payload }));
    return true;
  }

  /** ส่งคำสั่ง config_update ที่เซ็นแล้วไปยัง agent ตัวเดียว — เช็ค
   * connectivity และเหตุผลการแยกโครงสร้างเดียวกับ sendSelfUpdate */
  sendConfigUpdate(orgId: string, agentId: string, payload: ConfigUpdatePayload): boolean {
    const conn = this.agents.get(mapKey(orgId, agentId));
    if (!conn?.socket || conn.socket.readyState !== conn.socket.OPEN) {
      return false;
    }
    conn.socket.send(JSON.stringify({ type: "config_update", payload }));
    return true;
  }
}
