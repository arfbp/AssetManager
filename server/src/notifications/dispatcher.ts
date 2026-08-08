// Fans one NotificationEvent out to every configured channel. Each channel
// is independently try/caught — a dead Slack webhook or unreachable SMTP
// host must never stop the other channels from firing, and must never
// throw back into the caller (alert/incident handling paths that call this
// are fire-and-forget, same as db/persistence.ts's own writes).
import { log } from "../logger.js";
import type { NotifyConfig, NotificationEvent } from "./types.js";
import { sendSlack } from "./channels/slack.js";
import { sendTeams } from "./channels/teams.js";
import { sendEmail } from "./channels/email.js";

export function notifyAll(cfg: NotifyConfig, event: NotificationEvent): void {
  if (cfg.slackWebhookUrl) {
    sendSlack(cfg.slackWebhookUrl, event).catch((err) => log.warn({ err, channel: "slack", event }, "notify: slack delivery failed"));
  }
  if (cfg.teamsWebhookUrl) {
    sendTeams(cfg.teamsWebhookUrl, event).catch((err) => log.warn({ err, channel: "teams", event }, "notify: teams delivery failed"));
  }
  if (cfg.email) {
    sendEmail(cfg.email, event).catch((err) => log.warn({ err, channel: "email", event }, "notify: email delivery failed"));
  }
}
