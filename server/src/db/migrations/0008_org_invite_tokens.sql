-- Lets a newly created org's first admin set their own password via a
-- one-time link, instead of the platform admin choosing a password and
-- relaying it manually (plaintext-password-in-chat). Single-use, expiring.
CREATE TABLE password_setup_tokens (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX ON password_setup_tokens (user_id);
