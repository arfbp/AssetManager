// เชื่อม in-memory live-state store สองตัว (AgentRegistry,
// CommandHistoryStore) เข้ากับที่เก็บถาวรใน Postgres โดย subscribe
// EventEmitter event ชุดเดียวกับที่ ws/dashboardServer.ts ใช้ push อัปเดตสดๆ
// ไปยัง browser client อยู่แล้ว นี่คือ add-on แบบบริสุทธิ์: ไม่มีอะไรใน
// ws/server.ts, api/routes.ts หรือ ws/dispatch.ts ที่ต้องแก้เพื่อให้ได้
// persistence มา
//
// การเขียนเป็นแบบ fire-and-forget และทุก failure ถูกดักจับและ log ไว้ ไม่มี
// การ throw เลย — DB ที่ล่มต้อง degrade ลงเป็น "snapshot/entry นี้ไม่ได้
// persist" เท่านั้น ต้องไม่ทำให้การจัดการ agent สดๆ หรือการ dispatch คำสั่ง
// หยุดทำงานตาม ซึ่งทั้งสองอย่างนี้ต้องทำงานต่อไปได้ไม่ว่า Postgres จะเข้าถึง
// ได้หรือไม่
import type { Pool } from "pg";
import { log } from "../logger.js";
import type { AgentRegistry, AgentSummary } from "../ws/registry.js";
import type { CommandHistoryStore, HistoryEntry } from "../history/commandHistory.js";
import type { TelemetrySnapshot } from "../protocol.js";
import { nextAssetTag, createAsset, findUnlinkedAssetBySerial, findPeripheralAssetBySerial } from "../assets/assetsStore.js";
import { openIncident, resolveIncident } from "../incidents/incidentsStore.js";
import { findOpenConnection, closeConnection, openConnection } from "../assets/connectionHistoryStore.js";
import { notifyAll } from "../notifications/dispatcher.js";
import type { NotifyConfig } from "../notifications/types.js";

// ค่า serial ที่ OEM บางเจ้า ship มาแบบตัวอักษรตรงๆ แทนที่จะเป็น serial จริง
// (พบบ่อยบนเครื่อง desktop ที่ประกอบเองไม่มี BIOS serial ที่ OEM programme
// ไว้) — ยืนยันจากเครื่องทดสอบจริงแล้ว (Win32_BIOS.SerialNumber = "To Be
// Filled By O.E.M.") ดังนั้นค่าพวกนี้ต้องไม่ถูกถือว่าเป็น identifier จริง
// สำหรับการ match เด็ดขาด ไม่งั้นทุกเครื่องที่ BIOS serial ว่างเปล่าจะถูก
// merge เข้าเป็น asset เดียวกันแบบผิดๆ
const PLACEHOLDER_SERIALS = new Set([
  "to be filled by o.e.m.",
  "system serial number",
  "default string",
  "none",
  "n/a",
  "",
]);

function isRealSerial(serial: string | null | undefined): serial is string {
  if (!serial) return false;
  return !PLACEHOLDER_SERIALS.has(serial.trim().toLowerCase());
}

export function wirePersistence(pool: Pool, registry: AgentRegistry, history: CommandHistoryStore, notifyCfg: NotifyConfig): void {
  registry.on("update", (summary: AgentSummary) => {
    upsertAgent(pool, summary).catch((err) =>
      log.error({ err, orgId: summary.orgId, agentId: summary.agentId }, "db: failed to persist agent state"),
    );
    ensureAssetForAgent(pool, summary).catch((err) =>
      log.error({ err, orgId: summary.orgId, agentId: summary.agentId }, "db: failed to auto-register asset for agent"),
    );
    trackResourceAlerts(pool, summary);
  });

  registry.on("telemetry", ({ orgId, agentId, snapshot }: { orgId: string; agentId: string; snapshot: TelemetrySnapshot }) => {
    insertTelemetry(pool, orgId, agentId, snapshot).catch((err) =>
      log.error({ err, orgId, agentId }, "db: failed to persist telemetry snapshot"),
    );
    trackHungProcesses(pool, orgId, agentId, snapshot, notifyCfg).catch((err) =>
      log.error({ err, orgId, agentId }, "db: failed to track hung-process incidents"),
    );
    trackPeripheralConnections(pool, orgId, agentId, snapshot).catch((err) =>
      log.error({ err, orgId, agentId }, "db: failed to track peripheral connection history"),
    );
  });

  history.on("entry", (entry: HistoryEntry) => {
    upsertHistoryEntry(pool, entry).catch((err) =>
      log.error({ err, orgId: entry.orgId, commandId: entry.commandId }, "db: failed to persist command history entry"),
    );
  });
}

