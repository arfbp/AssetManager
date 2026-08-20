"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createOrganization, type CreateOrgResult } from "@/lib/api";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// การพรีวิว subdomain ใช้ตรรกะเดียวกับ currentOrgSubdomain() ใน
// session.ts — org นี้ยังเข้าไม่ได้จริงที่ "<subdomain>.optifleet.ai"
// จนกว่า domain/DNS จริงของ Phase 6 จะพร้อมใช้งาน แสดงไว้ตรงนี้เพื่อให้
// ผู้ใช้เห็นว่ากำลังจะผูกกับชื่ออะไรก่อนสร้างรายการจริง
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export interface CreateOrgPrefill {
  name?: string;
  subdomain?: string;
  adminUsername?: string;
  adminEmail?: string;
}

interface CreateOrgModalProps {
  onClose: () => void;
  onCreated: (result: CreateOrgResult) => void;
  // ค่าที่ดึงมาแบบเดาที่ดีที่สุดจาก AI console (ดูผลตัดสิน "admin_form"
  // ใน server/src/security/adminGuardrail.ts) — ผู้ใช้ยังต้องตรวจสอบและ
  // แก้ไขได้ทุก field ก่อนกดส่งอยู่ดี ไม่มีอะไรถูกสร้างจนกว่าจะกดยืนยัน
  // เป็น empty/undefined เมื่อเปิดจากปุ่ม "Create organization" ของหน้า
  // Organizations เอง
  prefill?: CreateOrgPrefill;
}

export function CreateOrgModal({ onClose, onCreated, prefill }: CreateOrgModalProps) {
  const [name, setName] = useState(prefill?.name ?? "");
  const [subdomain, setSubdomain] = useState(prefill?.subdomain ?? "");
  const [subdomainTouched, setSubdomainTouched] = useState(Boolean(prefill?.subdomain));
  const [adminFirstName, setAdminFirstName] = useState("");
  const [adminLastName, setAdminLastName] = useState("");
  const [adminUsername, setAdminUsername] = useState(prefill?.adminUsername ?? "");
  const [adminEmail, setAdminEmail] = useState(prefill?.adminEmail ?? "");
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
