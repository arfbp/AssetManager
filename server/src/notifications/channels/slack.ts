// Slack Incoming Webhooks — a stable, still-supported Slack feature (unlike
// Teams' old Office 365 Connectors, see teams.ts). Create one at
// https://api.slack.com/messaging/webhooks and set OPTIFLEET_NOTIFY_SLACK_WEBHOOK.
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
