"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { ApiError, getUsers, createUserAccount, updateUserAccount, deleteUserAccount } from "@/lib/api";
import { getStoredRole } from "@/lib/session";
import { formatRelativeTime } from "@/lib/format";
import type { UserSummary, Role } from "@/lib/types";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", it_support: "IT Support", viewer: "Viewer" };
const ROLE_OPTIONS: Role[] = ["admin", "it_support", "viewer"];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface AddUserModalProps {
  onClose: () => void;
  onCreated: () => void;
}

function AddUserModal({ onClose, onCreated }: AddUserModalProps) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("it_support");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createUserAccount({
        username: username.trim(),
        password,
        role,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Failed to create user."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Add user</h2>
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-ink-secondary">
              First name
              <input
                autoFocus
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              Last name
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>
          <label className="block text-xs text-ink-secondary">
            Email (optional)
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            Password (min. 8 characters)
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="block text-xs text-ink-secondary">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !username.trim() || password.length < 8 || !firstName.trim() || !lastName.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface EditProfileModalProps {
  user: UserSummary;
  onClose: () => void;
  onDone: () => void;
}

// Separate from AddUserModal (create) and ResetPasswordModal (a distinct
// concern below) — edits only first/last name and email for an existing
// account. Pre-fills blank for a legacy account that predates these fields
// rather than showing "null" or leaving the admin unable to tell whether a
// save is filling in missing data vs overwriting something already there.
function EditProfileModal({ user, onClose, onDone }: EditProfileModalProps) {
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateUserAccount(user.id, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err, "Failed to update profile."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Edit profile — {user.username}</h2>
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-ink-secondary">
              First name
              <input
                autoFocus
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-secondary">
              Last name
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </label>
          </div>
          <label className="block text-xs text-ink-secondary">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            />
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-status-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !firstName.trim() || !lastName.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface ResetPasswordModalProps {
  user: UserSummary;
  onClose: () => void;
  onDone: () => void;
}

function ResetPasswordModal({ user, onClose, onDone }: ResetPasswordModalProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateUserAccount(user.id, { password });
      onDone();
    } catch (err) {
      setError(errorMessage(err, "Failed to reset password."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink-primary">Reset password for {user.username}</h2>
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

function Users({ username }: { username: string }) {
  const role = getStoredRole();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<UserSummary | null>(null);
  const [resetTarget, setResetTarget] = useState<UserSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);
  const [busy, setBusy] = useState(false);

  function reload(): void {
    getUsers()
      .then((res) => setUsers(res.users))
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load users.")));
  }

  useEffect(() => {
    if (role === "admin") reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (role !== "admin") {
    return (
      <AppShell username={username}>
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-status-critical">
          You don't have permission to view this page.
        </p>
      </AppShell>
    );
  }

  async function handleRoleChange(user: UserSummary, newRole: Role): Promise<void> {
    setActionError(null);
    try {
      await updateUserAccount(user.id, { role: newRole });
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to update role."));
    }
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteUserAccount(deleteTarget.id);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete user."));
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Users</h1>
            <p className="text-xs text-ink-muted">Manage who can sign in and what they're allowed to do.</p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            Add user
          </button>
        </div>

        {actionError && <p className="rounded-lg border border-status-critical/30 bg-status-critical/5 p-3 text-sm text-status-critical">{actionError}</p>}

        <div className="glass-card overflow-hidden rounded-xl">
          {loadError ? (
            <p className="p-6 text-sm text-status-critical">{loadError}</p>
          ) : users === null ? (
            <p className="p-6 text-sm text-ink-muted">Loading…</p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gridline/30">
                <tr>
                  {["Name", "Username", "Email", "Role", "Created", "Actions"].map((h) => (
                    <th key={h} className="p-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gridline">
                {users.map((u) => {
                  const isSelf = u.username === username;
                  const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ");
                  return (
                    <tr key={u.id}>
                      <td className="p-4 text-sm font-bold text-ink-primary">
                        {fullName || <span className="font-normal text-ink-muted">—</span>}
                        {isSelf && <span className="ml-2 text-[11px] font-normal text-ink-muted">(you)</span>}
                      </td>
                      <td className="p-4 text-sm text-ink-secondary">{u.username}</td>
                      <td className="p-4 text-xs text-ink-muted">{u.email || "—"}</td>
                      <td className="p-4">
                        <select
                          value={u.role}
                          onChange={(e) => handleRoleChange(u, e.target.value as Role)}
                          className="rounded-md border border-border bg-page px-2 py-1 text-xs text-ink-primary outline-none focus:ring-2 focus:ring-accent"
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-4 text-xs text-ink-muted">{formatRelativeTime(new Date(u.createdAt).getTime())}</td>
                      <td className="p-4">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setEditTarget(u)}
                            className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setResetTarget(u)}
                            className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:bg-gridline/40"
                          >
                            Reset password
                          </button>
                          <button
                            type="button"
                            disabled={isSelf}
                            onClick={() => setDeleteTarget(u)}
                            className="rounded-md border border-status-critical/40 px-2 py-1 text-xs text-status-critical hover:bg-status-critical/10 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showAdd && (
        <AddUserModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            reload();
          }}
        />
      )}

      {editTarget && (
        <EditProfileModal
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onDone={() => {
            setEditTarget(null);
            reload();
          }}
        />
      )}

      {resetTarget && (
        <ResetPasswordModal
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => setResetTarget(null)}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this user?"
        message={deleteTarget ? `Delete the account "${deleteTarget.username}"? This can't be undone.` : ""}
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </AppShell>
  );
}

export default function UsersPage() {
  return <AuthGate>{(username) => <Users username={username} />}</AuthGate>;
}
