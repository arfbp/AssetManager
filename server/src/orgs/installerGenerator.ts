// สร้าง .zip ตัวติดตั้ง agent เฉพาะ org แบบ on demand — ทุกอย่างใน
// agentInstallerTemplateDir (agent.yaml, nssm.exe, optifleet-cert.pem,
// README.txt, RUN-ME.bat และ install.ps1 ในฐานะ template) เหมือนกันทุก org
// (ปลายทางเชื่อมต่อ agent-hub และ trust cert ที่แนบมาไม่ต่างกันตาม org —
// ต่างกันแค่ credential ที่ใช้ตอนเชื่อมต่อเท่านั้น ดู Phase 7 ของแผน
// multi-tenant migration) บวกกับ agent binary ตัวที่ใช้งานอยู่ปัจจุบัน (สดใหม่
// เสมอ ไม่ใช่สำเนาเก่าที่ฝังไว้ใน template — ดู AgentBuildRegistry ใน
// agentBuilds.ts) บวกกับ agent_auth_token/agent_hmac_secret ที่สร้างขึ้นเอง
// ของ org นี้ที่ถูกแทนที่ลงใน placeholder `__ENV_BLOCK__` ของ install.ps1
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import type { Response } from "express";

export interface InstallerSource {
  templateDir: string;
  agentExePath: string;
}

// รูปแบบ NSSM AppEnvironmentExtra เดียวกับ install.ps1 แบบ static ตัวต้นฉบับ
// ใน dist-agent-deploy-global ที่ template นี้ก็อปมา — backtick-n คือ escape
// สำหรับขึ้นบรรทัดใหม่ของ PowerShell เองภายใน double-quoted string ไม่ใช่
// ตัวอักษรสองตัวตรง ๆ
function buildEnvBlock(agentAuthToken: string, agentHmacSecret: string): string {
  return `OPTIFLEET_AUTH_TOKEN=${agentAuthToken}\`nOPTIFLEET_HMAC_SECRET=${agentHmacSecret}`;
}

// สตรีม zip ตรงไปยัง HTTP response แทนที่จะสร้างในหน่วยความจำก่อน —
// installer package มีขนาดหลายสิบ MB (ส่วนใหญ่คือตัว agent exe) ไม่มีเหตุผล
// ต้องเก็บทั้งก้อนไว้ใน Buffer ในเมื่อ archiver pipe ได้เลย
export function streamOrgInstallerZip(
  res: Response,
  source: InstallerSource,
  orgSubdomain: string,
  agentAuthToken: string,
  agentHmacSecret: string,
): void {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err: Error) => {
    // ปลอดภัยที่จะส่งกลับเป็น error response ปกติได้ก็ต่อเมื่อยังไม่มีอะไรถูก
    // เขียนออกไปเลยเท่านั้น — พอเริ่มสตรีมแล้ว header จะถูกส่งไปแล้ว
    if (!res.headersSent) res.status(500).json({ error: `installer generation failed: ${err.message}` });
  });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="OptiFleet-Agent-${orgSubdomain}-Deploy.zip"`);
  archive.pipe(res);

  const installPs1Template = readFileSync(path.join(source.templateDir, "install.ps1"), "utf8");
  const envBlock = buildEnvBlock(agentAuthToken, agentHmacSecret);
  // ใช้ .replace แบบส่ง function เข้าไป (ไม่ใช่ string ตรง ๆ) — แม้
  // agentHmacSecret จะไม่ได้มาจากผู้โจมตี แต่ก็ยังเป็น hex สุ่มแบบ opaque
  // และ replacement แบบ string ตรง ๆ จะตีความ substring รูปแบบ "$&"/"$1"
  // เป็นพิเศษ ซึ่ง replacement แบบ function ไม่มีทางทำแบบนั้น
  const installPs1 = installPs1Template.replace("__ENV_BLOCK__", () => envBlock);
  archive.append(installPs1, { name: "install.ps1" });

  for (const file of ["agent.yaml", "nssm.exe", "optifleet-cert.pem", "README.txt", "RUN-ME.bat"]) {
    archive.file(path.join(source.templateDir, file), { name: file });
  }
  archive.append(createReadStream(source.agentExePath), { name: "optifleet-agent.exe" });

  archive.finalize();
}
