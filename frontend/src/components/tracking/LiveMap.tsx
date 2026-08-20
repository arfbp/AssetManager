"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DeviceLocationEntry } from "@/lib/types";

interface LiveMapProps {
  devices: DeviceLocationEntry[];
}

interface LocatedGroup {
  lat: number;
  lon: number;
  city: string | null;
  region: string | null;
  country: string | null;
  devices: DeviceLocationEntry[];
}

// อุปกรณ์ที่ resolve พิกัด (lat, lon) ออกมาตรงกันจะได้หมุดเดียว ไม่ใช่หมุด
// ซ้อนทับกันหลายอัน — เป็นกรณีปกติของฟลีตที่ deploy บน LAN ที่ทุกเครื่อง
// อยู่หลัง router สำนักงานเดียวกัน จึง resolve ออกมาเป็น public IP และ
// พิกัดเดียวกันเป๊ะ
function groupByCoordinate(devices: DeviceLocationEntry[]): LocatedGroup[] {
  const groups = new Map<string, LocatedGroup>();
  for (const d of devices) {
    if (d.lat === null || d.lon === null) continue;
    const key = `${d.lat},${d.lon}`;
    const existing = groups.get(key);
    if (existing) {
      existing.devices.push(d);
    } else {
      groups.set(key, { lat: d.lat, lon: d.lon, city: d.city, region: d.region, country: d.country, devices: [d] });
    }
  }
  return [...groups.values()];
}

function markerIcon(anyOnline: boolean): L.DivIcon {
  const color = anyOnline ? "#0ca30c" : "#898781";
  return L.divIcon({
    className: "",
    html: `<span style="display:block;width:16px;height:16px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8],
  });
}

export function LiveMap({ devices }: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18,
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const groups = groupByCoordinate(devices);
    const markers = groups.map((g) => {
      const anyOnline = g.devices.some((d) => d.status === "online");
      const marker = L.marker([g.lat, g.lon], { icon: markerIcon(anyOnline) }).addTo(map);
      const place = [g.city, g.region, g.country].filter(Boolean).join(", ") || "Unknown location";
      const list = g.devices
        .map((d) => `<div style="display:flex;justify-content:space-between;gap:8px;"><span>${d.agentId}</span><span style="color:${d.status === "online" ? "#0ca30c" : "#898781"}">${d.status}</span></div>`)
        .join("");
      marker.bindPopup(
        `<div style="font-family:Inter,sans-serif;font-size:13px;min-width:160px;"><strong>${place}</strong><div style="margin-top:6px;">${list}</div></div>`,
      );
      return marker;
    });

    if (groups.length > 0) {
      const bounds = L.latLngBounds(groups.map((g) => [g.lat, g.lon] as [number, number]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
    }

    return () => {
      markers.forEach((m) => m.remove());
    };
  }, [devices]);

  return <div ref={containerRef} className="h-full w-full" />;
}
