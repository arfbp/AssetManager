// Slack Incoming Webhooks — ฟีเจอร์ของ Slack ที่เสถียรและยังรองรับอยู่
// (ต่างจาก Office 365 Connectors เก่าของ Teams ดู teams.ts) สร้างได้ที่
// https://api.slack.com/messaging/webhooks แล้วตั้งค่า
// OPTIFLEET_NOTIFY_SLACK_WEBHOOK
import type { NotificationEvent } from "../types.js";

const SEVERITY_EMOJI: Record<NotificationEvent["severity"], string> = {
  info: ":information_source:",
  warning: ":warning:",
  critical: ":rotating_light:",
};

export async function sendSlack(webhookUrl: string, event: NotificationEvent): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `${SEVERITY_EMOJI[event.severity]} *${event.agentId}* — ${event.message}` }),
  });
  if (!res.ok) {
    throw new Error(`slack webhook responded ${res.status}: ${await res.text().catch(() => "")}`);
  }
}
