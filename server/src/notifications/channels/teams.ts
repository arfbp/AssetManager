// Microsoft Teams. Flagging this honestly rather than pretending it's a
// simple stable webhook: Microsoft has been retiring the old Office 365
// Connector "Incoming Webhook" in favor of Power Automate Workflows — an
// existing Connector URL may already be dead by the time this runs, and new
// channels are pushed toward creating a "Workflow" (Teams channel → ... →
// Workflows → "Post to a channel when a webhook request is received")
// instead. Both mechanisms are "POST JSON to a URL", so this sender works
// for either — the payload below uses the classic MessageCard shape for a
// legacy Connector; if you're setting up a new Workflow instead, build its
// flow to read the same `text` field (or adjust the flow's schema to match
// whatever this sends) since Power Automate defines its own expected
// request-body schema per flow, not a fixed format.
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
