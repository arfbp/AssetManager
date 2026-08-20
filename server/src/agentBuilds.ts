// เก็บประวัติ agent build ทุกตัวที่เคย push เข้าเซิร์ฟเวอร์นี้ ไม่ใช่แค่ตัวล่าสุด
// — มาแทนที่ agentBuild.ts เดิมที่เก็บแค่ "build ล่าสุด" ตัวเดียว ซึ่งรู้จักแค่
// exe ที่อยู่ที่ downloads/optifleet-agent.exe ตัวเดียว (จะ rollback ทีต้องให้
// operator เอา exe เวอร์ชันเก่ามาก็อปทับ path นั้นเองแล้ว restart เซิร์ฟเวอร์)
// โมดูลนี้เก็บทุก build ที่อัปโหลดไว้ใต้ downloads/agent-builds/ พร้อม
// manifest.json บันทึกว่าเวอร์ชันไหน "active" อยู่ — เวอร์ชันที่ทั้ง fleet
// จะ converge เข้าหา (ดู ws/registry.ts ใน needsUpdate) การเปลี่ยน active
// version ทำได้ทันที (ไม่ต้อง restart เซิร์ฟเวอร์) เพราะทุกจุดที่อ่าน active
// build จะเรียกผ่าน getActive() บน instance เดียวกันในหน่วยความจำ ไม่ใช่ค่าที่
// จำไว้ตั้งแต่ตอน startup
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

export interface AgentBuildInfo {
  version: string;
  sha256: string;
  filename: string;
  uploadedAt: string; // ISO 8601
}

export interface ActiveAgentBuild {
  version: string;
  sha256: string;
  exePath: string;
}

interface Manifest {
  activeVersion: string | null;
  builds: AgentBuildInfo[];
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export class AgentBuildRegistry {
  private constructor(
    private readonly dir: string,
    private manifest: Manifest,
  ) {}

  static async load(dir: string): Promise<AgentBuildRegistry> {
    await mkdir(dir, { recursive: true });
    const manifestPath = path.join(dir, "manifest.json");
    let manifest: Manifest = { activeVersion: null, builds: [] };
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      log.info({ manifestPath }, "agentBuilds: no manifest yet — starting with an empty build history");
    }
    return new AgentBuildRegistry(dir, manifest);
  }

  private async persist(): Promise<void> {
    await writeFile(path.join(this.dir, "manifest.json"), JSON.stringify(this.manifest, null, 2));
  }

  list(): AgentBuildInfo[] {
    return [...this.manifest.builds].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  get activeVersion(): string | null {
    return this.manifest.activeVersion;
  }

  /** สิ่งที่ agent ทุกตัวที่เชื่อมต่ออยู่ควร converge เข้าหา ณ ตอนนี้ — ดู
   * ws/server.ts ใน maybeOfferUpdate และ route /agent-download/exe
   * อ่านค่าจาก manifest ปัจจุบันเสมอ ดังนั้น setActive() จะมีผลตั้งแต่
   * heartbeat ครั้งถัดไปของ agent เลย ไม่ต้องรอ restart เซิร์ฟเวอร์ */
  getActive(): ActiveAgentBuild | null {
    if (!this.manifest.activeVersion) return null;
    const b = this.manifest.builds.find((x) => x.version === this.manifest.activeVersion);
    if (!b) return null;
    return { version: b.version, sha256: b.sha256, exePath: path.join(this.dir, b.filename) };
  }

  /** เก็บ build ใหม่ภายใต้เวอร์ชันนี้ โดยคำนวณ hash จากไบต์จริงของ exe เอง
   * ไม่เชื่อ hash ที่ผู้เรียกส่งมา — การอัปโหลดเวอร์ชันเดิมซ้ำจะแทนที่ไฟล์/hash
   * เดิม (เช่น แก้ไขการอัปโหลดที่พัง) แต่จะไม่เปลี่ยน activeVersion ให้เองเงียบๆ */
  async addBuild(version: string, data: Buffer): Promise<AgentBuildInfo> {
    const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, "_");
    const filename = `optifleet-agent-${safeVersion}.exe`;
    const filePath = path.join(this.dir, filename);
    await writeFile(filePath, data);
    const sha256 = await sha256File(filePath);
    const info: AgentBuildInfo = { version, sha256, filename, uploadedAt: new Date().toISOString() };
    this.manifest.builds = this.manifest.builds.filter((b) => b.version !== version);
    this.manifest.builds.push(info);
    await this.persist();
    log.info({ version, sha256 }, "agentBuilds: new build stored");
    return info;
  }

  /** Rollback (ย้อนไปเวอร์ชันเก่า) กับ roll-forward (ไปเวอร์ชันล่าสุด) คือ
   * operation เดียวกันในที่นี้ — ดู doc comment ของ needsUpdate ใน
   * ws/registry.ts ว่าทำไม fleet ทั้งหมดถึงใช้โมเดล convergence แทนที่จะเป็น
   * "เวอร์ชันใหม่กว่าชนะ": ระบบนี้ไม่เชื่อลำดับของ version string ของ agent เลย */
  async setActive(version: string): Promise<void> {
    if (!this.manifest.builds.some((b) => b.version === version)) {
      throw new Error(`unknown build version "${version}"`);
    }
    this.manifest.activeVersion = version;
    await this.persist();
    log.info({ version }, "agentBuilds: active version changed");
  }
}