interface AgentRow {
  org_id: string;
  agent_id: string;
  status: string;
  connected_at: Date;
  last_seen_at: Date;
  last_telemetry: TelemetrySnapshot | null;
  remote_ip: string | null;
}

// Warm-start สำเนาในหน่วยความจำของ AgentRegistry จากที่เก็บถาวรตอน startup —
// ดู doc comment ของ AgentRegistry.hydrate เองว่าทำไมเรื่องนี้ถึงสำคัญ (การ
// restart เคยทำให้ lastTelemetry/remoteIp กลายเป็น null สำหรับอุปกรณ์ที่
// สุขภาพดีจนกว่าจะถึงรอบ poll ครั้งถัดไป ซึ่งอาจนานถึง 5 นาที) `status` จาก
// แถวข้อมูลถูกละเลยไว้โดยตั้งใจตรงนี้ — hydrate() จะ seed เป็น "offline"
// เสมอไม่ว่าอะไรจะเกิดขึ้น เพราะ process นี้ยังไม่เคยเห็น connection จริงๆ
export async function loadPersistedAgents(pool: Pool): Promise<AgentSummary[]> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT org_id, agent_id, status, connected_at, last_seen_at, last_telemetry, remote_ip FROM agents`,
  );
  return rows.map((r) => ({
    orgId: r.org_id,
    agentId: r.agent_id,
    status: "offline",
    connectedAt: r.connected_at.getTime(),
    lastSeenAt: r.last_seen_at.getTime(),
    lastTelemetry: r.last_telemetry,
    remoteIp: r.remote_ip,
    // ไม่ได้ persist ไว้ที่ไหนเลย — จะถูกเติมกลับจาก heartbeat ครั้งถัดไปของ
    // agent เองหลัง reconnect เหมือนกับทุก field อื่นในที่นี้ที่ "ไม่รู้
    // จนกว่าข้อมูลใหม่จะมาถึง"
    version: null,
    configHash: null,
  }));
}

async function upsertAgent(pool: Pool, s: AgentSummary): Promise<void> {
  await pool.query(
    `INSERT INTO agents (org_id, agent_id, status, connected_at, last_seen_at, last_telemetry, remote_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, agent_id) DO UPDATE SET
       status = EXCLUDED.status,
       connected_at = EXCLUDED.connected_at,
       last_seen_at = EXCLUDED.last_seen_at,
       last_telemetry = EXCLUDED.last_telemetry,
       remote_ip = COALESCE(EXCLUDED.remote_ip, agents.remote_ip)`,
    [
      s.orgId,
      s.agentId,
      s.status,
      new Date(s.connectedAt),
      new Date(s.lastSeenAt),
      s.lastTelemetry ? JSON.stringify(s.lastTelemetry) : null,
      s.remoteIp,
    ],
  );
}

// อุปกรณ์ทุกตัวที่เคย connect จะกลายเป็น asset โดยอัตโนมัติ — สิ่งที่
// operator ต้องการจริงๆ คือ "อุปกรณ์ที่ติดตั้งไปแล้ว ก็คือ asset เลย ไม่ต้อง
// ให้ฉันมานั่งลงทะเบียนเอง" รันทุกครั้งที่มี "update" event ของ agent (บ่อย
// มาก — ทุก heartbeat/telemetry) ดังนั้นจึงเขียนให้เป็น no-op ที่ต้นทุนต่ำเมื่อ
// asset มีอยู่แล้ว แทนที่จะเป็นสิ่งที่ควรรันแค่ครั้งเดียว UNIQUE constraint
// บน assets(org_id, agent_id) ยังช่วยให้การสร้างซ้ำพร้อมกัน (สอง event แข่ง
// กันก่อนที่ตัวไหนจะ commit) resolve ได้อย่างปลอดภัย — ตัวหนึ่งชนะ อีกตัว
// insert ล้มเหลวและถูกกลืนไว้ตรงนี้แทนที่จะ log เป็น error จริง เพราะ "มีคน
// อื่นสร้างไปแล้ว" ไม่ใช่ความล้มเหลว
async function ensureAssetForAgent(pool: Pool, summary: AgentSummary): Promise<void> {
  const { orgId, agentId } = summary;
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM assets WHERE org_id = $1 AND agent_id = $2) AS exists`,
    [orgId, agentId],
  );
  if (rows[0]?.exists) return;

  // ยังไม่มี telemetry (agent เพิ่ง connect snapshot ยังมาไม่ถึง) — ข้ามไป
  // ก่อน แทนที่จะสร้าง shell เปล่าๆ ขึ้นมา การมาถึงของ telemetry จะ trigger
  // "update" event ตัวนี้ซ้ำอีกครั้ง ดังนั้นจะ retry เองอัตโนมัติเมื่อรู้
  // serial แล้วจริงๆ
  if (!summary.lastTelemetry) return;

  const serial = summary.lastTelemetry.serial_number;
  if (isRealSerial(serial)) {
    const matchedTag = await findUnlinkedAssetBySerial(pool, orgId, serial);
    if (matchedTag) {
      await pool.query(`UPDATE assets SET agent_id = $1, status = 'deployed', updated_at = now() WHERE org_id = $2 AND asset_tag = $3`, [
        agentId,
        orgId,
        matchedTag,
      ]);
      log.info({ orgId, agentId, assetTag: matchedTag, serial }, "assets: merged newly connected device into pre-registered asset by serial number");
      return;
    }
  }

  const assetTag = await nextAssetTag(pool, orgId);
  try {
    await createAsset(pool, orgId, assetTag, {
      agentId,
      status: "deployed",
      manualSerialNumber: isRealSerial(serial) ? serial : null,
    });
    log.info({ orgId, agentId, assetTag }, "assets: auto-registered newly connected device");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      return; // แพ้ race ให้ event อื่นที่เกิดพร้อมกัน — asset มีอยู่แล้วไม่ว่าจะทางไหน
    }
    throw err;
  }
}

