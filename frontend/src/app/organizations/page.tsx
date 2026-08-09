"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { CreateOrgModal } from "@/components/orgs/CreateOrgModal";
import {
  ApiError,
  getOrganizations,
  downloadOrgInstaller,
  getOrgUsers,
  resetOrgUserPassword,
  resendInvite,
  setCustomDomain,
  updateOrganization,
  setOrgStatus,
  deleteOrganization,
  type OrganizationSummary,
  type CreateOrgResult,
} from "@/lib/api";
import { getStoredIsPlatformAdmin } from "@/lib/session";
import { formatRelativeTime } from "@/lib/format";
import type { UserSummary } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Same fixed UUID as server/src/orgs/orgsStore.ts's PLATFORM_ORG_ID — this
// org holds the only accounts that can manage every other org, so its own
// row never gets suspend/delete actions (the server rejects both anyway;
// disabling them here just avoids a doomed request and a confusing error).
const PLATFORM_ORG_ID = "00000000-0000-0000-0000-000000000001";

// Shown exactly once, right after creation — organizations.agent_auth_token/
// agent_hmac_secret are never returned by any other endpoint (see
// server/src/orgs/orgsStore.ts), same "write it down now" treatment as any
// other freshly generated secret.
function CredentialsModal({ result, onClose }: { result: CreateOrgResult; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);

  function copy(value: string, label: string): void {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const envBlock = `OPTIFLEET_AUTH_TOKEN=${result.agentAuthToken}\nOPTIFLEET_HMAC_SECRET=${result.agentHmacSecret}`;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[22px] text-status-good">check_circle</span>
          <h2 className="text-base font-semibold text-ink-primary">"{result.org.name}" created</h2>
        </div>
        <p className="mt-2 text-xs text-status-warning">
          This org's agent credentials are shown as raw text once, right now. You can always come back and download a fresh installer for
          this org later from the table below — it's rebuilt on demand, not a static file.
        </p>

        <div className="mt-4 space-y-2">
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Admin login</label>
            <p className="mt-1 rounded-md border border-border bg-page px-3 py-2 font-mono text-xs text-ink-primary">
              {result.admin.username} @ {result.org.subdomain}
            </p>
          </div>
          {result.setupLink && (
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  {result.setupLinkEmailed ? "Setup link (also emailed to the admin)" : "Setup link — send this to the admin"}
                </label>
                <button
                  type="button"
                  onClick={() => copy(result.setupLink!, "link")}
                  className="text-[11px] font-medium text-accent hover:underline"
                >
                  {copied === "link" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="mt-1 overflow-x-auto rounded-md border border-border bg-page px-3 py-2 font-mono text-[11px] text-ink-primary">
                {result.setupLink}
              </p>
              <p className="mt-1 text-[11px] text-ink-muted">Expires in 7 days. The admin sets their own password when they open it.</p>
            </div>
          )}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Agent credentials (install.ps1 env block)</label>
              <button type="button" onClick={() => copy(envBlock, "env")} className="text-[11px] font-medium text-accent hover:underline">
                {copied === "env" ? "Copied!" : "Copy"}
              </button>
            </div>
            <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-page px-3 py-2 font-mono text-[11px] text-ink-primary">
              {envBlock}
            </pre>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => downloadOrgInstaller(result.org.id, result.org.subdomain)}
            className="flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-gridline/40"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            Download installer
          </button>
          <button type="button" onClick={onClose} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

interface CustomDomainModalProps {
  org: OrganizationSummary;
  onClose: () => void;
  onDone: (org: OrganizationSummary) => void;
}

// Lets an org be reached at its own fully-owned domain (e.g.
// assets.360qm.co.th) instead of the shared subdomain-under-orgDomainSuffix
// pattern — this only registers the domain at the app layer (login
// resolution + CORS, see server/src/api/routes.ts's POST
// /orgs/:id/custom-domain). DNS still has to be pointed at this deployment
// by the customer, and a TLS certificate covering the domain still has to
// exist — see scripts/add-custom-domain.sh on the VPS for that half.
function CustomDomainModal({ org, onClose, onDone }: CustomDomainModalProps) {
  const [domain, setDomain] = useState(org.customDomain ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await setCustomDomain(org.id, domain.trim() || null);
      onDone(res.org);
    } catch (err) {
      setError(errorMessage(err, "Failed to update custom domain."));
    } finally {
      setBusy(false);
    }
  }

  async function handleClear(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await setCustomDomain(org.id, null);
      onDone(res.org);
    } catch (err) {
      setError(errorMessage(err, "Failed to clear custom domain."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSave} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Custom domain — {org.name}</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Registers the domain for login/CORS. Two things still have to happen outside this dashboard before it actually works: the
          customer points DNS at this server, and a TLS certificate has to cover the domain — run{" "}
          <code className="text-ink-secondary">scripts/add-custom-domain.sh {domain.trim() || "<domain>"}</code> on the VPS once DNS
          is pointed correctly.
        </p>
        <label className="mt-4 block text-xs text-ink-secondary">
          Domain
          <input
            autoFocus
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            disabled={busy}
            placeholder="assets.customer.com"
            className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
        </label>
        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}
        <div className="mt-5 flex items-center justify-between">
          {org.customDomain ? (
            <button type="button" onClick={handleClear} disabled={busy} className="text-xs text-status-critical hover:underline disabled:opacity-50">
              Remove custom domain
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !domain.trim()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

interface RenameOrgModalProps {
  org: OrganizationSummary;
  onClose: () => void;
  onDone: (org: OrganizationSummary) => void;
}

function RenameOrgModal({ org, onClose, onDone }: RenameOrgModalProps) {
  const [name, setName] = useState(org.name);
  const [subdomain, setSubdomain] = useState(org.subdomain);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const changes: { name?: string; subdomain?: string } = {};
      if (name.trim() !== org.name) changes.name = name.trim();
      if (subdomain.trim().toLowerCase() !== org.subdomain) changes.subdomain = subdomain.trim().toLowerCase();
      const res = await updateOrganization(org.id, changes);
      onDone(res.org);
    } catch (err) {
      setError(errorMessage(err, "Failed to update organization."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Rename / change subdomain</h2>
        <p className="mt-1 text-xs text-ink-muted">Changing the subdomain takes effect immediately — no restart needed.</p>
        <label className="mt-4 block text-xs text-ink-secondary">
          Organization name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
        </label>
        <label className="mt-2 block text-xs text-ink-secondary">
          Subdomain
          <input
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
        </label>
        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || !subdomain.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface DeleteOrgModalProps {
  org: OrganizationSummary;
  onClose: () => void;
  onDeleted: () => void;
}

// Real, irreversible deletion (server/src/orgs/orgsStore.ts's
// deleteOrganization) — requires typing the org's exact name before the
// button enables, the same "type to confirm" pattern common SaaS dashboards
// use for their one truly unrecoverable action. A plain yes/no ConfirmDialog
// is used for suspend elsewhere on this page, since suspend is reversible.
function DeleteOrgModal({ org, onClose, onDeleted }: DeleteOrgModalProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await deleteOrganization(org.id);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err, "Failed to delete organization."));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-status-critical/30 bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-status-critical">Delete "{org.name}"</h2>
        <p className="mt-2 text-xs text-ink-secondary">
          This permanently deletes the organization and every device, asset, telemetry record, and user account that belongs to it. This
          cannot be undone.
        </p>
        <label className="mt-4 block text-xs text-ink-secondary">
          Type <span className="font-mono font-semibold text-ink-primary">{org.name}</span> to confirm
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-status-critical disabled:opacity-50"
          />
        </label>
        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy || typed !== org.name}
            className="rounded-md bg-status-critical px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ResetOrgPasswordModalProps {
  org: OrganizationSummary;
  user: UserSummary;
  onClose: () => void;
  onDone: () => void;
}

function ResetOrgPasswordModal({ org, user, onClose, onDone }: ResetOrgPasswordModalProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resetOrgUserPassword(org.id, user.id, password);
      onDone();
    } catch (err) {
      setError(errorMessage(err, "Failed to reset password."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">
          Reset password for {user.username} @ {org.subdomain}
        </h2>
        <label className="mt-4 block text-xs text-ink-secondary">
          New password (min. 8 characters)
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
        </label>
        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || password.length < 8}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Reset password"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface ManageUsersModalProps {
  org: OrganizationSummary;
  onClose: () => void;
}

// Support tooling for exactly the "this org's only admin forgot their
// password and can't log in at all, so the normal same-org self-service
// reset on the Users page is unreachable" case — see
// server/src/api/routes.ts's GET/POST /orgs/:id/users... doc comment.
function ManageUsersModal({ org, onClose }: ManageUsersModalProps) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<UserSummary | null>(null);
  const [justReset, setJustReset] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState<string | null>(null);
  const [resendResult, setResendResult] = useState<{ username: string; link: string; emailed: boolean } | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reload(): void {
    getOrgUsers(org.id)
      .then((res) => setUsers(res.users))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load this org's users.")));
  }

  async function handleResendInvite(user: UserSummary): Promise<void> {
    setResendBusy(user.id);
    setResendError(null);
    try {
      const res = await resendInvite(org.id, user.id);
      setResendResult({ username: user.username, link: res.setupLink, emailed: res.setupLinkEmailed });
    } catch (err) {
      setResendError(errorMessage(err, "Failed to resend setup link."));
    } finally {
      setResendBusy(null);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Users — {org.name}</h2>
        <p className="mt-1 text-xs text-ink-muted">Resetting a password here works even if this is their only account and they're locked out.</p>

        {justReset && <p className="mt-3 text-sm text-status-good">Password reset for {justReset}.</p>}
        {loadError && <p className="mt-3 text-sm text-status-critical">{loadError}</p>}
        {resendError && <p className="mt-3 text-sm text-status-critical">{resendError}</p>}

        {resendResult && (
          <div className="mt-3 rounded-md border border-border bg-page p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-ink-primary">
                {resendResult.emailed ? `Setup link resent to ${resendResult.username} (also emailed)` : `Setup link for ${resendResult.username}`}
              </p>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(resendResult.link).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="text-[11px] font-medium text-accent hover:underline"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="mt-1 overflow-x-auto font-mono text-[11px] text-ink-secondary">{resendResult.link}</p>
          </div>
        )}

        <div className="mt-4 divide-y divide-gridline rounded-lg border border-border">
          {users === null ? (
            <p className="p-4 text-sm text-ink-muted">Loading…</p>
          ) : users.length === 0 ? (
            <p className="p-4 text-sm text-ink-muted">No users in this org yet.</p>
          ) : (
            users.map((u) => (
              <div key={u.id} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-medium text-ink-primary">{u.username}</p>
                  <p className="text-xs text-ink-muted">{u.role}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleResendInvite(u)}
                    disabled={resendBusy === u.id}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-ink-secondary hover:bg-gridline/40 disabled:opacity-50"
                  >
                    {resendBusy === u.id ? "Sending…" : "Resend setup link"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setResetTarget(u)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                  >
                    Reset password
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Close
          </button>
        </div>
      </div>

      {resetTarget && (
        <ResetOrgPasswordModal
          org={org}
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => {
            setJustReset(resetTarget.username);
            setResetTarget(null);
          }}
        />
      )}
    </div>
  );
}

function Organizations({ username }: { username: string }) {
  const isPlatformAdmin = getStoredIsPlatformAdmin();
  const [orgs, setOrgs] = useState<OrganizationSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<CreateOrgResult | null>(null);
  const [manageUsersOrg, setManageUsersOrg] = useState<OrganizationSummary | null>(null);
  const [domainOrg, setDomainOrg] = useState<OrganizationSummary | null>(null);
  const [renameOrg, setRenameOrg] = useState<OrganizationSummary | null>(null);
  const [suspendConfirmOrg, setSuspendConfirmOrg] = useState<OrganizationSummary | null>(null);
  const [deleteOrgTarget, setDeleteOrgTarget] = useState<OrganizationSummary | null>(null);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function reload(): void {
    getOrganizations()
      .then((res) => setOrgs(res.orgs))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load organizations.")));
  }

  // Suspending is disruptive (blocks that org's logins and agent
  // connections immediately) so it goes through a confirm dialog;
  // reactivating just undoes that, no confirmation needed.
  async function handleReactivate(org: OrganizationSummary): Promise<void> {
    setStatusBusyId(org.id);
    setActionError(null);
    try {
      await setOrgStatus(org.id, "active");
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to reactivate organization."));
    } finally {
      setStatusBusyId(null);
    }
  }

  async function handleConfirmSuspend(): Promise<void> {
    if (!suspendConfirmOrg) return;
    setStatusBusyId(suspendConfirmOrg.id);
    setActionError(null);
    try {
      await setOrgStatus(suspendConfirmOrg.id, "suspended");
      setSuspendConfirmOrg(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to suspend organization."));
    } finally {
      setStatusBusyId(null);
    }
  }

  useEffect(() => {
    if (isPlatformAdmin) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isPlatformAdmin) {
    return (
      <AppShell username={username}>
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-status-critical">
          You don't have permission to view this page.
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
              <span className="material-symbols-outlined text-[24px]">corporate_fare</span>
            </span>
            <div>
              <h1 className="text-xl font-semibold text-ink-primary">Organizations</h1>
              <p className="text-xs text-ink-muted">Every customer organization sharing this deployment, and their isolation boundary.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            Create organization
          </button>
        </div>

        {actionError && <p className="text-sm text-status-critical">{actionError}</p>}

        <div className="glass-card overflow-hidden rounded-xl">
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : orgs === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Name", "Subdomain", "Status", "Created", ""].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {orgs.map((org) => (
                  <tr key={org.id}>
                    <td className="p-4 text-sm font-bold text-ink-primary">{org.name}</td>
                    <td className="p-4">
                      <p className="font-mono text-xs text-ink-secondary">{org.subdomain}</p>
                      {org.customDomain && <p className="mt-0.5 font-mono text-[11px] text-accent">{org.customDomain}</p>}
                    </td>
                    <td className="p-4">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          org.status === "active" ? "bg-status-good/10 text-status-good" : "bg-gridline text-ink-muted"
                        }`}
                      >
                        {org.status}
                      </span>
                    </td>
                    <td className="p-4 text-xs text-ink-muted">{formatRelativeTime(new Date(org.createdAt).getTime())}</td>
                    <td className="p-4 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setManageUsersOrg(org)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-gridline/40"
                        >
                          <span className="material-symbols-outlined text-[16px]">group</span>
                          Users
                        </button>
                        <button
                          type="button"
                          onClick={() => setDomainOrg(org)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-gridline/40"
                        >
                          <span className="material-symbols-outlined text-[16px]">language</span>
                          Domain
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadOrgInstaller(org.id, org.subdomain)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-gridline/40"
                        >
                          <span className="material-symbols-outlined text-[16px]">download</span>
                          Installer
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenameOrg(org)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-gridline/40"
                        >
                          <span className="material-symbols-outlined text-[16px]">edit</span>
                          Rename
                        </button>
                        {org.id !== PLATFORM_ORG_ID && (
                          <>
                            <button
                              type="button"
                              onClick={() => (org.status === "active" ? setSuspendConfirmOrg(org) : handleReactivate(org))}
                              disabled={statusBusyId === org.id}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-gridline/40 disabled:opacity-50"
                            >
                              <span className="material-symbols-outlined text-[16px]">{org.status === "active" ? "pause_circle" : "play_circle"}</span>
                              {org.status === "active" ? "Suspend" : "Reactivate"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteOrgTarget(org)}
                              className="inline-flex items-center gap-1.5 rounded-md border border-status-critical/30 px-2.5 py-1 text-xs font-medium text-status-critical hover:bg-status-critical/10"
                            >
                              <span className="material-symbols-outlined text-[16px]">delete</span>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateOrgModal
          onClose={() => setShowCreate(false)}
          onCreated={(result) => {
            setShowCreate(false);
            setJustCreated(result);
            reload();
          }}
        />
      )}

      {justCreated && <CredentialsModal result={justCreated} onClose={() => setJustCreated(null)} />}

      {manageUsersOrg && <ManageUsersModal org={manageUsersOrg} onClose={() => setManageUsersOrg(null)} />}

      {domainOrg && (
        <CustomDomainModal
          org={domainOrg}
          onClose={() => setDomainOrg(null)}
          onDone={() => {
            setDomainOrg(null);
            reload();
          }}
        />
      )}

      {renameOrg && (
        <RenameOrgModal
          org={renameOrg}
          onClose={() => setRenameOrg(null)}
          onDone={() => {
            setRenameOrg(null);
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={suspendConfirmOrg !== null}
        title={`Suspend "${suspendConfirmOrg?.name}"?`}
        message="This immediately blocks every login and agent connection for this organization. It stays fully intact and can be reactivated anytime."
        confirmLabel="Suspend"
        tone="warning"
        busy={statusBusyId === suspendConfirmOrg?.id}
        onConfirm={handleConfirmSuspend}
        onCancel={() => setSuspendConfirmOrg(null)}
      />

      {deleteOrgTarget && (
        <DeleteOrgModal
          org={deleteOrgTarget}
          onClose={() => setDeleteOrgTarget(null)}
          onDeleted={() => {
            setDeleteOrgTarget(null);
            reload();
          }}
        />
      )}
    </AppShell>
  );
}

export default function OrganizationsPage() {
  return <AuthGate>{(username) => <Organizations username={username} />}</AuthGate>;
}
