// SMTP ธรรมดาผ่าน nodemailer — ใช้ได้กับผู้ให้บริการอีเมลไหนก็ได้ (mail
// server ของบริษัท, Gmail แบบ app password, SMTP endpoint ของ
// SendGrid/Mailgun ฯลฯ) จึงไม่ทำให้ deployment ผูกติดกับ API ของ vendor
// รายใดรายหนึ่งเหมือนที่ integration ของ LINE Notify / Slack / Teams เป็น
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

// แยกจาก sendEmail ด้านบน: เป็นข้อความแบบ transactional ต่อผู้รับรายคน
// (setup link ของ org admin คนใหม่) ไม่ใช่การแจ้งเตือนแบบ fan-out ไปยัง
// รายชื่อผู้รับ ops ตายตัวใน cfg.to — ใช้ SMTP transport/host config
// เดียวกันซ้ำ แต่ address "to" มาจากแต่ละ call ไม่ได้มาจาก EmailConfig
export async function sendSetupLinkEmail(cfg: EmailConfig, to: string, orgName: string, setupLink: string): Promise<void> {
  const transport = createTransport(cfg);

  await transport.sendMail({
    from: cfg.from,
    to,
    subject: `Welcome to OptiFleet AI — set up your ${orgName} account`,
    text: `You've been added as an admin for "${orgName}" on OptiFleet AI.\n\nSet your password to finish setting up your account:\n${setupLink}\n\nThis link expires in 7 days.`,
  });
}
