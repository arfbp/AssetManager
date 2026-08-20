// เก็บ session ฝั่ง client + เรียก auth API มาแทนที่ NEXT_PUBLIC_DASHBOARD_TOKEN
// แบบเดิม — token ที่นี่มาจากการ login จริง (POST /api/auth/login) เป็น
// session รายผู้ใช้ที่ revoke ได้และเก็บใน Postgres (server/src/auth/sessions.ts)
// ไม่ใช่ secret ที่ฝังตายตัวอยู่ใน JS bundle ตอน build
//
// เป็น plain module ธรรมดา (ไม่ใช่ React hook) เพื่อให้โค้ดที่ไม่ใช่ component —
// request() ของ api.ts, useDashboardSocket.ts — อ่าน token ปัจจุบันได้โดยไม่
// ต้องส่งผ่าน props ส่วน src/components/auth/AuthGate.tsx คือที่เดียวที่แปลงค่านี้
// เป็น reactive UI state
import type { Role } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const TOKEN_KEY = "optifleet-session-token";
const USERNAME_KEY = "optifleet-session-username";
const ROLE_KEY = "optifleet-session-role";
const PLATFORM_ADMIN_KEY = "optifleet-session-platform-admin";
const ORG_ID_KEY = "optifleet-session-org-id";
const UNAUTHORIZED_EVENT = "optifleet:unauthorized";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_KEY) ?? "";
}

export function getStoredUsername(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(USERNAME_KEY);
}

// เป็นแค่ความสะดวกด้าน UX (ซ่อนเมนู, ปิดปุ่มที่ viewer ใช้ไม่ได้) — ไม่ใช่ขอบเขต
// ความปลอดภัยจริง ทุก route ที่ค่านี้จะ gate ถูกบังคับซ้ำฝั่ง server ผ่าน
// requireRole อยู่แล้ว ดังนั้นค่าที่ค้างหรือถูกแก้ไขตรงนี้ทำได้แค่ให้ UI แสดงผิด
// แต่ไม่สามารถให้สิทธิ์เข้าถึงจริงได้
export function getStoredRole(): Role | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ROLE_KEY);
  return value === "admin" || value === "it_support" || value === "viewer" ? value : null;
}

// เป็นแค่ความสะดวกด้าน UX เช่นเดียวกับ getStoredRole ด้านบน — ใช้ gate แค่ว่าจะ
// render เมนู "Organizations" หรือไม่; POST/GET /orgs ถูกบังคับซ้ำฝั่ง server
// โดย requirePlatformAdmin อยู่แล้ว
export function getStoredIsPlatformAdmin(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PLATFORM_ADMIN_KEY) === "true";
}

// org ขององค์กรของผู้ใช้คนนี้เอง — ใช้ฝั่ง client สำหรับ action self-service ที่
// scope แค่ "องค์กรของฉัน" (เช่น การอัปโหลดโลโก้ใน org-settings ที่ยิงไป
// POST /orgs/:id/logo โดยใช้ค่านี้เป็น :id) มีข้อจำกัดแบบเดียวกับ getStoredRole
// ด้านบน คือการตรวจสอบสิทธิ์จริงอยู่ฝั่ง server (requireSelfOrPlatformAdmin)
export function getStoredOrgId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ORG_ID_KEY);
}

function setSession(token: string, username: string, role: Role, isPlatformAdmin: boolean, orgId: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USERNAME_KEY, username);
  window.localStorage.setItem(ROLE_KEY, role);
  window.localStorage.setItem(PLATFORM_ADMIN_KEY, String(isPlatformAdmin));
  window.localStorage.setItem(ORG_ID_KEY, orgId);
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USERNAME_KEY);
  window.localStorage.removeItem(ROLE_KEY);
  window.localStorage.removeItem(PLATFORM_ADMIN_KEY);
  window.localStorage.removeItem(ORG_ID_KEY);
}

// api.ts เรียกฟังก์ชันนี้เมื่อเจอ 401 ทุกครั้ง เพื่อให้ทุกส่วนของแอปรู้ว่า session
// ตายแล้ว (หมดอายุ, ถูก revoke, server รีสตาร์ทด้วย DB ใหม่) โดยไม่ต้องมี
// reference กลับไปยังจุดที่ยิง request นั้น
export function notifyUnauthorized(): void {
  clearSession();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
}

export function onUnauthorized(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
}

