// Client-side session storage + auth API calls. Replaces the old static
// NEXT_PUBLIC_DASHBOARD_TOKEN — the token here comes from a real login
// (POST /api/auth/login) and is a per-user, revocable, Postgres-backed
// session (server/src/auth/sessions.ts), not a shared secret baked into the
// JS bundle at build time.
//
// This is a plain module (not a React hook) so non-component code — api.ts's
// request(), useDashboardSocket.ts — can read the current token without
// needing to be passed it through props. src/components/auth/AuthGate.tsx is
// the one place that turns this into reactive UI state.
import type { Role } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const TOKEN_KEY = "optifleet-session-token";
const USERNAME_KEY = "optifleet-session-username";
const ROLE_KEY = "optifleet-session-role";
const PLATFORM_ADMIN_KEY = "optifleet-session-platform-admin";
const UNAUTHORIZED_EVENT = "optifleet:unauthorized";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_KEY) ?? "";
}

export function getStoredUsername(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(USERNAME_KEY);
}

// Purely a UX convenience (hiding nav items, disabling buttons a viewer
// can't use) — never the actual security boundary. Every route this would
// gate is independently enforced server-side via requireRole, so a stale or
// tampered value here can make the UI look wrong but can't grant real access.
export function getStoredRole(): Role | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ROLE_KEY);
  return value === "admin" || value === "it_support" || value === "viewer" ? value : null;
}

// Purely a UX convenience, same caveat as getStoredRole above — gates only
// whether the "Organizations" nav item renders; POST/GET /orgs are
// independently enforced server-side by requirePlatformAdmin.
export function getStoredIsPlatformAdmin(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PLATFORM_ADMIN_KEY) === "true";
}

function setSession(token: string, username: string, role: Role, isPlatformAdmin: boolean): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USERNAME_KEY, username);
  window.localStorage.setItem(ROLE_KEY, role);
  window.localStorage.setItem(PLATFORM_ADMIN_KEY, String(isPlatformAdmin));
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USERNAME_KEY);
  window.localStorage.removeItem(ROLE_KEY);
  window.localStorage.removeItem(PLATFORM_ADMIN_KEY);
}

// api.ts calls this on any 401 so every part of the app finds out a session
// died (expired, revoked, server restarted with a fresh DB) without needing
// a direct reference back to whatever triggered the request.
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

// Which org this login belongs to, derived from the browser's own address
// bar — not a build-time env var, since one shared frontend build serves
// every org's subdomain (NEXT_PUBLIC_* vars are baked in at build time, so
// they can't vary per org; see the multi-tenant migration plan). Only
// load-bearing at login: every request after that carries org identity via
// the session token itself (server/src/auth/sessions.ts joins it the same
// way it already joins role), so nowhere else needs this.
//
// Deliberately NOT a "count the dot-separated labels" heuristic — verified
// live that this breaks against the project's own current hostname,
// 27-254-142-51.sslip.io, which itself has 3 labels and was being
// misread as org subdomain "27-254-142-51" (a real login lockout caught
// during Phase 2 rollout). Matching against the actual org-domain suffix
// is the only correct check; NEXT_PUBLIC_ORG_DOMAIN_SUFFIX is unset until
// Phase 6's real domain (e.g. ".optifleet.ai") goes live, so this always
// falls back to "legacy" until then, matching today's single-tenant reality.
//
// A third case: an org can bring its own fully-owned domain instead of a
// subdomain under the shared suffix (e.g. assets.360qm.co.th instead of
// 360qm.27-254-142-51.sslip.io — see migrations/0007_org_custom_domain.sql
// and orgResolver.ts). Such a hostname matches neither the suffix nor the
// bare base domain, so it falls through and is sent as-is; the server
// matches it against organizations.custom_domain instead of .subdomain.
function currentOrgSubdomain(): string {
  if (typeof window === "undefined") return "legacy";
  const host = window.location.hostname;
  const suffix = process.env.NEXT_PUBLIC_ORG_DOMAIN_SUFFIX;
  if (suffix) {
    if (host.endsWith(suffix)) {
      const subdomain = host.slice(0, -suffix.length);
      if (subdomain) return subdomain;
    }
    // The base hostname itself (suffix with its leading dot stripped) is
    // the pre-multi-tenant legacy fleet's own domain, not a subdomain of it.
    if (host === suffix.slice(1)) return "legacy";
  }
  if (host === "localhost" || host === "127.0.0.1") {
    // NEXT_PUBLIC_DEV_ORG_SUBDOMAIN lets a developer testing a second org
    // locally override this without editing code or needing the real suffix.
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
  const data = (await res.json()) as { token: string; username: string; role: Role; isPlatformAdmin: boolean };
  setSession(data.token, data.username, data.role, data.isPlatformAdmin);
  return data.username;
}

export async function logout(): Promise<void> {
  const token = getToken();
  clearSession();
  if (!token) return;
  // Best-effort — the session row is harmless leftover if this fails, and
  // the client has already forgotten the token either way.
  await fetch(`${API_URL}/api/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export type SessionCheckResult =
  | { status: "valid"; username: string }
  | { status: "invalid" }
  | { status: "unknown" }; // couldn't reach the server — not the same as "logged out"

// Verifies a stored token is still a live session — used once at startup so
// a stale/expired token from a previous visit doesn't get treated as valid
// until the first real API call happens to fail.
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
    const data = (await res.json()) as { username: string; role: Role; isPlatformAdmin: boolean };
    // /auth/me is also how a role change (an admin edited someone else's
    // role) reaches an already-open tab — refreshed here so the UI's own
    // stored role doesn't go stale until next login.
    window.localStorage.setItem(ROLE_KEY, data.role);
    window.localStorage.setItem(PLATFORM_ADMIN_KEY, String(data.isPlatformAdmin));
    return { status: "valid", username: data.username };
  } catch {
    // Network error, not an auth decision — the caller should fall back to
    // optimistically trusting the stored session rather than logging out.
    return { status: "unknown" };
  }
}
