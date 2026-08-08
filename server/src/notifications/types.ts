// Outbound notification config + event shape — see dispatcher.ts for the
// fan-out logic and channels/ for each integration. Every channel is
// independently optional: an unset webhook URL/SMTP host just means that
// channel is skipped, not an error (most deployments will only want one or
// two of these, not all).
export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string[];
}

export interface NotifyConfig {
  slackWebhookUrl: string | null;
  teamsWebhookUrl: string | null;
  email: EmailConfig | null;
}

export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationEvent {
  kind: string;
  agentId: string;
  message: string;
  severity: NotificationSeverity;
}