// หา org ที่ login นี้เป็นเจ้าของ โดยอ่านจาก address bar ของ browser เอง — ไม่ใช่
// env var ที่ตั้งตอน build เพราะ frontend build เดียวถูกเสิร์ฟให้ทุก subdomain
// ขององค์กร (ตัวแปร NEXT_PUBLIC_* ถูกฝังตอน build จึงไม่สามารถต่างกันไปตามแต่ละ
// org ได้ ดู migration plan แบบ multi-tenant) ค่านี้มีผลแค่ตอน login เท่านั้น:
// ทุก request หลังจากนั้นจะพก org identity ไปกับ session token เอง
// (server/src/auth/sessions.ts join ค่านี้แบบเดียวกับที่ join role อยู่แล้ว)
// จึงไม่มีที่อื่นที่ต้องใช้ค่านี้อีก
//
// ตั้งใจไม่ใช้วิธี heuristic แบบ "นับจำนวน label ที่คั่นด้วยจุด" — เพราะทดสอบจริง
// แล้วพบว่าวิธีนี้พังกับ hostname ปัจจุบันของโปรเจกต์เอง คือ
// 27-254-142-51.sslip.io ซึ่งมี 3 label และถูกอ่านผิดเป็น org subdomain
// "27-254-142-51" (เคยทำให้ login ล็อกจริงระหว่าง rollout Phase 2) การเทียบกับ
// org-domain suffix จริง ๆ เท่านั้นที่ถูกต้อง; NEXT_PUBLIC_ORG_DOMAIN_SUFFIX
// จะยังไม่ถูกตั้งค่าจนกว่า domain จริงของ Phase 6 (เช่น ".optifleet.ai") จะ
// เปิดใช้งาน ดังนั้นตอนนี้จึง fallback เป็น "legacy" เสมอ ตรงกับความเป็น
// single-tenant ในปัจจุบัน
//
// ยังมีกรณีที่สาม: org สามารถใช้ domain ของตัวเองทั้งเส้นแทน subdomain ภายใต้
// suffix ที่ใช้ร่วมกันได้ (เช่น assets.360qm.co.th แทนที่จะเป็น
// 360qm.27-254-142-51.sslip.io — ดู migrations/0007_org_custom_domain.sql
// และ orgResolver.ts) hostname แบบนี้จะไม่ตรงทั้ง suffix และ base domain
// เปล่า จึงหลุดผ่านเงื่อนไขและถูกส่งไปตามที่เป็น; ฝั่ง server จะเทียบกับ
// organizations.custom_domain แทนที่จะเทียบกับ .subdomain
export function currentOrgSubdomain(): string {
  if (typeof window === "undefined") return "legacy";
  const host = window.location.hostname;
  const suffix = process.env.NEXT_PUBLIC_ORG_DOMAIN_SUFFIX;
  if (suffix) {
    if (host.endsWith(suffix)) {
      const subdomain = host.slice(0, -suffix.length);
      if (subdomain) return subdomain;
    }
    // base hostname เอง (suffix ที่ตัดจุดนำหน้าออก) คือ domain ของ fleet เก่าก่อน
    // ยุค multi-tenant ไม่ใช่ subdomain ของมัน
    if (host === suffix.slice(1)) return "legacy";
  }
  if (host === "localhost" || host === "127.0.0.1") {
    // NEXT_PUBLIC_DEV_ORG_SUBDOMAIN ให้ dev ที่ทดสอบ org ที่สองบนเครื่อง
    // local สามารถ override ค่านี้ได้โดยไม่ต้องแก้โค้ดหรือมี suffix จริง
    return process.env.NEXT_PUBLIC_DEV_ORG_SUBDOMAIN ?? "legacy";
  }
  return host;
}

export async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-org-subdomain": currentOrgSubdomain() },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `login failed with status ${res.status}`);
  }
  const data = (await res.json()) as { token: string; username: string; role: Role; isPlatformAdmin: boolean; orgId: string };
  setSession(data.token, data.username, data.role, data.isPlatformAdmin, data.orgId);
  return data.username;
}

export async function logout(): Promise<void> {
  const token = getToken();
  clearSession();
  if (!token) return;
  // ทำแบบ best-effort — ถ้า call นี้ล้มเหลว session row ที่เหลือค้างไว้ก็ไม่เป็น
  // อันตราย และฝั่ง client ก็ลืม token ไปแล้วไม่ว่าจะสำเร็จหรือไม่
  await fetch(`${API_URL}/api/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export type SessionCheckResult =
  | { status: "valid"; username: string }
  | { status: "invalid" }
  | { status: "unknown" }; // ต่อ server ไม่ได้ — คนละกรณีกับ "logout ไปแล้ว"

// ตรวจสอบว่า token ที่เก็บไว้ยังเป็น session ที่ใช้งานได้อยู่หรือไม่ — เรียกครั้งเดียว
// ตอน startup เพื่อไม่ให้ token เก่า/หมดอายุจากการเข้าใช้ครั้งก่อนถูกถือว่ายังใช้ได้
// จนกว่าจะบังเอิญมี API call จริงตัวแรกที่ล้มเหลว
export async function checkSession(): Promise<SessionCheckResult> {
  const token = getToken();
  if (!token) return { status: "invalid" };
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      clearSession();
      return { status: "invalid" };
    }
    const data = (await res.json()) as { username: string; role: Role; isPlatformAdmin: boolean; orgId: string };
    // /auth/me ยังเป็นช่องทางที่การเปลี่ยน role (admin แก้ role ของคนอื่น) จะ
    // ไปถึง tab ที่เปิดค้างไว้อยู่แล้วด้วย — refresh ตรงนี้เพื่อไม่ให้ role ที่เก็บไว้
    // ใน UI ค้างเป็นค่าเก่าจนกว่าจะ login ใหม่
    window.localStorage.setItem(ROLE_KEY, data.role);
    window.localStorage.setItem(PLATFORM_ADMIN_KEY, String(data.isPlatformAdmin));
    window.localStorage.setItem(ORG_ID_KEY, data.orgId);
    return { status: "valid", username: data.username };
  } catch {
    // เป็น network error ไม่ใช่การตัดสินใจเรื่อง auth — ฝั่งที่เรียกควรถือ session
    // ที่เก็บไว้ว่ายังใช้ได้ไปก่อนแบบ optimistic แทนที่จะ logout ทันที
    return { status: "unknown" };
  }
}
