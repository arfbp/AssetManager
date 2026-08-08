// Loads and validates environment configuration. Fails closed: missing
// security-relevant settings throw at startup rather than silently running
// with defaults an operator didn't choose.
import "dotenv/config";
import type { NotifyConfig } from "./notifications/types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`config: missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  ws: {
    port: number;
    tlsCertPath: string | null;
    tlsKeyPath: string | null;
    /** host:port agents should use to reach GET /agent-download/exe on this
     * same agent-hub listener (self-update — see ws/server.ts) — the
     * externally-reachable address, which the server has no way to know on
     * its own (it only knows the port it's listening on, not what host an
     * agent out on the internet actually dials to reach it). Must match
     * whatever host agent.yaml's server.url already points at. */
    publicHost: string;
  };
  http: {
    port: number;
    /** Origins the browser dashboard is allowed to call the REST API from (CORS). */
    dashboardOrigins: string[];
    /** Suffix (e.g. ".27-254-142-51.sslip.io" today, ".optifleet.ai" once
     * Phase 6's real domain is live) that ANY org's subdomain is allowed to
     * call the API from, on top of the fixed dashboardOrigins list above —
     * one shared frontend build serves every org's subdomain (see
     * frontend/src/lib/session.ts's currentOrgSubdomain, which needs the
     * matching NEXT_PUBLIC_ORG_DOMAIN_SUFFIX at build time), so hand-
     * listing each org's exact origin here isn't workable. Null disables
     * this (every non-listed origin still gets rejected as normal). */
    orgDomainSuffix: string | null;
    /** TLS for the browser-facing REST API + dashboard WebSocket
     * (index.ts/ws/dashboardServer.ts) — previously plain HTTP/WS
     * regardless of this setting, unlike the agent hub which always had
     * its own TLS option. Defaults to the SAME cert/key already configured
     * for the agent hub (`ws.tlsCertPath`/`tlsKeyPath`) if the
     * OPTIFLEET_HTTP_TLS_* vars aren't set separately — one cert covering
     * both is the common case, but a real deployment terminating the
     * browser side behind a public domain's cert while agents use an
     * internal one can still point these at a different file. */
    tlsCertPath: string | null;
    tlsKeyPath: string | null;
  };
  hmacSecret: string;
  deviceGroupsPath: string;
  /** Every agent build ever pushed, plus which one is "active" — see
   * agentBuilds.ts's AgentBuildRegistry. Rolling back to an older version
   * or rolling forward to a newer one is just changing activeVersion; no
   * server restart needed. */
  agentBuildsDir: string;
  /** Fleet's desired agent.yaml — see agentConfig.ts's loadDesiredAgentConfig
   * and ws/registry.ts's needsConfigUpdate. Optional: no file there yet just
   * means config-push convergence stays disabled, not a startup failure. */
  agentConfigTemplatePath: string;
  /** Where admin-uploaded custom installers (Software Deploy page's "upload
   * your own installer" path) are stored — see api/routes.ts's
   * POST /software-uploads and ws/server.ts's GET /agent-download/custom/:id.
   * Distinct from the per-org installer .zip (that's the agent's own build
   * artifact, generated on demand); this directory holds arbitrary
   * third-party installer files an admin has chosen to push to a device. */
  customInstallersDir: string;
  /** Per-org cap on customInstallersDir's total accumulated size (not a
   * per-file cap — POST /software-uploads already caps a single file at
   * 300MB regardless of this setting). Without this, one org uploading
   * enough installers over time could fill the VPS disk for every tenant. */
  customInstallersMaxBytesPerOrg: number;
  /** Everything a per-org installer .zip needs EXCEPT the agent binary
   * itself (that always comes fresh from agentBuildsDir's active build, so
   * a generated installer never ships a stale exe) and the credentials
   * (generated per-org, never stored on disk) — agent.yaml, nssm.exe,
   * optifleet-cert.pem, README.txt, RUN-ME.bat, and install.ps1 as a
   * template with an `__ENV_BLOCK__` placeholder. See
   * orgs/installerGenerator.ts and GET /api/orgs/:id/installer. */
  agentInstallerTemplateDir: string;
  enableRunScriptDispatch: boolean;
  isProduction: boolean;
  /** Postgres connection string. Required — user accounts and sessions
   * (src/auth/) are stored in Postgres, not memory, so real login has
   * nowhere to live without it. Telemetry/command history persistence
   * (src/db/persistence.ts) rides along on the same connection. */
  databaseUrl: string;
  /** Outbound alert notifications (Slack/Teams/email) — see notifications/.
   * Every channel is independently optional; all-unset just means nothing
   * is sent anywhere and alerts only show up in the dashboard, same as
   * before this existed. */
  notifications: NotifyConfig;
}

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === "production";

  const tlsCertPath = process.env.OPTIFLEET_TLS_CERT_PATH || null;
  const tlsKeyPath = process.env.OPTIFLEET_TLS_KEY_PATH || null;
  const httpTlsCertPath = process.env.OPTIFLEET_HTTP_TLS_CERT_PATH || tlsCertPath;
  const httpTlsKeyPath = process.env.OPTIFLEET_HTTP_TLS_KEY_PATH || tlsKeyPath;

  if (isProduction && (!tlsCertPath || !tlsKeyPath)) {
    throw new Error(
      "config: NODE_ENV=production requires OPTIFLEET_TLS_CERT_PATH and " +
        "OPTIFLEET_TLS_KEY_PATH — refusing to serve plaintext ws:// to agents in production",
    );
  }
  if (isProduction && (!httpTlsCertPath || !httpTlsKeyPath)) {
    throw new Error(
      "config: NODE_ENV=production requires OPTIFLEET_HTTP_TLS_CERT_PATH and " +
        "OPTIFLEET_HTTP_TLS_KEY_PATH (or the OPTIFLEET_TLS_* pair to reuse the agent hub's cert) — " +
        "refusing to serve the dashboard API/login over plaintext http:// in production",
    );
  }

  const wsPort = Number(optional("OPTIFLEET_WS_PORT", "8443"));
  return {
    ws: {
      port: wsPort,
      tlsCertPath,
      tlsKeyPath,
      publicHost: optional("OPTIFLEET_WS_PUBLIC_HOST", `localhost:${wsPort}`),
    },
    http: {
      port: Number(optional("OPTIFLEET_HTTP_PORT", "8080")),
      dashboardOrigins: optional("OPTIFLEET_DASHBOARD_ORIGIN", "http://localhost:3000")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      orgDomainSuffix: optional("OPTIFLEET_ORG_DOMAIN_SUFFIX", "") || null,
      tlsCertPath: httpTlsCertPath,
      tlsKeyPath: httpTlsKeyPath,
    },
    hmacSecret: required("OPTIFLEET_HMAC_SECRET"),
    deviceGroupsPath: optional("OPTIFLEET_DEVICE_GROUPS_PATH", "./config/device-groups.json"),
    agentBuildsDir: optional("OPTIFLEET_AGENT_BUILDS_DIR", "./downloads/agent-builds"),
    agentConfigTemplatePath: optional("OPTIFLEET_AGENT_CONFIG_TEMPLATE_PATH", "./config/agent-config-template.yaml"),
    customInstallersDir: optional("OPTIFLEET_CUSTOM_INSTALLERS_DIR", "./downloads/custom-installers"),
    customInstallersMaxBytesPerOrg: Number(optional("OPTIFLEET_CUSTOM_INSTALLERS_MAX_MB_PER_ORG", "2048")) * 1024 * 1024,
    agentInstallerTemplateDir: optional("OPTIFLEET_AGENT_INSTALLER_TEMPLATE_DIR", "./agent-installer-template"),
    enableRunScriptDispatch: optional("OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH", "false") === "true",
    isProduction,
    databaseUrl: required("OPTIFLEET_DATABASE_URL"),
    notifications: loadNotifyConfig(),
  };
}

function loadNotifyConfig(): NotifyConfig {
  const emailHost = process.env.OPTIFLEET_NOTIFY_EMAIL_HOST || "";
  return {
    slackWebhookUrl: process.env.OPTIFLEET_NOTIFY_SLACK_WEBHOOK || null,
    teamsWebhookUrl: process.env.OPTIFLEET_NOTIFY_TEAMS_WEBHOOK || null,
    email: emailHost
      ? {
          host: emailHost,
          port: Number(optional("OPTIFLEET_NOTIFY_EMAIL_PORT", "587")),
          user: optional("OPTIFLEET_NOTIFY_EMAIL_USER", ""),
          pass: optional("OPTIFLEET_NOTIFY_EMAIL_PASS", ""),
          from: optional("OPTIFLEET_NOTIFY_EMAIL_FROM", "OptiFleet AI <noreply@optifleet.local>"),
          to: optional("OPTIFLEET_NOTIFY_EMAIL_TO", "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : null,
  };
}
