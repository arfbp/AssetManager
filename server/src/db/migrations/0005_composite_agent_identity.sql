-- Multi-tenant migration, phase 4: agent_id (the machine's OS hostname) is
-- not unique across organizations — make (org_id, agent_id) the agents
-- table's real primary key, and update the one real FK that pointed at the
-- old bare agent_id key. command_history/assets/device_incidents/
-- asset_connection_history already carry org_id from migration 0002 and
-- were deliberately never FK'd to agents(agent_id) (an asset can predate
-- its agent, a peripheral can outlive the computer it was plugged into —
-- see schema.sql's own comments on those tables), so that reasoning is
-- unaffected by this change; only the two real constraints below move.
-- The FK must go first — it depends on agents_pkey's index, so Postgres
-- refuses to drop the PK while it's still referenced.
ALTER TABLE telemetry_snapshots DROP CONSTRAINT telemetry_snapshots_agent_id_fkey;

ALTER TABLE agents DROP CONSTRAINT agents_pkey;
ALTER TABLE agents ADD PRIMARY KEY (org_id, agent_id);

ALTER TABLE telemetry_snapshots ADD CONSTRAINT telemetry_snapshots_org_agent_fkey
  FOREIGN KEY (org_id, agent_id) REFERENCES agents (org_id, agent_id);

DROP INDEX idx_telemetry_agent_time;
CREATE INDEX idx_telemetry_org_agent_time ON telemetry_snapshots (org_id, agent_id, recorded_at DESC);

ALTER TABLE assets DROP CONSTRAINT assets_agent_id_key;
ALTER TABLE assets ADD CONSTRAINT assets_org_agent_key UNIQUE (org_id, agent_id);
