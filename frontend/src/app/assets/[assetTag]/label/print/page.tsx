"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import QRCode from "qrcode";
import { AuthGate } from "@/components/auth/AuthGate";
import { getOrgBranding, resolveLogoUrl } from "@/lib/branding";

// แยกเดี่ยว ไม่มี AppShell ครอบ เหมือน handovers/[id]/print เพื่อให้ label
// ที่พิมพ์ออกมาเป็นแค่ label ไม่ติด dashboard รอบ ๆ ไปด้วย
function LabelPrint({ assetTag }: { assetTag: string }) {
  const router = useRouter();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [orgName, setOrgName] = useState("OptiFleet AI");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    const detailUrl = `${window.location.origin}/assets/${encodeURIComponent(assetTag)}`;
    QRCode.toDataURL(detailUrl, { width: 240, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
    getOrgBranding().then((branding) => {
      if (!branding) return;
      setOrgName(branding.name);
      if (branding.logoUrl) setLogoUrl(resolveLogoUrl(branding.logoUrl));
    });
  }, [assetTag]);

  return (
    <div className="mx-auto min-h-screen max-w-[420px] bg-white p-8 text-black print:p-0">
      <div className="mb-6 flex items-center justify-between gap-3 print:hidden">
        <button type="button" onClick={() => router.push(`/assets/${encodeURIComponent(assetTag)}`)} className="text-sm text-ink-secondary hover:underline">
          ← Back
        </button>
        <button type="button" onClick={() => window.print()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
          Print
        </button>
      </div>

      <div className="flex flex-col items-center rounded-lg border-2 border-black p-6 text-center">
        {logoUrl && <img src={logoUrl} alt="" className="mb-2 h-8 w-auto" />}
        <p className="text-xs font-semibold uppercase tracking-wide">{orgName}</p>
        {qrDataUrl && <img src={qrDataUrl} alt="QR code" className="my-3 h-48 w-48" />}
        <p className="font-mono text-lg font-bold">{assetTag}</p>
        <p className="mt-1 text-[10px] text-gray-500">Scan to view asset details</p>
      </div>
    </div>
  );
}

export default function AssetLabelPrintPage() {
  const params = useParams<{ assetTag: string }>();
  return (
    <AuthGate>
      {() => <LabelPrint assetTag={decodeURIComponent(params.assetTag)} />}
    </AuthGate>
  );
}
