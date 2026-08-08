-- OptiFleet AI Central Server: persistence schema.
-- Idempotent (IF NOT EXISTS everywhere) — safe to run repeatedly via
-- `npm run db:migrate`. See src/db/migrate.ts.

-- Needed for gen_random_uuid() used by the users table below — built into
-- Postgres core on some versions, an extension on others, so declare it
-- explicitly rather than relying on which one this database happens to be.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  agent_id       TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  connected_at   TIMESTAMPTZ NOT NULL,
  last_seen_at   TIMESTAMPTZ NOT NULL,
  last_telemetry JSONB
);

-- Append-only time series, one row per telemetry snapshot reported by an
-- agent (normal mode every 5m, alert mode every 10s per the agent's
-- dynamic poller — see internal/telemetry/poller.go). `agents.last_telemetry`
-- stays the fast "current state" read; this table is the history behind it.
CREATE TABLE IF NOT EXISTS telemetry_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
  recorded_at TIMESTAMPTZ NOT NULL,
  mode        TEXT NOT NULL,
  cpu_percent DOUBLE PRECISION NOT NULL,
  mem_percent DOUBLE PRECISION NOT NULL,
  mem_used_mb DOUBLE PRECISION NOT NULL,
  mem_total_mb DOUBLE PRECISION NOT NULL,
  snapshot    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_agent_time
  ON telemetry_snapshots (agent_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS command_history (
  command_id    TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  action        TEXT NOT NULL,
  params        JSONB NOT NULL,
  requested_by  TEXT NOT NULL,
  source_text   TEXT,
  status        TEXT NOT NULL,
  message       TEXT,
  dispatched_at TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_command_history_dispatched_at
  ON command_history (dispatched_at DESC);

-- Real per-user accounts, replacing the single shared OPTIFLEET_DASHBOARD_TOKEN.
-- Accounts are created by an administrator via `npm run user:create` — there
-- is no public self-registration endpoint, matching the rest of this
-- project's "no capability beyond what an operator explicitly configured"
-- philosophy (see internal/groups/deviceGroups.ts's doc comment for the same
-- principle on the agent side).
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Role-based access control: 'admin' can dispatch commands, manage assets,
-- AND manage other user accounts; 'it_support' can dispatch commands and
-- manage assets but not touch user accounts; 'viewer' is read-only
-- everywhere (blocked at security/roles.ts's requireRole, not just hidden
-- in the UI — a Viewer's browser calling the dispatch endpoints directly
-- gets a real 403, same as anyone else). Existing rows default to 'admin'
-- on migration — this project only ever had one bootstrap account before
-- roles existed, and defaulting it to anything less than admin would be a
-- surprise lockout, not a safe default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'it_support', 'viewer'));