async function insertTelemetry(pool: Pool, orgId: string, agentId: string, snapshot: TelemetrySnapshot): Promise<void> {
  await pool.query(
    `INSERT INTO telemetry_snapshots
       (org_id, agent_id, recorded_at, mode, cpu_percent, mem_percent, mem_used_mb, mem_total_mb, snapshot)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9)`,
    [
      orgId,
      agentId,
      snapshot.timestamp,
      snapshot.mode,
      snapshot.cpu_percent,
      snapshot.mem_percent,
      snapshot.mem_used_mb,
      snapshot.mem_total_mb,
      JSON.stringify(snapshot),
    ],
  );
}

// (orgId, agentId) -> id ของแถว device_incidents ประเภท "resource_alert" ที่
// เปิดอยู่ตอนนี้ และ -> mode ล่าสุดที่เห็น — pattern edge-triggered-transition
// เดียวกับที่ notifications/alertWatcher.ts ใช้อยู่แล้ว ("update" event ของ
// registry ยิงทุก heartbeat ไม่ว่า mode จะเปลี่ยนจริงหรือไม่ ดังนั้นถ้าไม่ diff
// กับ mode ก่อนหน้า จะเปิด incident ใหม่ทุกรอบ poll ตลอดเวลาที่อุปกรณ์อยู่ใน
// alert mode แทนที่จะเปิดแค่ครั้งเดียวต่อ episode) แยกจาก previousMode map
// ของ alertWatcher เอง — notifications กับ incident logging เป็นคนละเรื่อง
// กันที่บังเอิญ subscribe event เดียวกัน อยู่ในหน่วยความจำเท่านั้น ข้อควร
// ระวังเดียวกับ openHangIncidents ด้านล่าง: เซิร์ฟเวอร์ restart จะทำให้เสีย
// ร่องรอยของ episode ที่เปิดอยู่ ดังนั้นอุปกรณ์ที่ยังอยู่ใน alert mode หลัง
// restart จะได้แถว incident ใหม่แทนที่จะกลับไปที่แถวเดิม คีย์ด้วย org+agent
// (ไม่ใช่ agent อย่างเดียว) เพื่อไม่ให้ agent ของสอง org ที่แชร์ hostname
// เดียวกันชนกันใน tracker พวกนี้
const openAlertIncidents = new Map<string, number>();
const previousAlertMode = new Map<string, "normal" | "alert">();

function agentKey(orgId: string, agentId: string): string {
  return `${orgId}:${agentId}`;
}

