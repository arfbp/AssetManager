// โลโก้กำหนดเองของแต่ละองค์กร — ต้อง resolve ก่อนที่ session จะมีอยู่ด้วยซ้ำ
// (หน้า login ต้องใช้) จึงตั้งใจไม่ผ่าน request() helper ของ api.ts ซึ่งจะแปะ
// bearer token ให้เสมอ แต่ call แบบ pre-auth นี้ยังไม่มี token ใช้วิธี resolve
// org-identity แบบเดียวกับที่ login() เองใช้ (ดู currentOrgSubdomain ใน
// session.ts) และส่งด้วยวิธีเดียวกัน (header X-Org-Subdomain ที่ฝั่ง
// GET /orgs/branding อ่านที่ฝั่ง server)
import { currentOrgSubdomain, getToken, notifyUnauthorized } from "./session";
import { ApiError } from "./api";
import type { ApiErrorBody } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export interface OrgBranding {
  name: string;
  logoUrl: string | null;
}

// ทำแบบ best-effort: ล้มเหลวไม่ว่ากรณีใด (หา org ไม่เจอ, network error) ก็แค่
// หมายความว่า "ใช้โลโก้ OptiFleet ค่าเริ่มต้นแทน" ไม่ใช่ error ที่ต้องบล็อกผู้ใช้ —
// branding เป็นแค่ความสวยงาม ไม่ควรทำให้หน้า login หรือ dashboard พังไปด้วย
export async function getOrgBranding(): Promise<OrgBranding | null> {
  try {
    const res = await fetch(`${API_URL}/api/orgs/branding`, {
      headers: { "x-org-subdomain": currentOrgSubdomain() },
    });
    if (!res.ok) return null;
    return (await res.json()) as OrgBranding;
  } catch {
    return null;
  }
}

// ไม่ได้สร้างบน request() ของ api.ts — เหตุผลเดียวกับ uploadInstaller คือ
// body ตรงนี้เป็นไฟล์ binary ไม่ใช่ JSON
export async function uploadOrgLogo(orgId: string, file: File): Promise<OrgBranding> {
  const res = await fetch(`${API_URL}/api/orgs/${orgId}/logo`, {
    method: "POST",
    headers: { authorization: `Bearer ${getToken()}`, "content-type": file.type },
    body: file,
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `logo upload failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // response body ไม่ใช่ JSON — ใช้ข้อความ generic ด้านบนแทน
    }
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export async function removeOrgLogo(orgId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/orgs/${orgId}/logo`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    let message = `logo removal failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error || message;
    } catch {
      // response body ไม่ใช่ JSON — ใช้ข้อความ generic ด้านบนแทน
    }
    throw new ApiError(res.status, message);
  }
}

// GET /orgs/:id/logo เป็น public แต่เป็น relative path — ต้องเติม origin ของ
// API นำหน้าเหมือน absolute asset URL อื่น ๆ ในแอปนี้ เพราะ frontend กับ
// backend ถูกเสิร์ฟคนละ origin/port กัน
export function resolveLogoUrl(logoUrl: string): string {
  return `${API_URL}${logoUrl}`;
}
