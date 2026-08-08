-- Multi-tenant migration, phase 4 (continued): asset_tag ("OF-0001"-style)
-- is per-org sequential, not globally unique, once org_id filtering makes
-- each org count its own assets from 1 — a bare global PRIMARY KEY on
-- asset_tag would collide the moment a second org's numbering reaches a tag
-- an earlier org already has. Same composite-key treatment as agents in
-- migrations/0005.
-- Same dependency-order requirement as migrations/0005: the FK depends on
-- assets_pkey's index, so it has to go first.
ALTER TABLE asset_connection_history DROP CONSTRAINT asset_connection_history_asset_tag_fkey;

ALTER TABLE assets DROP CONSTRAINT assets_pkey;
ALTER TABLE assets ADD PRIMARY KEY (org_id, asset_tag);

ALTER TABLE asset_connection_history ADD CONSTRAINT asset_connection_history_org_asset_fkey
  FOREIGN KEY (org_id, asset_tag) REFERENCES assets (org_id, asset_tag) ON DELETE CASCADE;

DROP INDEX idx_asset_connection_history_asset;
CREATE INDEX idx_asset_connection_history_org_asset ON asset_connection_history (org_id, asset_tag, connected_at DESC);
