// มูลค่าตามบัญชีแบบ straight-line — คำนวณทุกครั้งที่อ่าน ไม่มีการเก็บค่าไว้
// จึงไม่มีทางค้างค่าเก่า (แนวทาง "คำนวณสด" เดียวกับที่ assetsStore.ts ใช้กับ
// field ที่มาจาก telemetry ใน AssetLiveInfo อยู่แล้ว เพียงแต่ตรงนี้คำนวณด้วย
// JS แทนที่จะ join มาจาก Postgres)
export function computeBookValue(
  purchaseCost: number | null,
  purchaseDate: string | null,
  depreciationYears: number | null,
  salvageValue: number | null,
  asOf: Date = new Date(),
): number | null {
  if (purchaseCost === null || !purchaseDate || !depreciationYears || depreciationYears <= 0) return null;

  const salvage = salvageValue ?? 0;
  const purchased = new Date(purchaseDate);
  const monthsElapsed = Math.max(
    0,
    (asOf.getFullYear() - purchased.getFullYear()) * 12 + (asOf.getMonth() - purchased.getMonth()),
  );
  const totalMonths = depreciationYears * 12;
  const depreciableAmount = Math.max(0, purchaseCost - salvage);
  const depreciated = (Math.min(monthsElapsed, totalMonths) / totalMonths) * depreciableAmount;

  return Math.round(Math.max(purchaseCost - depreciated, salvage) * 100) / 100;
}

// ค่าเสื่อมราคาแบบ straight-line ของหนึ่งงวด (หนึ่งเดือน) สำหรับ workflow
// depreciation-run ฝั่ง GL (accounting/depreciationRunsStore.ts) — แยกออกจาก
// computeBookValue ด้านบนซึ่งเป็นสูตร "ตอนนี้มูลค่าเท่าไหร่" แบบสดที่ไม่ผูกกับ
// งวดที่ post จริง จำกัดเพดานไว้ที่ส่วนที่เหลือให้เสื่อมได้ (depreciableAmount
// ลบด้วยสิ่งที่ post ไปแล้วใน run ก่อนหน้า — ดู assets/accumulatedDepreciation.ts)
// เพื่อให้ run ที่ใกล้จบอายุการใช้งานของ asset post เป็นยอดบางส่วนสุดท้าย
// แทนที่จะเกินมูลค่าซาก (salvage value) ไป
export function monthlyDepreciationAmount(
  purchaseCost: number | null,
  depreciationYears: number | null,
  salvageValue: number | null,
  alreadyDepreciated: number,
): number {
  if (purchaseCost === null || !depreciationYears || depreciationYears <= 0) return 0;
  const salvage = salvageValue ?? 0;
  const depreciableAmount = Math.max(0, purchaseCost - salvage);
  const monthlyAmount = depreciableAmount / (depreciationYears * 12);
  const remaining = Math.max(0, depreciableAmount - alreadyDepreciated);
  return Math.round(Math.min(monthlyAmount, remaining) * 100) / 100;
}
