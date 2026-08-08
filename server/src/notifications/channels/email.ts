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

function createTransport(cfg: EmailConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

export async function sendEmail(cfg: EmailConfig, event: NotificationEvent): Promise<void> {
  const transport = createTransport(cfg);

  await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: `[OptiFleet AI] ${SEVERITY_LABEL[event.severity]}: ${event.agentId}`,
    text: event.message,
  });
}

// Distinct from sendEmail above: a transactional, per-recipient message
// (one new org admin's setup link) rather than a fan-out alert to the
// fixed ops recipient list in cfg.to — reuses the same SMTP transport/host
// config, but the "to" address is per-call, not from EmailConfig.
export async function sendSetupLinkEmail(cfg: EmailConfig, to: string, orgName: string, setupLink: string): Promise<void> {
  const transport = createTransport(cfg);

  await transport.sendMail({
    from: cfg.from,
    to,
    subject: `Welcome to OptiFleet AI — set up your ${orgName} account`,
    text: `You've been added as an admin for "${orgName}" on OptiFleet AI.\n\nSet your password to finish setting up your account:\n${setupLink}\n\nThis link expires in 7 days.`,
  });
}
