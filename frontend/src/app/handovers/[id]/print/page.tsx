"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AuthGate } from "@/components/auth/AuthGate";
import { ApiError, getHandover, getAssets } from "@/lib/api";
import { getOrgBranding, resolveLogoUrl } from "@/lib/branding";
import type { AssetWithLiveInfo, Handover } from "@/lib/types";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// หน้านี้แยกอิสระ — ตั้งใจไม่ครอบด้วย AppShell เพื่อไม่ให้ sidebar/header
// ติดไปกับหน้าที่พิมพ์ออกมา ส่วน @media print ด้านล่างจะซ่อนปุ่ม
// "Print"/"Back" ที่มีไว้ดูบนจอเท่านั้น เหลือแค่ตัวฟอร์มล้วน ๆ
function HandoverPrint({ id }: { id: string }) {
  const router = useRouter();
  const [handover, setHandover] = useState<Handover | null>(null);
  const [asset, setAsset] = useState<AssetWithLiveInfo | null>(null);
  const [orgName, setOrgName] = useState("OptiFleet AI");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getHandover(id), getAssets(), getOrgBranding()])
      .then(([h, a, branding]) => {
        setHandover(h.handover);
        setAsset(a.assets.find((asset) => asset.assetTag === h.handover.assetTag) ?? null);
        if (branding) {
          setOrgName(branding.name);
          if (branding.logoUrl) setLogoUrl(resolveLogoUrl(branding.logoUrl));
        }
      })
      .catch((err) => setError(errorMessage(err, "Couldn't load this handover.")));
  }, [id]);

  if (error) return <p className="p-8 text-sm text-status-critical">{error}</p>;
  if (!handover) return <p className="p-8 text-sm text-ink-muted">Loading…</p>;

  return (
    <div className="mx-auto min-h-screen max-w-[720px] bg-white p-10 text-black print:p-0">
      <div className="mb-6 flex items-center justify-between gap-3 print:hidden">
        <button type="button" onClick={() => router.push("/handovers")} className="text-sm text-ink-secondary hover:underline">
          ← Back to Handovers
        </button>
        <button type="button" onClick={() => window.print()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
          Print
        </button>
      </div>

      <div className="flex items-center gap-3 border-b-2 border-black pb-4">
        {logoUrl && <img src={logoUrl} alt="" className="h-12 w-auto" />}
        <div>
          <h1 className="text-lg font-bold">{orgName}</h1>
          <p className="text-sm">Equipment Handover / Custody Receipt</p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
        <div>
          <p className="font-semibold uppercase tracking-wide text-gray-500">Asset Tag</p>
          <p>{handover.assetTag}</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-wide text-gray-500">Handover Date</p>
          <p>{handover.handoverDate.slice(0, 10)}</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-wide text-gray-500">Manufacturer / Model</p>
          <p>{asset ? [asset.manufacturer, asset.model].filter(Boolean).join(" ") || "—" : "—"}</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-wide text-gray-500">Serial Number</p>
          <p>{asset?.serialNumber || "—"}</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-wide text-gray-500">Employee Name</p>
          <p>{handover.employeeName}</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-wide text-gray-500">Department</p>
          <p>{handover.employeeDepartment || "—"}</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-wide text-gray-500">Email</p>
          <p>{handover.employeeEmail || "—"}</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-wide text-gray-500">Issued By</p>
          <p>{handover.issuedBy}</p>
        </div>
      </div>

      {handover.conditionNotes && (
        <div className="mt-4 text-sm">
          <p className="font-semibold uppercase tracking-wide text-gray-500">Condition Notes</p>
          <p>{handover.conditionNotes}</p>
        </div>
      )}

      <p className="mt-8 text-sm leading-relaxed">
        By signing below, the employee named above acknowledges receipt of the equipment described in this record, in the condition noted, and
        accepts responsibility for its care and return upon request or separation.
      </p>

      <div className="mt-14 grid grid-cols-2 gap-8">
        <div>
          <div className="h-16 border-b border-black" />
          <p className="mt-1 text-xs">Employee Signature</p>
          <div className="mt-6 h-8 border-b border-black" />
          <p className="mt-1 text-xs">Printed Name / Date</p>
        </div>
        <div>
          <div className="h-16 border-b border-black" />
          <p className="mt-1 text-xs">IT Staff Signature</p>
          <div className="mt-6 h-8 border-b border-black" />
          <p className="mt-1 text-xs">Printed Name / Date</p>
        </div>
      </div>
    </div>
  );
}

export default function HandoverPrintPage() {
  const params = useParams<{ id: string }>();
  return <AuthGate>{() => <HandoverPrint id={params.id} />}</AuthGate>;
}
