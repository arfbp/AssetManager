// Plain SMTP via nodemailer — works with any provider (a company mail
// server, Gmail with an app password, SendGrid/Mailgun's SMTP endpoints,
// ...), so this doesn't lock the deployment into one vendor's API the way
// the LINE Notify / Slack / Teams integrations do.
import nodemailer from "nodemailer";
import type { EmailConfig, NotificationEvent } from "../types.js";

const SEVERITY_LABEL: Record<NotificationEvent["severity"], string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

export async function sendEmail(cfg: EmailConfig, event: NotificationEvent): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });

  await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: `[OptiFleet AI] ${SEVERITY_LABEL[event.severity]}: ${event.agentId}`,
    text: event.message,
  });
}
