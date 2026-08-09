// REST client for the OptiFleet Central Server API. Every call sends the
// current per-user session token (src/lib/session.ts) — a real login
// session, not a shared static secret. "Who did this" (requestedBy) is no
// longer sent by the client at all; the server derives it from the session
// itself (server/src/api/routes.ts), so a client can't claim to be someone
// else's identity even if it wanted to.
import type { ApiErrorBody, CommandApiResponse, RemediationSuggestion, TelemetrySnapshot, ProcessInfo, HistoryPoint, AssetWithLiveInfo, AssetInput, Incident, DeviceReport, DeviceAnalysis, ConnectionHistoryEntry, IncidentSummaryEntry, DeviceLocationEntry, UserSummary, Role } from "./types";
import { getToken, notifyUnauthorized } from "./session";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getToken()}`,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // response body wasn't JSON — fall back to the generic message above
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Not built on request() above — that assumes a JSON body, and this is a
// binary file. A plain <a href> can't carry the Authorization header this
// route requires (GET /api/downloads/agent-installer is gated the same as
// any other admin/it_support action, not a public file), so this fetches
// the blob itself and hands the browser a one-off object URL to save it —
// same technique ImportAssetsModal already uses for its CSV template, just
// fetched from the server instead of generated client-side.
export async function downloadAgentInstaller(): Promise<void> {
  const res = await fetch(`${API_URL}/api/downloads/agent-installer`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `download failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // not a JSON error body — fall back to the generic message above
    }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "OptiFleet-Agent-Global-Deploy.zip";
  a.click();
  URL.revokeObjectURL(url);
}

export function submitCommand(text: string, scope?: string): Promise<CommandApiResponse> {
  return request<CommandApiResponse>("/api/command", {
    method: "POST",
    body: JSON.stringify(scope ? { text, scope } : { text }),
  });
}

export function confirmCommand(pendingId: string): Promise<CommandApiResponse> {
  return request<CommandApiResponse>(`/api/command/${encodeURIComponent(pendingId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function killProcess(
  agentId: string,
  target: { pid?: number; name?: string },
): Promise<{ status: string; results: { agentId: string; dispatched: boolean; commandId: string }[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/kill-process`, {
    method: "POST",
    body: JSON.stringify(target),
  });
}

// The one explicit run_script dispatch path — see server/src/api/routes.ts's
// POST /agents/:id/run-script doc comment. admin-only, and 403s outright if
// the server hasn't opted into run_script dispatch at all
// (OPTIFLEET_ENABLE_RUN_SCRIPT_DISPATCH) or if the target agent's own local
// config hasn't converged to allow it yet (see internal/configpush).
export function runScript(
  agentId: string,
  script: string,
): Promise<{ status: string; results: { agentId: string; dispatched: boolean; commandId: string }[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/run-script`, {
    method: "POST",
    body: JSON.stringify({ script }),
  });
}

export interface UploadedInstaller {
  id: string;
  filename: string;
  bytes: number;
  downloadUrl: string;
  agentAuthToken: string;
}

// Not built on request() — same reason downloadAgentInstaller isn't: this is
// a binary body, not JSON. filename travels as a query param since the body
// itself is the raw file bytes, nothing else.
export async function uploadInstaller(file: File): Promise<UploadedInstaller> {
  const res = await fetch(`${API_URL}/api/software-uploads?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getToken()}`,
      "content-type": "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `upload failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // not a JSON error body — fall back to the generic message above
    }
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export interface AgentBuildSummary {
  version: string;
  sha256: string;
  filename: string;
  uploadedAt: string;
}

export interface AgentUpdateStatus {
  agentId: string;
  status: "online" | "offline";
  version: string | null;
  updateStatus: "up_to_date" | "pending" | "unknown";
}

export interface AgentBuildsOverview {
  activeVersion: string | null;
  builds: AgentBuildSummary[];
  agents: AgentUpdateStatus[];
}

export function getAgentBuilds(): Promise<AgentBuildsOverview> {
  return request("/api/agent-builds");
}

