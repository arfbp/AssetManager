"use client";

import { useEffect, useRef, useState } from "react";

interface SignaturePadProps {
  onChange: (dataUrl: string | null) => void;
}

// ใช้ <canvas> ธรรมดา + pointer event วาดเส้นเอง ไม่พึ่ง library ภายนอก
// เพราะลายเซ็นทำเองได้ไม่ยาก (ต่างจากการสร้าง QR ที่ต้องพึ่ง encoder จริงๆ)
// ส่งค่าออกเป็น PNG data URL ผ่าน toDataURL() ทุกครั้งที่ปล่อยเมาส์/นิ้ว
// และเป็น null ตอนยังไม่มีการวาด เพื่อให้ฝั่งที่เรียกใช้แยกออกว่า
// "ยังไม่ได้เซ็น" กับ "เซ็นแล้ว" ต่างกันอย่างไร
export function SignaturePad({ onChange }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasStroke, setHasStroke] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    drawing.current = true;
    const { x, y } = pointerPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    canvas.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pointerPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasStroke) setHasStroke(true);
  }

  function handlePointerUp(): void {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(canvasRef.current?.toDataURL("image/png") ?? null);
  }

  function handleClear(): void {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasStroke(false);
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={480}
        height={160}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className="w-full touch-none rounded-md border border-border bg-white"
      />
      <div className="mt-1 flex items-center justify-between">
        <p className="text-[11px] text-ink-muted">Sign above with your mouse, finger, or stylus.</p>
        {hasStroke && (
          <button type="button" onClick={handleClear} className="text-[11px] font-medium text-accent hover:underline">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
