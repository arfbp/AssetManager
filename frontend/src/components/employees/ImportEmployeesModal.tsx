"use client";

import { useRef, useState } from "react";
import { parseCsv, readCsvFile, toCsv } from "@/lib/csv";
import { importEmployees, ApiError, type ImportEmployeesResult } from "@/lib/api";
import type { EmployeeInput, EmployeeStatus } from "@/lib/types";

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  active: "Active",
  inactive: "Inactive",
};
// รับได้ทั้งค่าดิบที่เก็บจริง ("active") หรือ label ที่แสดงในหน้าจออื่นๆ
// ("Active") — สะดวกแบบเดียวกับ STATUS_BY_LOOKUP ใน ImportAssetsModal.tsx
const STATUS_BY_LOOKUP: Record<string, EmployeeStatus> = Object.fromEntries([
  ...Object.entries(STATUS_LABEL).map(([value, label]) => [label.toLowerCase(), value as EmployeeStatus]),
  ...(Object.keys(STATUS_LABEL) as EmployeeStatus[]).map((v) => [v, v]),
]);

type ImportRow = EmployeeInput & { department?: string; _rowNumber: number };

// แม็ป header ของ CSV (lowercase, trim แล้ว) ไปยัง field ที่จะเติมค่า
// `department` เป็น plain text ไม่ใช่ departmentId — ฝั่งเซิร์ฟเวอร์จะ
// resolve จากชื่อเอง และสร้างแผนกใหม่อัตโนมัติถ้ายังไม่มีชื่อนี้ (ดู
// POST /employees/import ใน routes.ts ว่าทำไมกรณีนี้ auto-create ได้อย่าง
// ปลอดภัย ต่างจากการจับคู่ชื่อพนักงาน)
const HEADER_MAP: Record<string, keyof ImportRow> = {
  name: "name",
  "employee code": "employeeCode",
  employeecode: "employeeCode",
  code: "employeeCode",
  email: "email",
  phone: "phone",
  "job title": "jobTitle",
  jobtitle: "jobTitle",
  title: "jobTitle",
  department: "department",
  dept: "department",
  status: "status",
  "start date": "startDate",
  startdate: "startDate",
  "end date": "endDate",
  enddate: "endDate",
  notes: "notes",
};

const TEMPLATE_HEADERS = ["Name", "Employee Code", "Department", "Job Title", "Email", "Phone", "Status", "Start Date", "End Date", "Notes"];
const TEMPLATE_EXAMPLE_ROW = ["Somchai Jaidee", "EMP-001", "Engineering", "IT Support", "somchai@example.com", "081-234-5678", "Active", "2026-01-01", "", ""];

interface ParseOutcome {
  rows: ImportRow[];
  recognizedHeaders: string[];
  ignoredHeaders: string[];
}

function parseEmployeesCsv(text: string): ParseOutcome {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], recognizedHeaders: [], ignoredHeaders: [] };

  const headerRow = table[0]!.map((h) => h.trim());
  const fieldByColumn = headerRow.map((h) => HEADER_MAP[h.toLowerCase()]);
  const recognizedHeaders = headerRow.filter((_, i) => fieldByColumn[i]);
  const ignoredHeaders = headerRow.filter((_, i) => !fieldByColumn[i]);

  const rows: ImportRow[] = table.slice(1).map((cells, i) => {
    const row: ImportRow = { _rowNumber: i + 2 }; // +2: เริ่มนับที่ 1 บวกด้วยแถว header เอง
    cells.forEach((raw, colIndex) => {
      const field = fieldByColumn[colIndex];
      const value = raw.trim();
      if (!field || !value) return;
      if (field === "status") {
        const status = STATUS_BY_LOOKUP[value.toLowerCase()];
        if (status) row.status = status;
      } else {
        (row as unknown as Record<string, string>)[field] = value;
      }
    });
    return row;
  });

  return { rows: rows.filter((r) => Object.keys(r).length > 1 && r.name), recognizedHeaders, ignoredHeaders };
}

function downloadTemplate(): void {
  const csv = toCsv([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE_ROW]);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "optifleet-employee-import-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

interface ImportEmployeesModalProps {
  onClose: () => void;
  onImported: () => void;
}

/**
 * โหลด → ดูตัวอย่าง → ยืนยัน สำหรับนำเข้าข้อมูลพนักงานเป็นชุด parse ข้อมูล
 * ทั้งหมดทำฝั่ง client (ดู lib/csv.ts) เพื่อให้ผู้ใช้เห็นชัดเจนว่ากำลังจะ
 * ส่งอะไรไปก่อนที่จะแตะเซิร์ฟเวอร์จริง — POST /api/employees/import จะถูก
 * เรียกก็ต่อเมื่อกด "Confirm import" เท่านั้น โครงสร้างเหมือนกับ
 * ImportAssetsModal.tsx
 */
export function ImportEmployeesModal({ onClose, onImported }: ImportEmployeesModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseOutcome | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<{ results: ImportEmployeesResult[]; summary: { created: number; updated: number; failed: number } } | null>(
    null,
  );

  function handleFile(file: File): void {
    setFileName(file.name);
    setParseError(null);
    setResults(null);
    readCsvFile(file)
      .then((text) => {
        const outcome = parseEmployeesCsv(text);
        if (outcome.rows.length === 0) {
          setParseError("No usable rows found — check the file has a header row, a Name column, and at least one data row.");
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
      const res = await importEmployees(rows);
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
          <h2 className="text-base font-semibold text-ink-primary">Import employees</h2>
          <button type="button" onClick={downloadTemplate} className="text-xs font-medium text-accent hover:underline">
            Download CSV template
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          Upload a CSV, review what will be imported, then confirm. Rows with an existing Employee Code update that
          employee; rows with no code (or one that doesn't exist yet) create a new one. An unrecognized Department
          name is created automatically.
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
                      {["Row", "Name", "Code", "Department", "Job Title", "Email", "Status"].map((h) => (
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
                        <td className="px-3 py-1.5 text-ink-primary">{r.name}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.employeeCode || <span className="text-ink-muted">(new)</span>}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.department || "—"}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.jobTitle || "—"}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.email || "—"}</td>
                        <td className="px-3 py-1.5 text-ink-secondary">{r.status ? STATUS_LABEL[r.status] : "Active"}</td>
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
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide text-ink-muted">Name</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide text-ink-muted">Error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gridline">
                      {results.results
                        .filter((r) => r.action === "failed")
                        .map((r) => (
                          <tr key={r.index}>
                            <td className="px-3 py-1.5 text-ink-muted">{r.index + 2}</td>
                            <td className="px-3 py-1.5 text-ink-primary">{r.name || "(unnamed)"}</td>
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