// Same raw-body upload pattern as uploadInstaller — a multi-MB agent .exe
// isn't JSON. version travels as a query param alongside the raw bytes.
export async function uploadAgentBuild(file: File, version: string): Promise<{ build: AgentBuildSummary }> {
  const res = await fetch(`${API_URL}/api/agent-builds?version=${encodeURIComponent(version)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getToken()}`,
      "content-type": "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `upload failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // not a JSON error body — fall back to the generic message above
    }
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export function activateAgentBuild(version: string): Promise<{ activeVersion: string }> {
  return request(`/api/agent-builds/${encodeURIComponent(version)}/activate`, { method: "POST" });
}

export function suggestRemediation(
  agentId: string,
  pid: number,
): Promise<{ suggestion: RemediationSuggestion; process: ProcessInfo }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/suggest-remediation`, {
    method: "POST",
    body: JSON.stringify({ pid }),
  });
}

export function getTelemetry(agentId: string): Promise<{ snapshot: TelemetrySnapshot }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/telemetry`);
}

export function getHistory(agentId: string, hours = 6): Promise<{ points: HistoryPoint[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/history?hours=${encodeURIComponent(hours)}`);
}

export function getIncidents(agentId: string): Promise<{ incidents: Incident[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/incidents`);
}

export function getDeviceReport(agentId: string, days = 7): Promise<{ report: DeviceReport; analysis: DeviceAnalysis }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/report?days=${encodeURIComponent(days)}`);
}

export function getFleetIncidentSummary(days = 30, limit = 10): Promise<{ days: number; devices: IncidentSummaryEntry[] }> {
  return request(`/api/fleet/incident-summary?days=${encodeURIComponent(days)}&limit=${encodeURIComponent(limit)}`);
}

export function getFleetLocations(): Promise<{ devices: DeviceLocationEntry[] }> {
  return request("/api/fleet/locations");
}

export function getAssets(): Promise<{ assets: AssetWithLiveInfo[]; unregisteredAgents: string[] }> {
  return request("/api/assets");
}

export function createAsset(input: AssetInput & { assetTag?: string }): Promise<{ asset: AssetWithLiveInfo }> {
  return request("/api/assets", { method: "POST", body: JSON.stringify(input) });
}

export function updateAsset(assetTag: string, input: Partial<AssetInput>): Promise<{ asset: AssetWithLiveInfo }> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}`, { method: "PUT", body: JSON.stringify(input) });
}

export interface ImportAssetsResult {
  index: number;
  assetTag: string;
  action: "created" | "updated" | "failed";
  error?: string;
}

export function importAssets(
  rows: (AssetInput & { assetTag?: string })[],
): Promise<{ results: ImportAssetsResult[]; summary: { created: number; updated: number; failed: number } }> {
  return request("/api/assets/import", { method: "POST", body: JSON.stringify({ rows }) });
}

export function deleteAsset(assetTag: string): Promise<void> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}`, { method: "DELETE" });
}

export function getConnectionHistory(assetTag: string): Promise<{ entries: ConnectionHistoryEntry[] }> {
  return request(`/api/assets/${encodeURIComponent(assetTag)}/connection-history`);
}

// User account management — server independently enforces admin-only via
// requireRole (server/src/auth/roles.ts); these calls just 403 for anyone
// else, same as any other endpoint.
export function getUsers(): Promise<{ users: UserSummary[] }> {
  return request("/api/users");
}

export function createUserAccount(input: {
  username: string;
  password: string;
  role: Role;
  firstName: string;
  lastName: string;
  email?: string;
}): Promise<{ user: UserSummary }> {
  return request("/api/users", { method: "POST", body: JSON.stringify(input) });
}

export function updateUserAccount(
  id: string,
  input: { role?: Role; status?: "active" | "suspended"; password?: string; firstName?: string; lastName?: string; email?: string },
): Promise<{ user: UserSummary }> {
  return request(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteUserAccount(id: string): Promise<void> {
  return request(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Organization (tenant) management — server independently enforces this is
// the platform owner's own org via requirePlatformAdmin
// (server/src/api/routes.ts), same "403 for anyone else" guarantee as every
// other endpoint here.
export interface OrganizationSummary {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  status: string;
  createdAt: string;
}

export function getOrganizations(): Promise<{ orgs: OrganizationSummary[] }> {
  return request("/api/orgs");
}

// domain: null clears it, reverting the org to the shared subdomain-under-
// orgDomainSuffix pattern every other org uses (see server/src/api/routes.ts's
// POST /orgs/:id/custom-domain and migrations/0007_org_custom_domain.sql).
export function setCustomDomain(orgId: string, domain: string | null): Promise<{ org: OrganizationSummary }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/custom-domain`, {
    method: "POST",
    body: JSON.stringify({ customDomain: domain }),
  });
}

