"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EndpointGrid } from "@/components/endpoints/EndpointGrid";
import { EndpointTable } from "@/components/endpoints/EndpointTable";
import { FleetStats } from "@/components/endpoints/FleetStats";
import { ProcessManagerDrawer } from "@/components/process/ProcessManagerDrawer";
import { AssetFormModal } from "@/components/assets/AssetFormModal";
import { StatusBadge } from "@/components/status/StatusBadge";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/layout/AppShell";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";
import { getAssets, getFleetLocations } from "@/lib/api";
import type { AssetInput, DeviceInfo } from "@/lib/types";

type StatusFilter = "all" | "online" | "offline" | "alert";

function Devices({ username }: { username: string }) {
  const { agents, history, connectionStatus, commandOutputs } = useDashboardSocket();
  const searchParams = useSearchParams();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [assetPrefill, setAssetPrefill] = useState<AssetInput | null>(null);
  // เก็บข้อมูล asset แค่พอให้ list "Connected devices" รู้ว่าต้องซ่อนปุ่ม
  // "+ Add as asset" สำหรับ device ที่ลงทะเบียนเป็น asset ไปแล้ว —
  // ตาราง asset เต็มรูปแบบอยู่ที่หน้า /assets ไม่ใช่ที่นี่
  const [registeredSerials, setRegisteredSerials] = useState<Set<string>>(new Set());

  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  // agentId -> country จาก IP geolocation (แหล่งข้อมูลเดียวกับ Live Tracking) —
  // ดึงมาแค่ครั้งเดียวตรงนี้แทนที่จะทำ geolocation lookup ซ้ำ เพราะ
  // AgentSummary เองไม่มีข้อมูล location ติดมาด้วย
  const [countryByAgent, setCountryByAgent] = useState<Record<string, string>>({});

  useEffect(() => {
    getFleetLocations()
      .then((res) => {
        const map: Record<string, string> = {};
        for (const d of res.devices) {
          if (d.country) map[d.agentId] = d.country;
        }
        setCountryByAgent(map);
      })
      .catch(() => {}); // best-effort — ถ้าดึงไม่ได้ ตัว filter ก็แค่ขึ้น "Unknown" ให้ทุกเครื่อง
  }, []);

  function reloadRegisteredSerials(): void {
    getAssets()
      .then((res) => setRegisteredSerials(new Set(res.assets.map((a) => a.serialNumber).filter((s): s is string => Boolean(s)))))
      .catch(() => {}); // best-effort — แย่สุดคือปุ่มยังไม่ถูกซ่อนตามที่ควร
  }

  useEffect(() => {
    reloadRegisteredSerials();
  }, []);

  // รองรับ deep link จาก list "needs attention" ของ Dashboard (?agent=<id>) —
  // เปิด drawer ให้เลยโดยไม่ต้องให้ operator มาหาแล้วคลิก device เอง
  // ส่วน ?console=1 (ไม่มี agent) เก็บไว้เป็น legacy fallback — ทางหลักสำหรับ
  // สั่งคำสั่งระดับ fleet ตอนนี้คือหน้า /console แบบ standalone แล้ว (ดูเมนู
  // "AI Console" ใน sidebar)
  useEffect(() => {
    const agentParam = searchParams.get("agent");
    if (agentParam) {
      setSelectedAgentId(agentParam);
      setDrawerOpen(true);
    } else if (searchParams.get("console")) {
      setSelectedAgentId(null);
      setDrawerOpen(true);
    }
    // ตั้งใจให้รันแค่ครั้งเดียวตอนเข้าหน้า — หลังจากนั้น state เปิด/ปิดของ
    // drawer เองจะเป็นคนควบคุมต่อ ไม่ควร reset แม้ query param พวกนี้จะยังค้าง
    // อยู่ใน URL หลัง operator ปิด drawer ไปแล้ว
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // เชื่อมกับช่องค้นหา global search ที่ header (AppShell) — กด Enter ที่นั่น
  // จะ navigate มาที่นี่พร้อม ?q= แล้ว filter ด้วยการ match substring จริงกับ
  // agentId ไม่ใช่แค่ช่องค้นหาไว้ประดับ
  const query = (searchParams.get("q") ?? "").trim().toLowerCase();

  // ดึงมาจากสิ่งที่ fleet รายงานจริง ไม่ใช่ list ที่ hardcode ไว้ — ทั้ง OS
  // platform string ของ device (ชื่อ distro ของ Windows/Linux/darwin) และ
  // country ที่ได้จาก geolocation ต่างก็แปรผันตามการ deploy แต่ละที่ ดังนั้น
  // dropdown จะมีแค่ตัวเลือกที่มีอยู่จริง ณ ตอนนั้นเท่านั้น
  const countryOptions = useMemo(
    () => Array.from(new Set(Object.values(countryByAgent))).sort(),
    [countryByAgent],
  );
  const typeOptions = useMemo(
    () =>
      Array.from(new Set(agents.map((a) => a.lastTelemetry?.os).filter((os): os is string => Boolean(os)))).sort(),
    [agents],
  );

  const visibleAgents = agents.filter((a) => {
    if (query && !a.agentId.toLowerCase().includes(query)) return false;
    if (statusFilter === "online" && a.status !== "online") return false;
    if (statusFilter === "offline" && a.status !== "offline") return false;
    if (statusFilter === "alert" && a.lastTelemetry?.mode !== "alert") return false;
    if (countryFilter !== "all" && countryByAgent[a.agentId] !== countryFilter) return false;
    if (typeFilter !== "all" && a.lastTelemetry?.os !== typeFilter) return false;
    return true;
  });

  const selectedAgent = agents.find((a) => a.agentId === selectedAgentId) ?? null;

  function openDeviceDrawer(agentId: string): void {
    setSelectedAgentId(agentId);
    setDrawerOpen(true);
  }

  function openConsoleOnly(): void {
    setSelectedAgentId(null);
    setDrawerOpen(true);
  }

  function handleRegisterDevice(device: DeviceInfo, agentId: string): void {
    setAssetPrefill({
      assetType: "peripheral",
      manufacturer: device.manufacturer || null,
      model: device.model || device.name,
      manualSerialNumber: device.serial_number || null,
      parentAgentId: agentId,
      status: "deployed",
    });
  }

  return (
    <AppShell
      username={username}
      connectionStatus={connectionStatus}
      statusSlot={
        <StatusBadge
          tone={connectionStatus === "open" ? "good" : "critical"}
          label={connectionStatus === "open" ? "Live" : connectionStatus === "connecting" ? "Connecting…" : "Disconnected"}
        />
      }
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Devices</h1>
            <p className="text-xs text-ink-muted">
              {query ? `Filtered by "${query}" — ` : ""}Click a device for its AI console, live processes, trend, and command history.
            </p>
          </div>
          <button
            type="button"
            onClick={openConsoleOnly}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            AI Console
          </button>
        </div>

        <FleetStats agents={agents} />

        <div className="glass-card flex flex-wrap items-center gap-2 rounded-xl p-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
          >
            <option value="all">All Status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="alert">In alert</option>
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
          >
            <option value="all">All Types</option>
            {typeOptions.map((os) => (
              <option key={os} value={os}>
                {os}
              </option>
            ))}
          </select>

          <select
            value={countryFilter}
            onChange={(e) => setCountryFilter(e.target.value)}
            className="rounded-lg border border-border bg-page px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
          >
            <option value="all">All Countries</option>
            {countryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <div className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-page p-1">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              aria-label="List view"
              className={`flex h-7 w-7 items-center justify-center rounded-md ${viewMode === "list" ? "bg-accent text-white" : "text-ink-muted hover:text-ink-primary"}`}
            >
              <span className="material-symbols-outlined text-[18px]">view_list</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              aria-label="Grid view"
              className={`flex h-7 w-7 items-center justify-center rounded-md ${viewMode === "grid" ? "bg-accent text-white" : "text-ink-muted hover:text-ink-primary"}`}
            >
              <span className="material-symbols-outlined text-[18px]">grid_view</span>
            </button>
          </div>
        </div>

        <main>
          {viewMode === "list" ? (
            <EndpointTable agents={visibleAgents} onSelect={openDeviceDrawer} />
          ) : (
            <EndpointGrid agents={agents} displayAgents={visibleAgents} onSelect={openDeviceDrawer} />
          )}
        </main>
      </div>

      <ProcessManagerDrawer
        open={drawerOpen}
        agent={selectedAgent}
        agents={agents}
        history={history}
        onClose={() => setDrawerOpen(false)}
        onRegisterDevice={(device, agent) => handleRegisterDevice(device, agent.agentId)}
        registeredSerials={registeredSerials}
        commandOutputs={commandOutputs}
      />

      {assetPrefill && (
        <AssetFormModal
          editing={null}
          prefill={assetPrefill}
          unregisteredAgents={[]}
          onClose={() => setAssetPrefill(null)}
          onSaved={() => {
            setAssetPrefill(null);
            reloadRegisteredSerials();
          }}
        />
      )}
    </AppShell>
  );
}

export default function DevicesPage() {
  return (
    <AuthGate>
      {(username) => (
        <Suspense fallback={null}>
          <Devices username={username} />
        </Suspense>
      )}
    </AuthGate>
  );
}
