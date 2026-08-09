// Mirrors server/src/protocol.ts and the AgentSummary/HistoryEntry shapes in
// server/src/ws/registry.ts and server/src/history/commandHistory.ts. Kept
// in sync by hand, same as the server keeps its copy in sync with the Go
// agent — there's no shared schema generator across the three codebases.

export type AgentStatus = "online" | "offline";

// server/src/auth/roles.ts — 'admin' manages users too; 'it_support' can
// dispatch commands/manage assets but not accounts; 'viewer' is read-only
// everywhere. Enforced server-side (auth/roles.ts's requireRole) — anything
// gated by role in the frontend is a UX nicety on top of that, never the
// actual boundary.
export type Role = "admin" | "it_support" | "viewer";

export interface UserSummary {
  id: string;
  username: string;
  role: Role;
  status: string;
  createdAt: string;
  // Basic profile fields, separate from the login identifier (username) —
  // null for accounts created before these existed.
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

export interface DiskInfo {
  mount_point: string;
  used_percent: number;
  free_gb: number;
  total_gb: number;
}

// One physical storage device — spec inventory (what drives exist, SSD or
// HDD, how big), separate from DiskInfo's per-mount-point usage numbers
// above. media_type is "SSD", "HDD", or "Unknown" — the last meaning the OS
// didn't report a reliable answer either way, not that detection failed.
export interface PhysicalDiskInfo {
  model: string;
  media_type: string;
  size_gb: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  mem_mb: number;
  // Windows-only "(Not Responding)" signal — always true on platforms
  // without an equivalent OS check.
  responding: boolean;
}

// One currently-connected peripheral — a snapshot of "what's plugged in
// right now", not a connect/disconnect history.
export interface DeviceInfo {
  type: "usb" | "printer" | "monitor";
  name: string;
  detail?: string;
  // Only populated where the OS exposes real identifying data for that
  // device class (today: monitors, via EDID).
  serial_number?: string;
  model?: string;
  manufacturer?: string;
}

// Same level of detail Windows' own "ipconfig /all" shows for one adapter —
// DHCP/gateway/DNS/lease fields are Windows-only and stay empty elsewhere.
export interface NetworkInterface {
  name: string;
  description?: string;
  mac_address?: string;
  ip_addresses: string[];
  subnet_masks?: string[];
  dhcp_enabled: boolean;
  dhcp_server?: string;
  default_gateway?: string[];
  dns_servers?: string[];
  lease_obtained?: string;
  lease_expires?: string;
}

export interface TelemetrySnapshot {
  timestamp: string;
  mode: "normal" | "alert";
  cpu_percent: number;
  mem_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disks: DiskInfo[];
  physical_disks: PhysicalDiskInfo[];
  top_processes: ProcessInfo[];
  connected_devices: DeviceInfo[];
  hostname: string;
  ip_addresses: string[];
  public_ip: string;
  network_interfaces: NetworkInterface[];
  os: string;
  os_version: string;
  uptime_seconds: number;
  serial_number: string;
  model: string;
  manufacturer: string;
  cpu_model: string;
}

export interface AgentSummary {
  agentId: string;
  status: AgentStatus;
  connectedAt: number;
  lastSeenAt: number;
  lastTelemetry: TelemetrySnapshot | null;
}

export type CommandAction = "kill_process" | "clean_temp" | "restart_host" | "shutdown_host" | "run_script" | "network_diagnostic";

// One incremental chunk (typically one line) of a running network_diagnostic
// command's output, as it's produced on the agent — a tracert hop, a ping
// reply, one netstat row — rather than only the final result. Done=true
// marks the last chunk for that commandId (line may be empty on that one).
export interface CommandOutputPayload {
  command_id: string;
  line: string;
  done: boolean;
  error?: string;
}

export type HistoryEntryStatus = "dispatched" | "offline" | "succeeded" | "failed";

export interface HistoryEntry {
  commandId: string;
  agentId: string;
  action: CommandAction;
  params: Record<string, string>;
  requestedBy: string;
  sourceText: string | null;
  status: HistoryEntryStatus;
  message: string | null;
  dispatchedAt: number;
  resolvedAt: number | null;
}

export interface ResolvedCommand {
  action: CommandAction;
  params: Record<string, string>;
}

export type CommandApiResponse =
  | { status: "dispatched"; resolved: ResolvedCommand; results: { agentId: string; dispatched: boolean; commandId: string }[]; reasoning?: string }
  | { status: "needs_confirmation"; pendingId: string; reason: string; resolved: ResolvedCommand; targets: string[]; expiresInSeconds: number; reasoning?: string }
  // A read-only query_info answer — nothing was dispatched to any device.
  // fallback=true means the request didn't map to a specific supported
  // action at all; this is the server falling back to "here's the
  // device's actual current state" instead of a dead-end rejection.
  | { status: "answered"; agentId: string; answerable: boolean; answer: string; reasoning?: string; fallback?: boolean }
  // Organization/user administration responses — see
  // server/src/security/adminGuardrail.ts. "admin_form" means nothing
  // happened yet: the caller opens the named dashboard modal pre-filled
  // with `prefill` and the operator completes/submits it normally.
  | { status: "admin_form"; formAction: "create_organization" | "create_user"; prefill: Record<string, string>; reasoning?: string }
  // kind: "admin" distinguishes this from the device needs_confirmation
  // variant above (which always has `targets` instead) — confirming posts
  // to the same POST /command/:id/confirm endpoint either way.
  | {
      status: "needs_confirmation";
      kind: "admin";
      pendingId: string;
      reason: string;
      resolved: { action: string; orgName?: string; username?: string };
      expiresInSeconds: number;
      reasoning?: string;
    }
  // Immediate (no confirmation) response to generate_installer.
  | {
      status: "admin_result";
      resultAction: "generate_installer";
      installerOrgId: string;
      orgName: string;
      subdomain: string;
      ownOrg: boolean;
      reasoning?: string;
    }
  // POST /command/:id/confirm's result for a confirmed admin action
  // (suspend/reactivate/delete on an org or user).
  | { status: "admin_result"; message: string };

export interface ApiErrorBody {
  error: string;
  parsed?: unknown;
}

export interface RemediationSuggestion {
  suggested_action: "kill_process" | "monitor";
  reasoning: string;
  risk_note: string;
}

// One point of the CPU/RAM/Disk trend chart — server/src/api/routes.ts's
// GET /agents/:id/history, sourced from the durable telemetry_snapshots
// table rather than AgentRegistry's in-memory "last known" state.
export interface HistoryPoint {
  recordedAt: string;
  cpuPercent: number;
  memPercent: number;
  disks: DiskInfo[];
}

// One episode from a device's incident log — currently just "a process
// stopped responding" (kind: "process_not_responding"), open (resolvedAt
// null) while still ongoing.
export interface Incident {
  id: number;
  agentId: string;
  kind: string;
  message: string;
  occurredAt: string;
  resolvedAt: string | null;
}

// server/src/api/routes.ts's GET /fleet/locations — an agent's *approximate*
// location via IP geolocation (see server/src/geolocation/ipGeo.ts), never
// real GPS — this system has no location hardware anywhere in it. isPrivate
// true means remoteIp is a LAN/private address with nothing to look up in
// principle (most devices on one office network); isPrivate false with
// lat/lon still null means a public IP that the lookup couldn't resolve.
export interface DeviceLocationEntry {
  agentId: string;
  status: AgentStatus;
  remoteIp: string | null;
  isPrivate: boolean | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
  isp: string | null;
  asn: string | null;
  zip: string | null;
  timezone: string | null;
}

// server/src/api/routes.ts's GET /fleet/incident-summary — plain incident
// counts per device over a window, for the Dashboard's "devices with the
// most issues" ranking. No LLM involved (contrast DeviceAnalysis, which is
// an on-demand per-device call) — devices with zero incidents in the window
// are simply absent from this list, not returned as a zero-count row.
export interface IncidentSummaryEntry {
  agentId: string;
  incidentCount: number;
  lastIncidentAt: string;
}

// server/src/api/routes.ts's GET /agents/:id/report — resource-usage/
// reliability summary over a recent window, computed from durable
// telemetry_snapshots + device_incidents, not the in-memory "last known"
// state.
export interface DeviceReport {
  deviceId: string;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  uptimeSeconds: number;
  windowDays: number;
  avgCpuPercent: number;
  maxCpuPercent: number;
  avgMemPercent: number;
  maxMemPercent: number;
  worstDiskUsedPercent: number | null;
  incidentCount: number;
  sampleCount: number;
}

export interface DeviceAnalysis {
  verdict: "recommend_replacement" | "monitor" | "no_action_needed";
  reasoning: string;
  note: string;
}

// One episode of a peripheral asset being connected through a particular
// computer — server/src/assets/connectionHistoryStore.ts. disconnectedAt is
// null for whichever episode is currently open (the peripheral's current
// location, or its last-known one if it's stopped reporting).
export interface ConnectionHistoryEntry {
  agentId: string;
  connectedAt: string;
  disconnectedAt: string | null;
}

// Asset registry — inventory/procurement fields an operator enters by hand
// (server/src/assets/assetsStore.ts), joined read-only against whatever the
// linked device already reports automatically (serialNumber/model/
// manufacturer/liveStatus come from its last telemetry snapshot, never
// stored in the assets table itself).
export type AssetStatus = "ready_to_deploy" | "deployed" | "in_repair" | "retired";

// "computer" assets link to an agent_id and always show live telemetry
// fields. "peripheral" assets (a monitor, for example) have no telemetry
// connection of their own — their manufacturer/model/serial are captured
// once at registration time instead, typically pre-filled from the parent
// computer's connected_devices list (see DeviceInfo).
export type AssetType = "computer" | "peripheral";

export interface AssetInput {
  agentId?: string | null;
  status?: AssetStatus;
  category?: string | null;
  location?: string | null;
  orderNumber?: string | null;
  checkedOutTo?: string | null;
  checkoutDate?: string | null;
  expectedCheckinDate?: string | null;
  eolDate?: string | null;
  notes?: string | null;
  // Hand-entered so an asset can be pre-registered (with a known serial)
  // before its device ever connects — server/src/db/persistence.ts links a
  // newly-connected agent to this same row when its live serial matches,
  // instead of creating a duplicate asset. For a "peripheral" asset this is
  // simply its actual serial, since there's no live telemetry to prefer.
  manualSerialNumber?: string | null;
  assetType?: AssetType;
  manufacturer?: string | null;
  model?: string | null;
  // Which computer this peripheral was connected through at registration —
  // informational only, not kept in sync afterward.
  parentAgentId?: string | null;
}

export interface AssetWithLiveInfo extends AssetInput {
  assetTag: string;
  status: AssetStatus;
  createdAt: string;
  updatedAt: string;
  liveStatus: AgentStatus | null;
  serialNumber: string | null;
  model: string | null;
  manufacturer: string | null;
  ipAddresses: string[] | null;
  // Both straight from the linked agent's last telemetry snapshot, same as
  // serialNumber/model/manufacturer above — null for a "peripheral" asset or
  // if the linked computer hasn't reported a snapshot yet.
  cpuModel: string | null;
  physicalDisks: PhysicalDiskInfo[] | null;
  // Most recent asset_connection_history episode for a "peripheral" asset —
  // all null if it's never actually been tracked connecting to anything.
  // lastConnectionDisconnectedAt null means that episode is still open
  // (this is where it's connected right now).
  lastConnectionAgentId: string | null;
  lastConnectedAt: string | null;
  lastConnectionDisconnectedAt: string | null;
}

// Messages received on the dashboard WebSocket (server/src/ws/dashboardServer.ts).
export type DashboardWsMessage =
  | { type: "snapshot"; agents: AgentSummary[]; history: HistoryEntry[] }
  | { type: "agent_update"; agent: AgentSummary }
  | { type: "history_entry"; entry: HistoryEntry }
  | { type: "command_output"; agentId: string; output: CommandOutputPayload };
