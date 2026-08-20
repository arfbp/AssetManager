// อ่านไฟล์ agent.yaml ที่ fleet ต้องการ (config/agent-config-template.yaml)
// เพื่อให้ ws/server.ts เอา hash ของมันไปเทียบกับที่ agent แต่ละตัวรายงานมาใน
// heartbeat ของตัวเอง แล้ว push config_update ออกไปเมื่อค่าไม่ตรงกัน — โมเดล
// convergence แบบเดียวกับที่ agentBuilds.ts ใช้กับตัว binary เอง (แต่ตัวนั้น
// ไม่ต้อง restart แล้วเมื่อเปลี่ยนค่า — ดู doc comment ของมันเอง) โหลดครั้งเดียว
// ตอนเซิร์ฟเวอร์ start ไม่ใช่ทุก heartbeat: การแก้ template ยังต้อง restart
// เซิร์ฟเวอร์อยู่ดี ดังนั้นอ่านใหม่ตอน startup จึงเป็นจุดที่เหมาะสมที่สุด
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { log } from "./logger.js";

export interface DesiredAgentConfig {
  yaml: string;
  sha256: string;
  // มาจากตัว template เอง (เช็คว่ามี "run_script" อยู่ใน list ของ
  // commands.allowed หรือไม่) แทนที่จะเป็น toggle แยกที่ต้องคอยจำไปเปิด — ดู
  // doc comment ของ ConfigUpdatePayload ใน internal/configpush ว่าทำไมค่านี้
  // ถึงเป็น literal คงที่แทนที่จะเป็น flag/value ทั่วไป
  enableRunScript: boolean;
}

const RUN_SCRIPT_LIST_ITEM = /^\s*-\s*run_script\s*$/m;

export async function loadDesiredAgentConfig(templatePath: string): Promise<DesiredAgentConfig | null> {
  let yaml: string;
  try {
    yaml = await readFile(templatePath, "utf8");
  } catch {
    log.info({ templatePath }, "agentConfig: no template file found — config-push disabled");
    return null;
  }
  if (!yaml.trim()) {
    log.warn({ templatePath }, "agentConfig: template file is empty — config-push disabled");
    return null;
  }

  const sha256 = createHash("sha256").update(yaml, "utf8").digest("hex");
  const enableRunScript = RUN_SCRIPT_LIST_ITEM.test(yaml);

  log.info({ sha256, enableRunScript }, "agentConfig: desired agent config loaded");
  return { yaml, sha256, enableRunScript };
}