// เดิมที Alert mode (CPU/RAM เกิน threshold ที่ agent ตั้งค่าไว้) จะไปถึง
// operator แค่ในรูปแบบ badge ชั่วคราวบน dashboard และแจ้งเตือนออกไปทาง
// Slack/Teams/email (ถ้าตั้งค่าไว้) เท่านั้น — ไม่มีอะไร persist ไว้เลย
// จึงไม่มีทางย้อนกลับไปดูได้ว่า *ทำไม* อุปกรณ์ถึงถูกตีธง หรือแม้แต่ว่ามันเคย
// ถูกตีธงมาก่อนหรือไม่ ส่วนนี้ทำให้มันได้บันทึก "Incidents" แบบถาวรเหมือนกับ
// ที่การตรวจจับ process-hang ได้อยู่แล้ว พร้อมตัวเลข CPU/RAM จริงในข้อความ —
// สาเหตุจริง ไม่ใช่แค่ "alert mode" เฉยๆ เพราะค่า threshold ของ agent เองไม่
// เคยส่งมาถึงเซิร์ฟเวอร์เลย (มีแค่ mode flag ที่เป็นผลลัพธ์เท่านั้นที่ส่งมา)
function trackResourceAlerts(pool: Pool, summary: AgentSummary): void {
  const mode = summary.lastTelemetry?.mode;
  if (!mode) return;
  const key = agentKey(summary.orgId, summary.agentId);
  const prevMode = previousAlertMode.get(key);
  previousAlertMode.set(key, mode);
  if (prevMode === undefined || prevMode === mode) return; // ไม่มีการเปลี่ยนสถานะ (หรือเป็นครั้งแรกที่เห็น agent นี้)

  if (mode === "alert") {
    const snap = summary.lastTelemetry!;
    openIncident(
      pool,
      summary.orgId,
      summary.agentId,
      "resource_alert",
      `Entered alert mode — CPU ${snap.cpu_percent.toFixed(0)}%, RAM ${snap.mem_percent.toFixed(0)}%`,
    )
      .then((id) => openAlertIncidents.set(key, id))
      .catch((err) => log.error({ err, orgId: summary.orgId, agentId: summary.agentId }, "incidents: failed to open resource_alert incident"));
  } else {
    const id = openAlertIncidents.get(key);
    if (id === undefined) return;
    openAlertIncidents.delete(key);
    resolveIncident(pool, id).catch((err) =>
      log.error({ err, orgId: summary.orgId, agentId: summary.agentId }, "incidents: failed to resolve resource_alert incident"),
    );
  }
}

// (orgId, agentId, pid, name) -> id ของแถว device_incidents ที่เปิดอยู่
// เพื่อให้ process ที่ยัง hang ต่อเนื่องข้ามหลายรอบ poll อัปเดต episode
// เดียวกัน แทนที่จะสแปมแถวใหม่ทุกๆ ~5-10 วินาที อยู่ในหน่วยความจำเท่านั้น:
// เซิร์ฟเวอร์ restart จะทำให้เสียร่องรอยของ episode ที่เปิดอยู่ ซึ่งแปลว่า
// process ที่ยัง hang จะได้แถว incident ใหม่ในรอบ poll ถัดไปแทนที่จะกลับไป
// ที่แถวเดิม — โอเคสำหรับสิ่งนี้ (feed กิจกรรมล่าสุด) ไม่ใช่ audit log ถาวร
// ที่ต้องการ guarantee เข้มกว่านี้
const openHangIncidents = new Map<string, number>();

function incidentKey(orgId: string, agentId: string, pid: number, name: string): string {
  return `${orgId} ${agentId} ${pid} ${name}`;
}

async function trackHungProcesses(
  pool: Pool,
  orgId: string,
  agentId: string,
  snapshot: TelemetrySnapshot,
  notifyCfg: NotifyConfig,
): Promise<void> {
  const hungProcs = snapshot.top_processes.filter((p) => !p.responding);
  const hungKeys = new Set(hungProcs.map((p) => incidentKey(orgId, agentId, p.pid, p.name)));

  for (const proc of hungProcs) {
    const key = incidentKey(orgId, agentId, proc.pid, proc.name);
    if (openHangIncidents.has(key)) continue;
    const id = await openIncident(pool, orgId, agentId, "process_not_responding", `${proc.name} (PID ${proc.pid}) stopped responding`);
    openHangIncidents.set(key, id);
    log.warn({ orgId, agentId, pid: proc.pid, name: proc.name }, "incidents: process not responding");
    notifyAll(notifyCfg, {
      kind: "process_not_responding",
      agentId,
      message: `${proc.name} (PID ${proc.pid}) stopped responding.`,
      severity: "warning",
    });
  }

  const prefix = `${orgId} ${agentId} `;
  for (const [key, id] of [...openHangIncidents.entries()]) {
    if (!key.startsWith(prefix) || hungKeys.has(key)) continue;
    await resolveIncident(pool, id);
    openHangIncidents.delete(key);
  }
}

