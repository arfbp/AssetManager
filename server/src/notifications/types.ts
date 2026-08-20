// รูปร่างของ config การแจ้งเตือนขาออก + event — ดู dispatcher.ts สำหรับ
// logic การกระจาย และ channels/ สำหรับแต่ละ integration แต่ละ channel
// เป็น optional แยกอิสระ: webhook URL/SMTP host ที่ไม่ได้ตั้งค่าแปลว่า
// channel นั้นถูกข้ามไป ไม่ใช่ error (ส่วนใหญ่ deployment จะอยากใช้แค่หนึ่ง
// หรือสอง channel เท่านั้น ไม่ใช่ทั้งหมด)
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
