"use client";

import { useEffect, useState } from "react";
import { checkSession, getStoredUsername, onUnauthorized } from "@/lib/session";
import { LoginForm } from "./LoginForm";

type GateState =
  | { phase: "checking" }
  | { phase: "authenticated"; username: string }
  | { phase: "unauthenticated" };

/**
 * คุมสิทธิ์เข้าดู dashboard ทั้งหมดด้วยการล็อกอินจริง (server/src/auth/)
 * แทนการใช้ token กลางที่ใช้ร่วมกันแบบเดิม เช็คครั้งเดียวตอน mount ผ่าน
 * GET /api/auth/me (checkSession ใน session.ts) เพื่อให้ token ที่หมดอายุ
 * จากการเข้าใช้งานครั้งก่อนแสดงหน้าล็อกอินทันที ไม่ต้องรอให้ API call
 * แรกล้มเหลวก่อน ถ้าเช็คแล้วเจอ network error จะถือว่า "น่าจะยังล็อกอิน
 * อยู่" (ใช้ username ล่าสุดที่จำไว้) แทนที่จะเด้งไปหน้าล็อกอินทันทีเพราะ
 * เน็ตสะดุดชั่วคราว — ส่วน 401 จริงจาก request ใดๆ ทีหลังยังคง trigger
 * event unauthorized ด้านล่างตามปกติ
 */
export function AuthGate({ children }: { children: (username: string) => React.ReactNode }) {
  const [state, setState] = useState<GateState>({ phase: "checking" });

  useEffect(() => {
    let cancelled = false;

    checkSession().then((result) => {
      if (cancelled) return;
      if (result.status === "valid") {
        setState({ phase: "authenticated", username: result.username });
      } else if (result.status === "unknown") {
        const stored = getStoredUsername();
        setState(stored ? { phase: "authenticated", username: stored } : { phase: "unauthenticated" });
      } else {
        setState({ phase: "unauthenticated" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onUnauthorized(() => setState({ phase: "unauthenticated" }));
  }, []);

  if (state.phase === "checking") {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">Loading…</div>;
  }

  if (state.phase === "unauthenticated") {
    return <LoginForm onSuccess={(username) => setState({ phase: "authenticated", username })} />;
  }

  return <>{children(state.username)}</>;
}
