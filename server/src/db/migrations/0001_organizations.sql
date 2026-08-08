-- Multi-tenant migration, phase 1: the organizations table itself.
-- The current production fleet becomes org #1, a normal row (not
-- special-cased in application code) — a fixed UUID so every later
-- backfill migration can reference it as a literal constant without a
-- lookup.
CREATE TABLE organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  subdomain  TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ON organizations (lower(subdomain));

INSERT INTO organizations (id, name, subdomain)
VALUES ('00000000-0000-0000-0000-000000000001', 'Legacy Fleet', 'legacy');
