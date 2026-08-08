"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import {
  ApiError,
  getOrganizations,
  createOrganization,
  downloadOrgInstaller,
  getOrgUsers,
  resetOrgUserPassword,
  resendInvite,
  type OrganizationSummary,
  type CreateOrgResult,
} from "@/lib/api";
import { getStoredIsPlatformAdmin } from "@/lib/session";
import { formatRelativeTime } from "@/lib/format";
import type { UserSummary } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Subdomain preview mirrors session.ts's currentOrgSubdomain() — this org
// won't actually be reachable at "<subdomain>.optifleet.ai" until Phase 6's
// real domain/DNS is live; shown here so the operator can see what they're
// committing to before creating the row.
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

interface CreateOrgModalProps {
  onClose: () => void;
  onCreated: (result: CreateOrgResult) => void;
}

function CreateOrgModal({ onClose, onCreated }: CreateOrgModalProps) {
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [subdomainTouched, setSubdomainTouched] = useState(false);
  const [adminFirstName, setAdminFirstName] = useState("");
  const [adminLastName, setAdminLastName] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSubdomain = subdomainTouched ? subdomain : slugify(name);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createOrganization({
        name: name.trim(),
        subdomain: effectiveSubdomain,
        adminUsername: adminUsername.trim(),
        adminFirstName: adminFirstName.trim(),
        adminLastName: adminLastName.trim(),
        adminEmail: adminEmail.trim() || undefined,
      });
      onCreated(result);
    } catch (err) {
      setError(errorMessage(err, "Failed to create organization."));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = name.trim() && effectiveSubdomain && adminUsername.trim() && adminFirstName.trim() && adminLastName.trim();

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Create organization</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Generates a fresh, isolated agent auth token + HMAC secret and creates this org's first admin account. The admin sets their own
          password via a one-time setup link — nobody else ever knows it.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-ink-secondary">
            Organization name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              placeholder="Acme Logistics"
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            Subdomain
            <input
              value={effectiveSubdomain}
              onChange={(e) => {
                setSubdomainTouched(true);
                setSubdomain(slugify(e.target.value));
              }}
              disabled={busy}
              placeholder="acme"
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
            <span className="mt-1 block text-[11px] text-ink-muted">
              Will be reachable at {effectiveSubdomain || "<subdomain>"}.optifleet.ai once the fleet's real domain is live.
            </span>
          </label>

          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">First admin account</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block text-xs text-ink-secondary">
                First name
                <input
                  value={adminFirstName}
                  onChange={(e) => setAdminFirstName(e.target.value)}
                  disabled={busy}
                  className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                />
              </label>
              <label className="block text-xs text-ink-secondary">
                Last name
                <input
                  value={adminLastName}
                  onChange={(e) => setAdminLastName(e.target.value)}
                  disabled={busy}
                  className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                />
              </label>
            </div>
            <label className="mt-2 block text-xs text-ink-secondary">
              Username
              <input
                value={adminUsername}
                onChange={(e) => setAdminUsername(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="mt-2 block text-xs text-ink-secondary">
              Email (optional — sends the setup link automatically if SMTP is configured)
              <input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                disabled={busy}
                placeholder="admin@customer.com"
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !canSubmit}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create organization"}
          </button>
        </div>
      </form>
    </div>
  );
}

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

  function reload(): void {
    getOrganizations()
      .then((res) => setOrgs(res.orgs))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load organizations.")));
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
                    <td className="p-4 font-mono text-xs text-ink-secondary">{org.subdomain}</td>
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
                      <div className="flex justify-end gap-2">
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
                          onClick={() => downloadOrgInstaller(org.id, org.subdomain)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-gridline/40"
                        >
                          <span className="material-symbols-outlined text-[16px]">download</span>
                          Installer
                        </button>
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
    </AppShell>
  );
}

export default function OrganizationsPage() {
  return <AuthGate>{(username) => <Organizations username={username} />}</AuthGate>;
}
