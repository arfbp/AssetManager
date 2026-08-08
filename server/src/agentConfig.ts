// Reads the fleet's desired agent.yaml (config/agent-config-template.yaml)
// so ws/server.ts can compare its hash against what each connected agent
// reports in its own heartbeat and push a config_update when they differ —
// the same convergence model agentBuilds.ts uses for the binary itself
// (though that one no longer needs a restart to change — see its own doc
// comment). Loaded once at server startup, not per-heartbeat: a template
// change here still means restarting the server, so re-reading at startup
// is the natural place for this.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { log } from "./logger.js";

export interface DesiredAgentConfig {
  yaml: string;
  sha256: string;
  // Derived from the template itself (whether "run_script" appears in its
  // commands.allowed list) rather than a separate toggle to remember to
  // flip — see internal/configpush's doc comment on ConfigUpdatePayload for
  // why this is a fixed literal rather than a generic flag/value.
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
