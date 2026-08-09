-- Lets an org's admin (or a platform admin) suspend a user without
-- deleting their account/history — mirrors organizations.status exactly
-- (migrations/0001_organizations.sql), which already had this pattern but
-- no equivalent existed on users until now.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
