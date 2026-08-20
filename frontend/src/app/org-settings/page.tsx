"use client";

import { useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { getOrgBranding, resolveLogoUrl, uploadOrgLogo, removeOrgLogo, type OrgBranding } from "@/lib/branding";
import { getStoredOrgId } from "@/lib/session";
import { ApiError, getCustomFieldLabels, setCustomFieldLabels, getCheckoutEula, setCheckoutEula } from "@/lib/api";
import type { CustomFieldLabels } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

const ACCEPTED_TYPES = "image/png,image/jpeg,image/svg+xml,image/webp";

function OrgSettings({ username }: { username: string }) {
  const orgId = getStoredOrgId();
  const [branding, setBranding] = useState<OrgBranding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [labels, setLabels] = useState<CustomFieldLabels>({ field1Label: null, field2Label: null, field3Label: null, field4Label: null, field5Label: null });
  const [labelsBusy, setLabelsBusy] = useState(false);
  const [labelsSaved, setLabelsSaved] = useState(false);

  const [eulaText, setEulaText] = useState("");
  const [eulaBusy, setEulaBusy] = useState(false);
  const [eulaSaved, setEulaSaved] = useState(false);

  function reload(): void {
    getOrgBranding().then(setBranding);
    getCustomFieldLabels().then((res) => setLabels(res.labels));
    if (orgId) getCheckoutEula(orgId).then((res) => setEulaText(res.checkoutEulaText ?? ""));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveLabels(): Promise<void> {
    setLabelsBusy(true);
    setLabelsSaved(false);
    try {
      const res = await setCustomFieldLabels(labels);
      setLabels(res.labels);
      setLabelsSaved(true);
    } finally {
      setLabelsBusy(false);
    }
  }

  async function handleSaveEula(): Promise<void> {
    if (!orgId) return;
    setEulaBusy(true);
    setEulaSaved(false);
    try {
      await setCheckoutEula(orgId, eulaText.trim() || null);
      setEulaSaved(true);
    } finally {
      setEulaBusy(false);
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !orgId) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await uploadOrgLogo(orgId, file);
      setSuccess("Logo updated.");
      reload();
    } catch (err) {
      setError(errorMessage(err, "Failed to upload logo."));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(): Promise<void> {
    if (!orgId) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await removeOrgLogo(orgId);
      setSuccess("Logo removed — back to the default mark.");
      reload();
    } catch (err) {
      setError(errorMessage(err, "Failed to remove logo."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell username={username}>
      <div className="mx-auto flex max-w-[720px] flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-series-6/10 text-series-6">
            <span className="material-symbols-outlined text-[24px]">palette</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Branding</h1>
            <p className="text-xs text-ink-muted">Your own logo, shown on your login page, sidebar, and browser tab instead of the default mark.</p>
          </div>
        </div>

        <Panel className="p-6">
          <div className="flex items-center gap-5">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-border bg-page">
              {branding?.logoUrl ? (
                <img src={resolveLogoUrl(branding.logoUrl)} alt="Current logo" className="h-14 w-14 object-contain" />
              ) : (
                <img src="/optifleet-mark.svg" alt="Default OptiFleet mark" className="h-10 w-10 opacity-50" />
              )}
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-ink-primary">{branding?.logoUrl ? "Custom logo active" : "Using the default OptiFleet mark"}</p>
              <p className="text-xs text-ink-muted">PNG, JPEG, SVG, or WebP — up to 5MB.</p>
            </div>
          </div>

          {error && <p className="mt-4 text-sm text-status-critical">{error}</p>}
          {success && <p className="mt-4 text-sm text-status-good">{success}</p>}

          <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} onChange={handleFileSelected} className="hidden" />
          <div className="mt-5 flex gap-2">
            <Button variant="primary" icon="upload" disabled={busy || !orgId} onClick={() => fileInputRef.current?.click()}>
              {busy ? "Uploading…" : "Upload logo"}
            </Button>
            {branding?.logoUrl && (
              <Button variant="danger" icon="delete" disabled={busy} onClick={handleRemove}>
                Remove custom logo
              </Button>
            )}
          </div>
        </Panel>

        <Panel className="p-6">
          <h2 className="text-sm font-semibold text-ink-primary">Asset custom fields</h2>
          <p className="mt-1 text-xs text-ink-muted">Name up to five extra fields to track on assets — leave blank to hide a slot everywhere in the UI.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {([1, 2, 3, 4, 5] as const).map((n) => {
              const key = `field${n}Label` as keyof CustomFieldLabels;
              return (
                <label key={n} className="block text-xs text-ink-secondary">
                  Field {n}
                  <input
                    value={labels[key] ?? ""}
                    onChange={(e) => setLabels((prev) => ({ ...prev, [key]: e.target.value || null }))}
                    placeholder="e.g. Cost Center"
                    className="mt-1 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
                  />
                </label>
              );
            })}
          </div>
          {labelsSaved && <p className="mt-3 text-sm text-status-good">Saved.</p>}
          <div className="mt-4">
            <Button variant="primary" disabled={labelsBusy} onClick={handleSaveLabels}>
              {labelsBusy ? "Saving…" : "Save custom fields"}
            </Button>
          </div>
        </Panel>

        <Panel className="p-6">
          <h2 className="text-sm font-semibold text-ink-primary">Checkout terms (EULA)</h2>
          <p className="mt-1 text-xs text-ink-muted">
            When set, employees see this text and must accept + sign on screen before a handover is marked signed. Leave blank to keep the plain
            print-and-physically-sign flow with no forced acceptance step.
          </p>
          <textarea
            value={eulaText}
            onChange={(e) => setEulaText(e.target.value)}
            rows={6}
            placeholder="e.g. By accepting this equipment, you agree to return it in working condition upon request..."
            className="mt-4 w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:ring-2 focus:ring-accent"
          />
          {eulaSaved && <p className="mt-3 text-sm text-status-good">Saved.</p>}
          <div className="mt-4">
            <Button variant="primary" disabled={eulaBusy || !orgId} onClick={handleSaveEula}>
              {eulaBusy ? "Saving…" : "Save checkout terms"}
            </Button>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}

export default function OrgSettingsPage() {
  return <AuthGate>{(username) => <OrgSettings username={username} />}</AuthGate>;
}
