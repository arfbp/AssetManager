-- Multi-tenant migration, phase 2: usernames are only unique within an org,
-- not globally — two different customer orgs each having their own "admin"
-- account is normal and must not collide.
ALTER TABLE users DROP CONSTRAINT users_username_key;
ALTER TABLE users ADD CONSTRAINT users_org_username_key UNIQUE (org_id, username);
