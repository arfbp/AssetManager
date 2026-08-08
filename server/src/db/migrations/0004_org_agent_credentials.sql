-- Multi-tenant migration, phase 3: per-org agent credentials, replacing the
-- single fleet-wide OPTIFLEET_AGENT_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET.
-- Schema only — the legacy org's real values are backfilled in a separate,
-- uncommitted step (pulled live from each environment's own .env at deploy
-- time), never written into a migration file that lives in the repo.
ALTER TABLE organizations ADD COLUMN agent_auth_token TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN agent_hmac_secret TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX ON organizations (agent_auth_token) WHERE agent_auth_token <> '';
