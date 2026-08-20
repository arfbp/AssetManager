"use client";

import { useRef, useState } from "react";
import { parseCsv, readCsvFile, toCsv } from "@/lib/csv";
import { importAssets, ApiError, type ImportAssetsResult } from "@/lib/api";
import type { AssetInput, AssetStatus, AssetType } from "@/lib/types";

const STATUS_LABEL: Record<AssetStatus, string> = {
  ready_to_deploy: "Ready to deploy",
  deployed: "Deployed",
  in_repair: "In repair",
  retired: "Retired",
};
// รับได้ทั้งค่าดิบที่เก็บจริง ("ready_to_deploy") หรือ label ที่แสดงใน
// หน้าจออื่นๆ ("Ready to deploy") — สเปรดชีตที่คนกรอกเองมักจะเป็นแบบหลัง
// มากกว่า
const STATUS_BY_LOOKUP: Record<string, AssetStatus> = Object.fromEntries([
  ...Object.entries(STATUS_LABEL).map(([value, label]) => [label.toLowerCase(), value as AssetStatus]),
  ...(Object.keys(STATUS_LABEL) as AssetStatus[]).map((v) => [v, v]),
]);

// แม็ป header ของ CSV (lowercase, trim แล้ว) ไปยัง field ของ AssetInput
// ที่จะเติมค่า header หลายแบบสะกดต่างกันแม็ปไปที่ field เดียวกัน
// ครอบคลุมสิ่งที่ผู้ใช้มักพิมพ์ลงในหัวคอลัมน์สเปรดชีตตามธรรมชาติ
const HEADER_MAP: Record<string, keyof (AssetInput & { assetTag?: string })> = {
  "asset tag": "assetTag",
  assettag: "assetTag",
  tag: "assetTag",
  status: "status",
  category: "category",
  location: "location",
  "order number": "orderNumber",
  ordernumber: "orderNumber",
  "checked out to": "checkedOutTo",
  checkedoutto: "checkedOutTo",
  // ทั้งสองคอลัมน์นี้มีอยู่ใน asset อยู่แล้ว (migrations/0012) แต่ไม่เคย
  // เชื่อมเข้ากับการนำเข้า CSV จนกระทั่งตอนนี้ ตั้งใจไม่ resolve กับ
  // directory พนักงานตรงนี้ — การจับคู่ชื่อเป็นชุดใหญ่แบบไม่มีคนตรวจสอบ
  // คือรูปแบบความผิดพลาดที่ฟีเจอร์นี้พยายามเลี่ยงในจุดอื่นๆ อยู่แล้ว (ดู
  // doc comment "no automatic backfill" ใน migrations/0030) แถวที่นำเข้า
  // จะเก็บเป็น free text ไปก่อน แล้วไปเชื่อมทีละรายการจากหน้ารายละเอียด
  // พนักงานได้
  email: "checkedOutToEmail",
  "checked out to email": "checkedOutToEmail",
  checkedoutemail: "checkedOutToEmail",
  department: "checkedOutToDepartment",
  "checked out to department": "checkedOutToDepartment",
  "checkout date": "checkoutDate",
  "expected checkin date": "expectedCheckinDate",
  "expected check-in date": "expectedCheckinDate",
  "eol date": "eolDate",
  "end of life": "eolDate",
  notes: "notes",
  "serial number": "manualSerialNumber",
  serial: "manualSerialNumber",
  "asset type": "assetType",
  assettype: "assetType",
  manufacturer: "manufacturer",
  model: "model",
  "linked device": "agentId",
  "agent id": "agentId",
  agentid: "agentId",
};

const TEMPLATE_HEADERS = [
  "Asset Tag",
  "Status",
  "Asset Type",
  "Category",
  "Location",
  "Manufacturer",
  "Model",
  "Serial Number",
  "Order Number",
  "Checked Out To",
  "Email",
  "Department",
  "Checkout Date",
  "Expected Checkin Date",
  "EOL Date",
  "Notes",
  "Linked Device",
];
const TEMPLATE_EXAMPLE_ROW = [
  "",
  "Ready to deploy",
  "computer",
  "Laptop",
  "Bangkok HQ",
  "Dell",
  "Latitude 5440",
  "SN12345",
  "PO-2026-001",
  "",
  "",
  "",
  "",
  "",
  "2029-01-01",
  "",
  "",
];

type ParsedRow = AssetInput & { assetTag?: string; _rowNumber: number };

interface ParseOutcome {
  rows: ParsedRow[];
  recognizedHeaders: string[];
  ignoredHeaders: string[];
}

function parseAssetsCsv(text: string): ParseOutcome {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], recognizedHeaders: [], ignoredHeaders: [] };

  const headerRow = table[0]!.map((h) => h.trim());
  const fieldByColumn = headerRow.map((h) => HEADER_MAP[h.toLowerCase()]);
  const recognizedHeaders = headerRow.filter((_, i) => fieldByColumn[i]);
  const ignoredHeaders = headerRow.filter((_, i) => !fieldByColumn[i]);

  const rows: ParsedRow[] = table.slice(1).map((cells, i) => {
    const row: ParsedRow = { _rowNumber: i + 2 }; // +2: เริ่มนับที่ 1 บวกด้วยแถว header เอง
    cells.forEach((raw, colIndex) => {
      const field = fieldByColumn[colIndex];
      const value = raw.trim();
      if (!field || !value) return;
      if (field === "status") {
        const status = STATUS_BY_LOOKUP[value.toLowerCase()];
        if (status) row.status = status;
      } else if (field === "assetType") {
        const lower = value.toLowerCase();
        if (lower === "computer" || lower === "peripheral") row.assetType = lower as AssetType;
      } else {
        (row as unknown as Record<string, string>)[field] = value;
      }
    });
    return row;
  });

  return { rows: rows.filter((r) => Object.keys(r).length > 1), recognizedHeaders, ignoredHeaders };
}

