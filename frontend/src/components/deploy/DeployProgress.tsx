"use client";

import { useEffect, useRef, useState } from "react";
import type { StreamedCommandOutput } from "@/hooks/useDashboardSocket";

// แปลงบรรทัด STATUS:/PROGRESS: ที่ runScript ของ internal/executor สตรีม
// ออกมาจาก stdout/stderr ของคำสั่งแบบ real-time ให้กลายเป็น stage + percent
// ส่วนบรรทัดอื่นๆ ที่เหลือแสดงเป็น raw log ด้านล่างเฉยๆ สำหรับใครที่อยาก
// ดู transcript จริงของสคริปต์แทนสรุปย่อ ใช้ร่วมกันทุกหน้าที่ยิง
// run_script แล้วอยากได้ feedback แบบ live (Software Deploy, Uninstall
// Software) จะได้ไม่ต้องเขียน logic parse ซ้ำกันในแต่ละที่
export function parseProgress(output: StreamedCommandOutput | undefined): { stage: string | null; percent: number | null } {
  let stage: string | null = null;
  let percent: number | null = null;
  for (const line of output?.lines ?? []) {
    const statusMatch = /^STATUS:(\w+)$/.exec(line);
    if (statusMatch) stage = statusMatch[1]!;
    const progressMatch = /^PROGRESS:(\d+)$/.exec(line);
    if (progressMatch) percent = Number(progressMatch[1]);
  }
  return { stage, percent };
}

const STAGE_LABELS: Record<string, string> = {
  downloading: "Downloading…",
  installing: "Installing…",
  uninstalling: "Uninstalling…",
  done: "Done",
};

// ทั้ง "installing" และ "uninstalling" ไม่มีอะไรให้วัดความคืบหน้าจริง —
// ไม่มี silent installer ตัวไหน (ของ Ninite หรือของ vendor เอง) รายงาน
// percent ของตัวเองออกมา ต่างจากขั้นตอนดาวน์โหลดที่มี byte count ให้ใช้
// ถ้าปล่อยเป็น indeterminate pulse เฉยๆ ไม่มีตัวเลขเลย คนดูจะรู้สึกว่า
// "นี่มันทำงานอยู่จริงไหม" จึงจำลองค่า percent ที่ดูสมเหตุสมผลขึ้นมาแทน:
// วิ่งเร็วตอนแรก แล้วค่อยๆ ช้าลงเมื่อใกล้เพดาน 92% (ซึ่งมันจะไม่มีวันอ้าง
// ว่าถึง 100% เองได้ ต้องรอ event "done" จริงเท่านั้น) เป็นเส้นโค้งแบบ
// asymptotic เพื่อไม่ให้ดูเหมือนค้างแม้จะใช้เวลานานกว่าที่คาด ตัวแปร
// `active` ใช้คุมให้ timer/state รีเซ็ตสะอาดทุกครั้งที่เริ่มงานใหม่ ไม่ให้
// ค่าจากรอบก่อนหน้าค้างอยู่
export function useSimulatedProgress(active: boolean): number {
  const [percent, setPercent] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setPercent(0);
      startRef.current = null;
      return;
    }
    startRef.current = Date.now();
    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - startRef.current!) / 1000;
      setPercent(Math.min(92, Math.round(92 * (1 - Math.exp(-elapsedSeconds / 8)))));
    }, 250);
    return () => clearInterval(interval);
  }, [active]);

  return percent;
}

// จุดเดียวที่เป็น source of truth ของ "ตอนนี้ควรโชว์กี่เปอร์เซ็นต์" — ใช้
// byte count ของการดาวน์โหลดจริงในขั้นตอนนั้น หรือใช้ค่าจำลองในขั้นตอนอื่น
// และเป็น null เมื่อมีผลลัพธ์สุดท้ายแล้วหรือยังไม่ได้ยิงคำสั่งเลย ฝั่งที่
// อยากโชว์ตัวเลขเดียวกันนี้นอก DeployProgress เอง (เช่น label บนปุ่ม
// Deploy/Uninstall ที่ไม่อยากโชว์ตัวเลขต่างจาก progress bar ด้านล่าง)
// ให้เรียกใช้ตัวนี้แทนที่จะคำนวณเองซ้ำ
export function useDeployPercent(commandId: string | null, output: StreamedCommandOutput | undefined): number | null {
  const { stage, percent: realPercent } = parseProgress(output);
  const isDownloading = stage === "downloading";
  const waitingForResult = Boolean(commandId) && !output?.done;
  const simulatedPercent = useSimulatedProgress(waitingForResult && !isDownloading);

  if (!commandId || output?.done) return null;
  return isDownloading ? realPercent : simulatedPercent;
}

export function DeployProgress({ commandId, output }: { commandId: string | null; output: StreamedCommandOutput | undefined }) {
  const percent = useDeployPercent(commandId, output);
  const { stage } = parseProgress(output);

  if (!commandId) return null;

  if (output?.done) {
    return output.error ? (
      <p className="text-sm text-status-critical">✗ Failed: {output.error}</p>
    ) : (
      <p className="text-sm text-status-good">✓ Completed successfully.</p>
    );
  }

  const label = (stage && STAGE_LABELS[stage]) ?? "Waiting for the device to pick this up…";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs text-ink-secondary">
        <span>{label}</span>
        {percent !== null && <span className="font-mono tabular-nums">{percent}%</span>}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gridline">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent ?? 0}%` }} />
      </div>
      {output && output.lines.length > 0 && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer select-none">Raw output</summary>
          <pre className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-page p-2">
            {output.lines.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
