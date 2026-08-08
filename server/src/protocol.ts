// Wire format shared with the Go agent (internal/transport/protocol.go).
// Keep these two files in sync by hand — there is no shared schema generator
// between the Go and TypeScript codebases, so a field added on one side must
// be added here too.

export type MessageType =
  | "heartbeat"
  | "telemetry"
  | "command"
  | "command_result"
  | "command_output"
  | "alert"
  | "self_update"
  | "config_update";

export interface Envelope {
  type: MessageType;
  payload: unknown;
}

export interface HeartbeatPayload {
  agent_id: string;
  uptime_seconds: number;
  // Reported by every agent build since internal/version was added — older
  // already-deployed agents that predate this simply omit the field, which
  // ws/server.ts treats as "unknown, don't push an update" rather than
  // guessing.
  version?: string;
  // SHA256 of the agent's own currently-loaded agent.yaml, reported since
  // internal/configpush was added — older agents that predate it simply omit
  // the field, same "unknown, don't push anything" handling as version.
  config_hash?: string;
}

// Server -> agent instruction to download and install a specific new build
// of itself. See internal/transport/protocol.go's SelfUpdatePayload for the
// full reasoning — this is a deliberately separate, more narrowly-trusted
// path than CommandPayload below: it's never constructed from a
// user-dispatched or AI-parsed action (CommandAction has no "self_update"
// member, and neither does the LLM parser's action enum — see
// llm/schema.ts), only from ws/server.ts's own version-check logic.
export interface SelfUpdatePayload {
  version: string;
  url: string;
  sha256: string;
  issued_at_unix: number;
  signature: string;
}

// Server -> agent instruction to replace its own agent.yaml and, if
// enable_run_script is set, ensure OPTIFLEET_ENABLE_RUN_SCRIPT=true is in the
// service's environment, then restart. See
// internal/transport/protocol.go's ConfigUpdatePayload for the full
// reasoning — same deliberately separate, more narrowly-trusted path as
// SelfUpdatePayload above (never constructed from a user-dispatched or
// AI-parsed action), only ever built from ws/server.ts's own
// config-convergence check comparing config_hash reported in each heartbeat
// against agentConfig.ts's desired config.
export interface ConfigUpdatePayload {
  config_yaml: string;
  config_sha256: string;
  enable_run_script: boolean;
  issued_at_unix: number;
  signature: string;
}

export interface DiskInfo {
  mount_point: string;
  used_percent: number;
  free_gb: number;
  total_gb: number;
}

// One physical storage device — spec inventory (what drives exist, SSD or
// HDD, how big), separate from DiskInfo's per-mount-point usage. See
// internal/telemetry/types.go's PhysicalDiskInfo for why this doesn't join
// onto DiskInfo directly. media_type is "SSD", "HDD", or "Unknown".
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
  // Windows-only "(Not Responding)" signal — see hungWindowPIDs in the Go
  // agent. Always true on platforms without an equivalent OS check.
  responding: boolean;
}

// One currently-connected peripheral — a snapshot of "what's plugged in
// right now" (internal/telemetry/types.go's DeviceInfo), not a
// connect/disconnect history.
export interface DeviceInfo {
  type: "usb" | "printer" | "monitor";
  name: string;
  detail?: string;
  // Only populated where the OS exposes real identifying data for that
  // device class (today: monitors, via EDID) — see collectMonitorsWindows.
  serial_number?: string;
  model?: string;
  manufacturer?: string;
}

// One network adapter's full configuration — the same level of detail
// Windows' own "ipconfig /all" shows, distinct from TelemetrySnapshot's own
// bare ip_addresses list (which predates this and stays for the simple
// "what's this machine's IP" case). DHCP/gateway/DNS/lease fields are
// Windows-only (via Win32_NetworkAdapterConfiguration) and stay empty on
// other platforms.
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
  // The agent's real internet-facing address, from its own external lookup
  // — see internal/telemetry/publicip.go. Distinct from ip_addresses
  // (LAN-side interface addresses) and from whatever address this agent's
  // WebSocket connection appears to come from (registry.ts's remoteIp),
  // which is only the same thing if this server itself lives out on the
  // internet rather than on the same LAN as the agent. Empty until the
  // agent's background refresh completes.
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

export interface TelemetryPayload {
  snapshot: TelemetrySnapshot;
}

export type CommandAction = "kill_process" | "clean_temp" | "restart_host" | "shutdown_host" | "run_script" | "network_diagnostic";

// CommandPayload is what the server sends to an agent. `signature` is
// computed by commandSigner.ts over the same netstring-encoded canonical
// form the Go agent recomputes on receipt (transport.CommandPayload.
// CanonicalString) — see crypto/commandSigner.ts for why netstrings instead
// of JSON.
export interface CommandPayload {
  id: string;
  action: CommandAction;
  params: Record<string, string>;
  issued_at_unix: number;
  signature: string;
}

export interface CommandResultPayload {
  command_id: string;
  success: boolean;
  message: string;
  executed_unix: number;
}

// One incremental chunk (typically one line) of a long-running
// network_diagnostic command's output as it's produced agent-side — see
// internal/transport/protocol.go's CommandOutputPayload, which this mirrors.
// Done=true marks the final chunk; Error carries a mid-stream failure.
export interface CommandOutputPayload {
  command_id: string;
  line: string;
  done: boolean;
  error?: string;
}

export interface AlertPayload {
  kind: string;
  message: string;
  fields?: Record<string, string>;
  timestamp_unix: number;
}