function downloadTemplate(): void {
  const csv = toCsv([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE_ROW]);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "optifleet-asset-import-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

interface ImportAssetsModalProps {
  onClose: () => void;
  onImported: () => void;
}

/**
 * โหลด → ดูตัวอย่าง → ยืนยัน สำหรับนำเข้าข้อมูล Asset Registry เป็นชุด
 * parse ข้อมูลทั้งหมดทำฝั่ง client (ดู lib/csv.ts) เพื่อให้ผู้ใช้เห็น
 * ชัดเจนว่ากำลังจะส่งอะไรไปก่อนที่จะแตะเซิร์ฟเวอร์จริง — POST
 * /api/assets/import จะถูกเรียกก็ต่อเมื่อกด "Confirm import" เท่านั้น
 */
export function ImportAssetsModal({ onClose, onImported }: ImportAssetsModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseOutcome | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<{ results: ImportAssetsResult[]; summary: { created: number; updated: number; failed: number } } | null>(
    null,
  );

  function handleFile(file: File): void {
    setFileName(file.name);
    setParseError(null);
    setResults(null);
    readCsvFile(file)
      .then((text) => {
        const outcome = parseAssetsCsv(text);
        if (outcome.rows.length === 0) {
          setParseError("No usable rows found — check the file has a header row and at least one data row.");
          setParsed(null);
          return;
        }
        setParsed(outcome);
      })
      .catch(() => setParseError("Couldn't read that file."));
  }

  async function handleConfirm(): Promise<void> {
    if (!parsed) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const rows = parsed.rows.map(({ _rowNumber: _unused, ...rest }) => rest);
      const res = await importAssets(rows);
      setResults(res);
      if (res.summary.failed === 0) onImported();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" aria-label="Dismiss" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Import assets</h2>
          <button type="button" onClick={downloadTemplate} className="text-xs font-medium text-accent hover:underline">
            Download CSV template
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          Upload a CSV, review what will be imported, then confirm. Rows with an existing Asset Tag update that
          asset; rows with no Asset Tag (or one that doesn't exist yet) create a new one.
        </p>

        <div className="mt-4 flex-1 overflow-y-auto">
          {!parsed && !results && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
              >
                Choose CSV file
              </button>
              {fileName && <p className="mt-2 text-xs text-ink-muted">{fileName}</p>}
              {parseError && <p className="mt-2 text-xs text-status-critical">{parseError}</p>}
            </div>
          )}

          {parsed && !results && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-secondary">
                <span>
                  <strong className="text-ink-primary">{fileName}</strong> — {parsed.rows.length} row
                  {parsed.rows.length === 1 ? "" : "s"} ready to import
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setParsed(null);
                    setFileName(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="text-accent hover:underline"
                >
                  Choose a different file
                </button>
              </div>
              {parsed.ignoredHeaders.length > 0 && (
                <p className="mt-1 text-[11px] text-ink-muted">
                  Ignored columns (not recognized): {parsed.ignoredHeaders.join(", ")}
                </p>
              )}

              <div className="mt-3 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[600px] text-left text-xs">
                  <thead className="bg-gridline/30">
                    <tr>
                      {["Row", "Asset Tag", "Type", "Status", "Manufacturer", "Model", "Serial", "Location"].map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold uppercase tracking-wide text-ink-muted">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gridline">
                    {parsed.rows.map((r) => (
                      <tr key={r._rowNumber}>
                        <td className="px-3 py-1.5 text-ink-muted">{r._rowNumber}</td>
                        <td className="px-3 py-1.5 text-ink-primary">{r.assetTag || <span className="text-ink-muted">(auto)</span>}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.assetType ?? "computer"}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.status ? STATUS_LABEL[r.status] : "—"}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.manufacturer || "—"}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.model || "—"}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.manualSerialNumber || "—"}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.location || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {submitError && <p className="mt-3 text-xs text-status-critical">{submitError}</p>}
            </div>
          )}

          {results && (
            <div>
              <p className="text-sm text-ink-primary">
                <span className="font-semibold text-status-good">{results.summary.created} created</span>,{" "}
                <span className="font-semibold text-accent">{results.summary.updated} updated</span>
                {results.summary.failed > 0 && (
                  <>
                    , <span className="font-semibold text-status-critical">{results.summary.failed} failed</span>
                  </>
                )}
              </p>
              {results.summary.failed > 0 && (
                <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-border">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-gridline/30">
                      <tr>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide text-ink-muted">Row</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide text-ink-muted">Asset Tag</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide text-ink-muted">Error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gridline">
                      {results.results
                        .filter((r) => r.action === "failed")
                        .map((r) => (
                          <tr key={r.index}>
                            <td className="px-3 py-1.5 text-ink-muted">{r.index + 2}</td>
                            <td className="px-3 py-1.5 text-ink-primary">{r.assetTag || "(auto)"}</td>
                            <td className="px-3 py-1.5 text-status-critical">{r.error}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:bg-gridline/40">
            {results ? "Close" : "Cancel"}
          </button>
          {parsed && !results && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={busy}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Importing…" : `Confirm import (${parsed.rows.length})`}
            </button>
          )}
          {results && results.summary.failed > 0 && (
            <button
              type="button"
              onClick={() => {
                setResults(null);
                setParsed(null);
                setFileName(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Fix and try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