-- Basic profile fields, separate from the login identifier (username).
-- Nullable — existing accounts predate this and have neither; the "Add
-- user" form requires first/last name going forward, but nothing here
-- forces a backfill on accounts that already exist.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- Session tokens are opaque random strings, not JWTs — revocation is just a
-- DELETE, and validity is a DB lookup rather than trusting a signature the
-- server can't invalidate early. Stored in Postgres (not memory) so a
-- session survives a server restart instead of forcing every operator to
-- log in again each time.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- Asset registry — inventory/procurement metadata an operator enters by
-- hand (location, who it's checked out to, order number, end-of-life date),
-- layered on top of whatever the agent already reports automatically
-- (serial number, model, manufacturer — internal/telemetry's
-- collectHardwareInfo, part of every telemetry snapshot already stored in
-- agents.last_telemetry). agent_id is deliberately NOT a foreign key to
-- agents(agent_id): an asset can exist before the device it describes has
-- ever connected (bought, not yet deployed — "ready_to_deploy" below), so
-- forcing agents to exist first would break that case.
CREATE TABLE IF NOT EXISTS assets (
  asset_tag             TEXT PRIMARY KEY,
  agent_id              TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'ready_to_deploy',
  category              TEXT,
  location              TEXT,
  order_number          TEXT,
  checked_out_to        TEXT,
  checkout_date         DATE,
  expected_checkin_date DATE,
  eol_date              DATE,
  notes                 TEXT,
  -- Entered by hand when an asset is registered before it's ever connected
  -- (bought, sitting in a box, "ready_to_deploy") — the only way to record
  -- a serial number ahead of time, since the *live* serial_number shown
  -- elsewhere always comes from the linked agent's telemetry, never from
  -- this table. Once a real agent connects and reports a matching serial,
  -- db/persistence.ts's auto-registration links that agent to this same
  -- row instead of creating a duplicate asset for the same physical device.
  manual_serial_number  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ADD COLUMN IF NOT EXISTS handles the case where the assets table already
-- existed from before this column was introduced — CREATE TABLE IF NOT
-- EXISTS above is a no-op against an existing table, so it alone would never
-- backfill new columns onto an already-provisioned database.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS manual_serial_number TEXT;

-- A 'computer' asset is one side of the agent_id link above — its
-- manufacturer/model/serial are always read live from the linked agent's
-- telemetry (assetsStore.ts's listAssets join), never stored here. A
-- 'peripheral' asset (a monitor, for example) has no telemetry connection of
-- its own to join against, so its identity has to be captured as a static
-- snapshot at registration time instead — hence the two columns below exist
-- purely for that case, and stay NULL for 'computer' rows. parent_agent_id
-- notes which computer the peripheral was connected through when
-- registered — informational only (the peripheral can move between
-- machines afterward without updating this), so deliberately not a foreign
-- key onto agents(agent_id).
ALTER TABLE assets ADD COLUMN IF NOT EXISTS asset_type TEXT NOT NULL DEFAULT 'computer';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS manufacturer TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS parent_agent_id TEXT;

-- Per-device incident log — currently just "a process stopped responding"
-- (Windows' own hung-window check, see internal/telemetry/hungwindows_windows.go),
-- but the `kind` column leaves room for other incident types later without
-- a schema change. One row per continuous episode, not one row per
-- telemetry poll: db/persistence.ts opens a row when a process is first
-- seen hung and closes it (sets resolved_at) once that process is next
-- seen responding again or has exited, tracked in an in-memory map keyed by
-- agent+pid+name so a process that's still hung across many polls doesn't
-- spam a new row every cycle.
CREATE TABLE IF NOT EXISTS device_incidents (
  id           BIGSERIAL PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_incidents_agent_time
  ON device_incidents (agent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_assets_agent_id ON assets (agent_id);
CREATE INDEX IF NOT EXISTS idx_assets_manual_serial_number ON assets (manual_serial_number) WHERE manual_serial_number IS NOT NULL;

-- Which computer(s) a "peripheral" asset has actually been connected
-- through over time — assets.parent_agent_id only ever holds the most
-- recent one (see its own column comment: "not kept in sync afterward"),
-- which stopped being good enough once an operator asked to move a monitor
-- between machines and still see where it used to live. One row per
-- continuous connection episode: db/persistence.ts closes the open row
-- (disconnected_at) when a peripheral's serial number is next seen on a
-- *different* agent's connected_devices (or stops appearing anywhere) and
-- opens a new one for wherever it shows up now. Not a foreign key onto
-- agents(agent_id) for the same reason assets.agent_id isn't: a peripheral
-- can outlive the specific computer it was once connected through.
CREATE TABLE IF NOT EXISTS asset_connection_history (
  id              BIGSERIAL PRIMARY KEY,
  asset_tag       TEXT NOT NULL REFERENCES assets(asset_tag) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_asset_connection_history_asset
  ON asset_connection_history (asset_tag, connected_at DESC);

-- The public IP an agent's WebSocket connection actually came from (see
-- ws/server.ts's connection handler) — the input to IP geolocation below.
-- For a LAN-deployed fleet this is usually the office's single outbound
-- public IP shared by every device behind it, not a per-device address; it
-- still gets stored per-agent because a remote/home-office device *would*
-- have its own distinct one, and there's no way to know which case applies
-- without recording it.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS remote_ip TEXT;

-- Caches src/geolocation/ipGeo.ts's external lookups keyed by IP, since a
-- given IP's location essentially never changes and multiple agents behind
-- the same office network legitimately share one row. is_private marks an
-- RFC1918/loopback address that was never sent to the external API at all
-- (nothing to look up — see ipGeo.ts's isPrivateIp) rather than a failed
-- lookup, so the UI can tell "not resolvable in principle" apart from
-- "lookup didn't happen yet."
CREATE TABLE IF NOT EXISTS ip_geolocation_cache (
  ip           TEXT PRIMARY KEY,
  city         TEXT,
  region       TEXT,
  country      TEXT,
  lat          DOUBLE PRECISION,
  lon          DOUBLE PRECISION,
  is_private   BOOLEAN NOT NULL DEFAULT false,
  looked_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Matches the level of detail a "what's my IP" site typically shows
-- (whatismyip.com-style: ISP, ASN, postal code, timezone alongside
-- city/region/country) — the Live Tracking page's per-device IP info panel.
ALTER TABLE ip_geolocation_cache ADD COLUMN IF NOT EXISTS isp TEXT;
ALTER TABLE ip_geolocation_cache ADD COLUMN IF NOT EXISTS asn TEXT;
ALTER TABLE ip_geolocation_cache ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE ip_geolocation_cache ADD COLUMN IF NOT EXISTS timezone TEXT;
