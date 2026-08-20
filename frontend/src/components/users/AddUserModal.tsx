"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createUserAccount } from "@/lib/api";
import type { Role } from "@/lib/types";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", it_support: "IT Support", viewer: "Viewer" };
const ROLE_OPTIONS: Role[] = ["admin", "it_support", "viewer"];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export interface AddUserPrefill {
  username?: string;
  role?: string;
  firstName?: string;
  lastName?: string;
}

function isRole(value: string | undefined): value is Role {
  return value === "admin" || value === "it_support" || value === "viewer";
}

interface AddUserModalProps {
  onClose: () => void;
  onCreated: () => void;
  // ค่าที่ดึงมาแบบเดาที่ดีที่สุดจาก AI console (ดูผลตัดสิน "admin_form"
  // ใน server/src/security/adminGuardrail.ts) — ผู้ใช้ยังต้องตรวจสอบ ตั้ง
  // รหัสผ่านเอง และแก้ไขได้ทุก field ก่อนกดส่ง ไม่มีอะไรถูกสร้างจนกว่าจะ
  // กดยืนยัน เป็น empty/undefined เมื่อเปิดจากปุ่ม "Add user" ของหน้า
  // Users เอง
  prefill?: AddUserPrefill;
}

export function AddUserModal({ onClose, onCreated, prefill }: AddUserModalProps) {
  const [firstName, setFirstName] = useState(prefill?.firstName ?? "");
  const [lastName, setLastName] = useState(prefill?.lastName ?? "");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState(prefill?.username ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(isRole(prefill?.role) ? prefill.role : "it_support");
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
