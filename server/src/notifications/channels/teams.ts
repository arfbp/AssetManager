// Microsoft Teams บอกตามตรงตรงนี้แทนที่จะทำเหมือนเป็น webhook ที่เสถียรง่ายๆ:
// Microsoft กำลังทยอยเลิก Office 365 Connector "Incoming Webhook" เดิม
// หันไปใช้ Power Automate Workflows แทน — URL ของ Connector ที่มีอยู่อาจตาย
// ไปแล้วตอนที่โค้ดนี้รัน และ channel ใหม่ๆ ถูกผลักดันให้สร้าง "Workflow"
// แทน (Teams channel → ... → Workflows → "Post to a channel when a webhook
// request is received") ทั้งสองกลไกเป็น "POST JSON ไปยัง URL" เหมือนกัน
// ดังนั้น sender ตัวนี้ใช้ได้กับทั้งคู่ — payload ด้านล่างใช้รูปแบบ
// MessageCard แบบคลาสสิกสำหรับ Connector เก่า ถ้าจะตั้ง Workflow ใหม่แทน
// ให้ตั้ง flow ให้อ่าน field `text` เดียวกันนี้ (หรือปรับ schema ของ flow
// ให้ตรงกับสิ่งที่ส่งมา) เพราะ Power Automate กำหนด schema ของ request body
// เองต่อ flow ไม่ใช่รูปแบบตายตัว
import type { NotificationEvent } from "../types.js";

const SEVERITY_COLOR: Record<NotificationEvent["severity"], string> = {
  info: "0078D4",
  warning: "FFA500",
  critical: "D03B3B",
};

export async function sendTeams(webhookUrl: string, event: NotificationEvent): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      themeColor: SEVERITY_COLOR[event.severity],
      summary: `OptiFleet AI: ${event.agentId}`,
      title: `OptiFleet AI — ${event.agentId}`,
      text: event.message,
    }),
  });
  if (!res.ok) {
    throw new Error(`teams webhook responded ${res.status}: ${await res.text().catch(() => "")}`);
  }
}