// Both fields optional — rename, change subdomain, or both in one call.
export function updateOrganization(orgId: string, input: { name?: string; subdomain?: string }): Promise<{ org: OrganizationSummary }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

// Suspending blocks that org's human logins and agent connections
// immediately (see server/src/orgs/orgCredentials.ts and orgResolver.ts).
export function setOrgStatus(orgId: string, status: "active" | "suspended"): Promise<{ org: OrganizationSummary }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/status`, { method: "POST", body: JSON.stringify({ status }) });
}

// Real, irreversible deletion of the org and everything in it — see
// server/src/orgs/orgsStore.ts's deleteOrganization doc comment.
export function deleteOrganization(orgId: string): Promise<void> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}`, { method: "DELETE" });
}

export interface AuditEvent {
  id: string;
  actorUsername: string;
  orgId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export function getAuditEvents(opts: { limit: number; offset: number }): Promise<{ events: AuditEvent[]; total: number }> {
  return request(`/api/audit-events?limit=${opts.limit}&offset=${opts.offset}`);
}

export interface CreateOrgResult {
  org: OrganizationSummary;
  // Shown as raw text in the dashboard only right here, at creation — not
  // redisplayed as a copyable string anywhere else. Still embedded in a
  // freshly generated installer .zip anytime via downloadOrgInstaller below
  // (server/src/orgs/orgsStore.ts's getOrganizationCredentials doc comment
  // explains why re-serving it there is safe).
  agentAuthToken: string;
  agentHmacSecret: string;
  admin: UserSummary;
  // Null only when adminPassword was supplied directly instead (not the
  // dashboard's path — see createOrganization below). Always present
  // otherwise: the platform admin's fallback if setupLinkEmailed is false.
  setupLink: string | null;
  setupLinkEmailed: boolean;
}

// adminPassword omitted (the normal dashboard path) → the new admin gets a
// self-service setup link (see CreateOrgResult.setupLink) instead of the
// platform admin choosing a password directly.
export function createOrganization(input: {
  name: string;
  subdomain: string;
  adminUsername: string;
  adminPassword?: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail?: string;
}): Promise<CreateOrgResult> {
  return request("/api/orgs", { method: "POST", body: JSON.stringify(input) });
}

// Not built on request() — same reason downloadAgentInstaller isn't: a
// binary body, not JSON. Rebuilt fresh server-side on every call (always
// the currently active agent build, this org's live credentials) rather
// than a static file, so there's nothing to keep in sync.
export async function downloadOrgInstaller(orgId: string, subdomain: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/orgs/${encodeURIComponent(orgId)}/installer`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `download failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // not a JSON error body — fall back to the generic message above
    }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `OptiFleet-Agent-${subdomain}-Deploy.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

// Support tooling for a customer org's own admin being locked out (forgot
// their only account's password, so the normal same-org self-service reset
// on the Users page is unreachable — they can't log in to get to it at
// all). Platform-admin only (server/src/api/routes.ts's
// requirePlatformAdmin) — a customer org's own admin session can't reach
// these, same 403 boundary as GET/POST /orgs itself.
export function getOrgUsers(orgId: string): Promise<{ users: UserSummary[] }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/users`);
}

export function resetOrgUserPassword(orgId: string, userId: string, password: string): Promise<void> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/users/${encodeURIComponent(userId)}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

// For the "setup link expired before the customer used it" case.
export function resendInvite(orgId: string, userId: string): Promise<{ setupLink: string; setupLinkEmailed: boolean }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/users/${encodeURIComponent(userId)}/resend-invite`, {
    method: "POST",
  });
}

// Public — no session exists yet (that's the whole point). Consumed from
// the standalone /setup-password page a freshly created org's admin lands
// on via their invite link.
export function setupPassword(token: string, password: string): Promise<void> {
  return request("/api/auth/setup-password", { method: "POST", body: JSON.stringify({ token, password }) });
}
