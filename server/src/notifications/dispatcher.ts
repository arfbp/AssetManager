// กระจาย NotificationEvent หนึ่งอันไปยังทุก channel ที่ตั้งค่าไว้ แต่ละ
// channel try/catch แยกจากกัน — Slack webhook ที่ตายหรือ SMTP host ที่
// เข้าไม่ถึงต้องไม่ทำให้ channel อื่นหยุดทำงานตาม และต้อง throw กลับไปหา
// ผู้เรียกไม่ได้เด็ดขาด (path ที่เรียกใช้ฟังก์ชันนี้ในการจัดการ
// alert/incident เป็นแบบ fire-and-forget เหมือนกับที่ db/persistence.ts
// เขียนข้อมูลของตัวเอง)
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
