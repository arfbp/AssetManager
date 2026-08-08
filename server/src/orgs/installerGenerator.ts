// Builds a per-org agent installer .zip on demand — everything in
// agentInstallerTemplateDir (agent.yaml, nssm.exe, optifleet-cert.pem,
// README.txt, RUN-ME.bat, and install.ps1 as a template) is identical for
// every org (the agent-hub connection target and its bundled trust cert
// don't vary per org — only the credentials presented over that connection
// do, see the multi-tenant migration plan's Phase 7), plus the currently
// active agent binary (always fresh, never a stale copy baked into the
// template — see agentBuilds.ts's AgentBuildRegistry), plus this one org's
// own generated agent_auth_token/agent_hmac_secret substituted into
// install.ps1's `__ENV_BLOCK__` placeholder.
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import type { Response } from "express";

export interface InstallerSource {
  templateDir: string;
  agentExePath: string;
}

// Same NSSM AppEnvironmentExtra format as the original static
// dist-agent-deploy-global/install.ps1 this template was copied from —
// backtick-n is PowerShell's own newline escape inside a double-quoted
// string, not a literal two-character sequence.
function buildEnvBlock(agentAuthToken: string, agentHmacSecret: string): string {
  return `OPTIFLEET_AUTH_TOKEN=${agentAuthToken}\`nOPTIFLEET_HMAC_SECRET=${agentHmacSecret}`;
}

// Streams the zip directly to the HTTP response rather than building it in
// memory first — an installer package is tens of MB (mostly the agent exe),
// no reason to hold the whole thing in a Buffer when archiver can pipe it.
export function streamOrgInstallerZip(
  res: Response,
  source: InstallerSource,
  orgSubdomain: string,
  agentAuthToken: string,
  agentHmacSecret: string,
): void {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err: Error) => {
    // Only safe to surface as a normal error response if nothing has been
    // written yet — once streaming starts, headers are already sent.
    if (!res.headersSent) res.status(500).json({ error: `installer generation failed: ${err.message}` });
  });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="OptiFleet-Agent-${orgSubdomain}-Deploy.zip"`);
  archive.pipe(res);

  const installPs1Template = readFileSync(path.join(source.templateDir, "install.ps1"), "utf8");
  const envBlock = buildEnvBlock(agentAuthToken, agentHmacSecret);
  // .replace with a function (not the plain string form) — agentHmacSecret
  // is attacker-uncontrolled but still opaque random hex, and the plain-
  // string replacement form treats "$&"/"$1"-shaped substrings in the
  // replacement specially, which a function-form replacement never does.
  const installPs1 = installPs1Template.replace("__ENV_BLOCK__", () => envBlock);
  archive.append(installPs1, { name: "install.ps1" });

  for (const file of ["agent.yaml", "nssm.exe", "optifleet-cert.pem", "README.txt", "RUN-ME.bat"]) {
    archive.file(path.join(source.templateDir, file), { name: file });
  }
  archive.append(createReadStream(source.agentExePath), { name: "optifleet-agent.exe" });

  archive.finalize();
}
