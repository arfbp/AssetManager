-- Persists platform-admin actions (org create/rename/suspend/delete,
-- cross-org password reset, resend-invite, custom-domain change) so
-- they're visible from the dashboard, not just Pino's stdout-only audit
-- logger (see server/src/logger.ts's `audit` export). Scoped to
-- platform-admin actions specifically, not general per-org activity — see
-- the multi-tenant migration plan's audit-log design decision.
--
-- org_id is ON DELETE SET NULL, not RESTRICT — deleting an org must never
-- be blocked by, or erase, its own audit history. The org's name is
-- snapshotted into `details` so the event stays readable after the org
-- itself is gone.
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_username TEXT NOT NULL,
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events (created_at DESC);
