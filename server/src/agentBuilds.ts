// Tracks every agent build ever pushed to this server, not just the newest
// one — supersedes the old agentBuild.ts's "latest build" snapshot, which
// only ever knew about whatever exe happened to sit at downloads/
// optifleet-agent.exe (rolling back meant an operator manually copying an
// older exe over that path by hand and restarting the server). This module
// keeps every uploaded build under downloads/agent-builds/, in a small
// manifest.json recording which version is "active" — the one the whole
// fleet converges to (see ws/registry.ts's needsUpdate). Activating a
// different version is instant (no server restart): everything that reads
// the active build goes through getActive() on this same in-memory
// instance, never a value captured once at startup.
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

  /** What every connected agent should converge to right now — see
   * ws/server.ts's maybeOfferUpdate and the /agent-download/exe route.
   * Always reads the CURRENT manifest state, so a setActive() takes effect
   * on an agent's very next heartbeat, not after a server restart. */
  getActive(): ActiveAgentBuild | null {
    if (!this.manifest.activeVersion) return null;
    const b = this.manifest.builds.find((x) => x.version === this.manifest.activeVersion);
    if (!b) return null;
    return { version: b.version, sha256: b.sha256, exePath: path.join(this.dir, b.filename) };
  }

  /** Stores a new build under this version, computed from the exe's own
   * bytes rather than trusting a caller-supplied hash — re-uploading the
   * same version replaces its file/hash (e.g. fixing a bad upload) but
   * never silently changes activeVersion. */
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

  /** Rollback (an older version) and roll-forward (the newest) are the same
   * operation here — see ws/registry.ts's needsUpdate doc comment on why
   * this whole fleet is convergence-based rather than "newer wins": there
   * is no ordering to agent version strings this system trusts. */
  async setActive(version: string): Promise<void> {
    if (!this.manifest.builds.some((b) => b.version === version)) {
      throw new Error(`unknown build version "${version}"`);
    }
    this.manifest.activeVersion = version;
    await this.persist();
    log.info({ version }, "agentBuilds: active version changed");
  }
}
