// เซ็นคำสั่งด้วย HMAC-SHA256 บนรูปแบบ canonical ที่เข้ารหัสแบบ netstring —
// ตรงนี้ต้องตรงกับ CommandPayload.CanonicalString() ของ
// internal/transport/protocol.go ฝั่ง Go agent แบบ byte ต่อ byte เป๊ะ ๆ
// ไม่งั้นทุกคำสั่งจะถูกปฏิเสธเพราะลายเซ็นไม่ตรงกัน
//
// ทำไมถึงใช้ netstring ("<byte-length>:<bytes>") แทน JSON: รูปแบบ canonical
// ที่อิง JSON ต้องทำให้พฤติกรรม json.Marshal ของ Go ตรงกันแบบ byte ต่อ byte
// เป๊ะ ๆ — รวมถึงการ escape `<`, `>`, `&` เป็น HTML โดย default ด้วย ถึงจะได้
// ลายเซ็นเดียวกันข้ามภาษา นี่คือกับดักจริง ๆ สำหรับ field อย่าง `script` ของ
// run_script ที่มีเนื้อหา shell/PowerShell แบบอิสระซึ่งมีอักขระพวกนี้ปนอยู่ได้
// การเข้ารหัสแบบระบุความยาวนำหน้าไม่ต้อง escape อะไรเลย: แต่ละ token ประกาศ
// ความยาว byte ของตัวเองไว้ ดังนั้นการต่อกันจึงไม่กำกวมไม่ว่า string จะมี
// เนื้อหาอะไรก็ตาม
import { createHmac } from "node:crypto";
import type { CommandAction } from "../protocol.js";

function netstring(s: string): string {
  const byteLength = Buffer.byteLength(s, "utf8");
  return `${byteLength}:${s}`;
}

export interface UnsignedCommand {
  id: string;
  action: CommandAction;
  params: Record<string, string>;
  issuedAtUnix: number;
}

export function canonicalString(cmd: UnsignedCommand): string {
  const sortedKeys = Object.keys(cmd.params).sort();
  let paramsBlob = "";
  for (const key of sortedKeys) {
    paramsBlob += netstring(key) + netstring(cmd.params[key] ?? "");
  }

  return (
    netstring(cmd.id) +
    netstring(cmd.action) +
    netstring(String(cmd.issuedAtUnix)) +
    netstring(paramsBlob)
  );
}

export function signCommand(cmd: UnsignedCommand, hmacSecret: string): string {
  const mac = createHmac("sha256", hmacSecret);
  mac.update(canonicalString(cmd), "utf8");
  return mac.digest("hex");
}

// สะท้อนรูปแบบเดียวกับ SelfUpdatePayload.canonicalString ของ
// internal/transport/protocol.go — ต้องตรงกับ Go implementation นั้นแบบ
// byte ต่อ byte เหมือน canonicalString ด้านบน ตั้งใจแยกเป็นฟังก์ชันต่างหาก
// แทนที่จะใช้โครงสร้างเดียวกับ UnsignedCommand: คำสั่ง self-update ไม่มี
// field params/action และการแยกโครงสร้างให้ต่างกันชัดเจนก็เป็นการเตือนเล็ก ๆ
// ว่านี่เซ็นข้อความอีกประเภทที่เชื่อถือได้แคบกว่า (ดู doc comment ของ
// SelfUpdatePayload ใน protocol.ts)
export interface UnsignedSelfUpdate {
  version: string;
  url: string;
  sha256: string;
  issuedAtUnix: number;
}

export function signSelfUpdate(payload: UnsignedSelfUpdate, hmacSecret: string): string {
  const canonical =
    netstring(payload.version) + netstring(payload.url) + netstring(payload.sha256) + netstring(String(payload.issuedAtUnix));
  const mac = createHmac("sha256", hmacSecret);
  mac.update(canonical, "utf8");
  return mac.digest("hex");
}

// สะท้อนรูปแบบเดียวกับ ConfigUpdatePayload.canonicalString ของ
// internal/transport/protocol.go — ต้องตรงกับ Go implementation นั้นแบบ
// byte ต่อ byte เป๊ะ ๆ
export interface UnsignedConfigUpdate {
  configYaml: string;
  configSha256: string;
  enableRunScript: boolean;
  issuedAtUnix: number;
}

export function signConfigUpdate(payload: UnsignedConfigUpdate, hmacSecret: string): string {
  const canonical =
    netstring(payload.configYaml) +
    netstring(payload.configSha256) +
    netstring(String(payload.enableRunScript)) +
    netstring(String(payload.issuedAtUnix));
  const mac = createHmac("sha256", hmacSecret);
  mac.update(canonical, "utf8");
  return mac.digest("hex");
}
