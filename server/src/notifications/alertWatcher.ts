// คอยดู event "update" ของ registry (fire ทุกครั้งที่ heartbeat/telemetry
// เปลี่ยนสถานะ) เพื่อจับ edge-triggered transition สองแบบที่ระบบแจ้งเตือน
// สนใจ: อุปกรณ์ offline/กลับมา online และ telemetry เข้า/ออกจาก alert mode
// (CPU/RAM เกิน threshold) ทั้งสองแบบ diff กับสถานะที่เคยเห็นล่าสุดที่เก็บไว้
// ที่นี่ ไม่ได้ derive จาก snapshot เดียว — "update" fire ทุก heartbeat ไม่ว่า
// จะมีอะไรเปลี่ยนจริงหรือไม่ ถ้าไม่มีส่วนนี้ อุปกรณ์ที่ค้างอยู่ใน alert mode
// จะแจ้งเตือนซ้ำทุกรอบ poll แทนที่จะแจ้งแค่ครั้งเดียวตอนเปลี่ยนสถานะ
import type { AgentRegistry, AgentSummary } from "../ws/registry.js";
import { notifyAll } from "./dispatcher.js";
import type { NotifyConfig } from "./types.js";

// คีย์ด้วย "orgId:agentId" ไม่ใช่ agentId เปล่าๆ — agentId เป็นแค่ OS hostname
// ของเครื่อง (เช่น "DESKTOP-001") ซึ่งไม่ unique ข้าม org (เหตุผลเดียวกับ
// mapKey ใน ws/registry.ts และ agentKey/incidentKey ใน db/persistence.ts)
// ถ้าคีย์ด้วย agentId อย่างเดียว การเปลี่ยนสถานะของ org หนึ่งจะบัง หรือ
// trigger การแจ้งเตือนของอีก org ที่มี hostname เดียวกันแบบผิดๆ ได้ — เช่น
// DESKTOP-001 ของ Org A เข้า alert mode จะทำให้ DESKTOP-001 ของ Org B ที่เข้า
// alert mode ทีหลังดูเหมือนไม่มีอะไรเปลี่ยนเลย ทำให้การแจ้งเตือนจริงของ
// Org B หายไปแบบเงียบๆ
function trackerKey(orgId: string, agentId: string): string {
  return `${orgId}:${agentId}`;
}

export function wireNotifications(registry: AgentRegistry, cfg: NotifyConfig): void {
  const previousStatus = new Map<string, AgentSummary["status"]>();
  const previousMode = new Map<string, "normal" | "alert">();

  registry.on("update", (summary: AgentSummary) => {
    const key = trackerKey(summary.orgId, summary.agentId);
    const prevStatus = previousStatus.get(key);
    if (prevStatus !== undefined && prevStatus !== summary.status) {
      notifyAll(cfg, {
        kind: summary.status === "offline" ? "device_offline" : "device_online",
        agentId: summary.agentId,
        message: summary.status === "offline" ? `${summary.agentId} went offline.` : `${summary.agentId} is back online.`,
        severity: summary.status === "offline" ? "warning" : "info",
      });
    }
    previousStatus.set(key, summary.status);

    const mode = summary.lastTelemetry?.mode;
    if (mode) {
      const prevMode = previousMode.get(key);
      if (prevMode !== undefined && prevMode !== mode) {
        notifyAll(cfg, {
          kind: mode === "alert" ? "resource_alert" : "resource_recovered",
          agentId: summary.agentId,
          message:
            mode === "alert"
              ? `${summary.agentId} entered alert mode (CPU ${summary.lastTelemetry!.cpu_percent.toFixed(0)}%, RAM ${summary.lastTelemetry!.mem_percent.toFixed(0)}%).`
              : `${summary.agentId} resource usage is back to normal.`,
          severity: mode === "alert" ? "critical" : "info",
        });
      }
      previousMode.set(key, mode);
    }
  });
}
