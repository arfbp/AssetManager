-- Multi-tenant migration, phase 1: org_id on every tenant-scoped table,
-- backfilled onto the legacy org so today's single fleet keeps working
-- unchanged. NOT NULL added only after backfill, in the same statement
-- group, so the column is never observably nullable to application code.
--
-- sessions is deliberately skipped — org is derivable via
-- users.org_id (same as role is already read fresh via a join, not
-- duplicated onto the session row). ip_geolocation_cache is deliberately
-- skipped — a global IP->location cache with no tenant-sensitive data;
-- multiple orgs' agents behind the same office IP legitimately share a row.

ALTER TABLE users ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE users SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE users ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE agents ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE agents SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE agents ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE telemetry_snapshots ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE telemetry_snapshots SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE telemetry_snapshots ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE command_history ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE command_history SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE command_history ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE assets ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE assets SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE assets ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE device_incidents ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE device_incidents SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE device_incidents ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE asset_connection_history ADD COLUMN org_id UUID REFERENCES organizations(id);
UPDATE asset_connection_history SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
ALTER TABLE asset_connection_history ALTER COLUMN org_id SET NOT NULL;