// จดจำได้เมื่อ peripheral asset ที่ลงทะเบียนไว้แล้ว (match ด้วย serial ที่
// กรอกเองด้วยมือ) โผล่มาใน connected_devices ของ snapshot แล้วคอยซิงค์
// asset_connection_history — และ assets.parent_agent_id ที่เก็บไว้เป็น "ตัว
// ล่าสุดที่เห็น" สำหรับ tree view ในหน้า Asset Registry — ให้ตรงกับว่ามัน
// เสียบอยู่ที่ไหนจริงๆ ตอนนี้ นี่คือส่วนที่จับได้ว่าจอมอนิเตอร์ถูกย้ายไป
// คอมพิวเตอร์เครื่องอื่น: ทันทีที่ serial ของมันโผล่มาใน connected_devices
// ของ agent ตัวอื่นที่ไม่ใช่ตัวที่ history episode ที่เปิดอยู่ตอนนี้บอกไว้
// episode นั้นจะถูกปิดและเปิด episode ใหม่กับ agent ตัวใหม่แทน
async function trackPeripheralConnections(pool: Pool, orgId: string, agentId: string, snapshot: TelemetrySnapshot): Promise<void> {
  for (const device of snapshot.connected_devices) {
    if (!device.serial_number) continue;
    const asset = await findPeripheralAssetBySerial(pool, orgId, device.serial_number);
    if (!asset) continue; // ยังไม่ได้ลงทะเบียนเป็น asset — ยังไม่มีอะไรต้อง track

    const open = await findOpenConnection(pool, orgId, asset.assetTag);
    if (open?.agentId === agentId) continue; // track ไว้ถูกต้องอยู่แล้ว ไม่ต้องทำอะไร

    if (open) {
      await closeConnection(pool, orgId, asset.assetTag, open.agentId);
    }
    await openConnection(pool, orgId, asset.assetTag, agentId);

    if (asset.parentAgentId !== agentId) {
      await pool.query(`UPDATE assets SET parent_agent_id = $1, updated_at = now() WHERE org_id = $2 AND asset_tag = $3`, [
        agentId,
        orgId,
        asset.assetTag,
      ]);
    }
    log.info({ orgId, assetTag: asset.assetTag, agentId, previousAgentId: open?.agentId ?? null }, "assets: peripheral connection tracked");
  }
}

interface CommandHistoryRow {
  command_id: string;
  org_id: string;
  agent_id: string;
  action: string;
  params: Record<string, string>;
  requested_by: string;
  source_text: string | null;
  status: string;
  message: string | null;
  dispatched_at: Date;
  resolved_at: Date | null;
}

// Warm-start สำเนาในหน่วยความจำของ CommandHistoryStore จากที่เก็บถาวรตอน
// startup — ดู doc comment ของ CommandHistoryStore.hydrate เองว่าทำไมเรื่อง
// นี้ถึงสำคัญ (การ restart เคยทำให้หน้า dashboard/AI console/แท็บ Commands
// ว่างเปล่าไป ทั้งที่ตารางนี้เองไม่เคยได้รับผลกระทบเลย) เรียงจากเก่าไปใหม่
// ให้ตรงกับ input ที่ hydrate คาดหวัง
export async function loadRecentHistory(pool: Pool, limit = 500): Promise<HistoryEntry[]> {
  const { rows } = await pool.query<CommandHistoryRow>(
    `SELECT command_id, org_id, agent_id, action, params, requested_by, source_text, status, message, dispatched_at, resolved_at
     FROM command_history ORDER BY dispatched_at DESC LIMIT $1`,
    [limit],
  );
  return rows.reverse().map((r) => ({
    commandId: r.command_id,
    orgId: r.org_id,
    agentId: r.agent_id,
    action: r.action as HistoryEntry["action"],
    params: r.params,
    requestedBy: r.requested_by,
    sourceText: r.source_text,
    status: r.status as HistoryEntry["status"],
    message: r.message,
    dispatchedAt: r.dispatched_at.getTime(),
    resolvedAt: r.resolved_at ? r.resolved_at.getTime() : null,
  }));
}

async function upsertHistoryEntry(pool: Pool, e: HistoryEntry): Promise<void> {
  await pool.query(
    `INSERT INTO command_history
       (org_id, command_id, agent_id, action, params, requested_by, source_text, status, message, dispatched_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (command_id) DO UPDATE SET
       status = EXCLUDED.status,
       message = EXCLUDED.message,
       resolved_at = EXCLUDED.resolved_at`,
    [
      e.orgId,
      e.commandId,
      e.agentId,
      e.action,
      JSON.stringify(e.params),
      e.requestedBy,
      e.sourceText,
      e.status,
      e.message,
      new Date(e.dispatchedAt),
      e.resolvedAt ? new Date(e.resolvedAt) : null,
    ],
  );
}
