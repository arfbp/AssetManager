// การระบุตำแหน่งจาก IP สำหรับหน้า "Live Tracking" — ตั้งใจไม่ใช่ GPS จริง
// โปรเจกต์นี้ไม่มีฮาร์ดแวร์ยานพาหนะ/GPS อยู่ที่ไหนเลย สิ่งที่มีคือ public IP
// จริงของแต่ละ agent (agent รายงานเองผ่านการ lookup ภายนอก —
// internal/telemetry/publicip.go — เพราะมีแค่ตำแหน่งเครือข่ายของ agent เอง
// เท่านั้นที่รู้ address ที่หันหน้าเข้าอินเทอร์เน็ตของตัวเองได้ ถ้าให้ server
// ที่อยู่ LAN เดียวกันเช็คจะเห็นแค่ IP วงในเท่านั้น) ซึ่งไฟล์นี้จะ resolve เป็น
// ตำแหน่งโดยประมาณ พร้อมรายละเอียด ISP/ASN/รหัสไปรษณีย์/timezone ผ่าน API
// ภายนอกแบบฟรี — รายละเอียดระดับเดียวกับเว็บ "what's my IP" ทั่วไป มีข้อจำกัด
// จริง ๆ ที่ควรรู้ไว้สองอย่าง: (1) IP ส่วนตัว/LAN ไม่มีทางระบุตำแหน่งได้เลย —
// ไม่มีอะไรให้ lookup — จึงทำเครื่องหมายเป็น isPrivate แทนการเดา (2) แม้แต่
// public IP จริงก็ระบุตำแหน่งได้แค่คร่าว ๆ ระดับจุดของ ISP ในภูมิภาคนั้น
// ไม่ใช่ address ที่แม่นยำ และทุกอุปกรณ์หลัง router ออฟฟิศเดียวกันจะได้จุด
// เดียวกันหมด
import type { Pool } from "pg";
import { log } from "../logger.js";

export interface GeoResult {
  ip: string;
  isPrivate: boolean;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
  isp: string | null;
  asn: string | null;
  zip: string | null;
  timezone: string | null;
}

interface CacheRow {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
  is_private: boolean;
  isp: string | null;
  asn: string | null;
  zip: string | null;
  timezone: string | null;
}

function rowToResult(r: CacheRow): GeoResult {
  return {
    ip: r.ip,
    isPrivate: r.is_private,
    city: r.city,
    region: r.region,
    country: r.country,
    lat: r.lat,
    lon: r.lon,
    isp: r.isp,
    asn: r.asn,
    zip: r.zip,
    timezone: r.timezone,
  };
}

const EMPTY_GEO: Omit<GeoResult, "ip" | "isPrivate"> = {
  city: null,
  region: null,
  country: null,
  lat: null,
  lon: null,
  isp: null,
  asn: null,
  zip: null,
  timezone: null,
};

// ช่วง RFC1918 (IPv4 private), link-local และ IPv6 unique-local/link-local
// — คือ address ที่อุปกรณ์ทุกตัวบน LAN มีอยู่จริง สมมติว่า normalizeIp ใน
// ws/server.ts ได้ตัด prefix "::ffff:" แบบ IPv4-mapped ออกไปแล้ว ดังนั้น
// address ของ peer แบบ dual-stack จะดูเหมือน IPv4 ธรรมดาตรงนี้
export function isPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  const lower = ip.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

async function getCached(pool: Pool, ip: string): Promise<GeoResult | null> {
  const { rows } = await pool.query<CacheRow>(
    `SELECT ip, city, region, country, lat, lon, is_private, isp, asn, zip, timezone FROM ip_geolocation_cache
     WHERE ip = $1 AND looked_up_at > now() - interval '30 days'`,
    [ip],
  );
  return rows[0] ? rowToResult(rows[0]) : null;
}

async function storeCached(pool: Pool, r: GeoResult): Promise<void> {
  await pool.query(
    `INSERT INTO ip_geolocation_cache (ip, city, region, country, lat, lon, is_private, isp, asn, zip, timezone, looked_up_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (ip) DO UPDATE SET
       city = EXCLUDED.city, region = EXCLUDED.region, country = EXCLUDED.country,
       lat = EXCLUDED.lat, lon = EXCLUDED.lon, is_private = EXCLUDED.is_private,
       isp = EXCLUDED.isp, asn = EXCLUDED.asn, zip = EXCLUDED.zip, timezone = EXCLUDED.timezone,
       looked_up_at = now()`,
    [r.ip, r.city, r.region, r.country, r.lat, r.lon, r.isPrivate, r.isp, r.asn, r.zip, r.timezone],
  );
}

// free tier ของ ip-api.com: ไม่ต้องใช้ API key, จำกัดประมาณ 45 request/นาที,
// แผนฟรีรองรับแค่ HTTP (ไม่ใช่ HTTPS) — ไม่มีปัญหาตรงนี้เพราะเรียกจากฝั่ง
// server เท่านั้น ไม่เคยเรียกจาก browser เลย เปลี่ยนไปใช้ provider แบบเสีย
// เงิน/มี key (ipinfo.io, MaxMind, ...) แทนได้ ถ้า fleet โตเกินอัตรานี้หรือ
// ต้องการ egress แบบ HTTPS เท่านั้น cache ด้านบนทำให้ยังไงก็เรียกแค่ครั้ง
// เดียวต่อ IP ทุก 30 วันอยู่ดี
async function fetchPublicGeolocation(ip: string): Promise<Omit<GeoResult, "ip" | "isPrivate">> {
  const res = await fetch(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,city,regionName,country,lat,lon,isp,as,zip,timezone`,
  );
  const data = (await res.json()) as {
    status: string;
    message?: string;
    city?: string;
    regionName?: string;
    country?: string;
    lat?: number;
    lon?: number;
    isp?: string;
    as?: string;
    zip?: string;
    timezone?: string;
  };
  if (data.status !== "success") {
    log.warn({ ip, message: data.message }, "geolocation: lookup did not resolve");
    return { ...EMPTY_GEO };
  }
  return {
    city: data.city ?? null,
    region: data.regionName ?? null,
    country: data.country ?? null,
    lat: data.lat ?? null,
    lon: data.lon ?? null,
    isp: data.isp ?? null,
    // field "as" ของ ip-api คือ "AS24187 KIRZ Leaseline Network" — ทั้ง
    // string เลย ทั้ง ASN และชื่อ org รวมกัน เหมือนกับที่เว็บ lookup ISP
    // ทั่วไปแสดง
    asn: data.as ?? null,
    zip: data.zip ?? null,
    timezone: data.timezone ?? null,
  };
}

export async function lookupGeolocation(pool: Pool, ip: string): Promise<GeoResult> {
  const cached = await getCached(pool, ip);
  if (cached) return cached;

  if (isPrivateIp(ip)) {
    const result: GeoResult = { ip, isPrivate: true, ...EMPTY_GEO };
    await storeCached(pool, result);
    return result;
  }

  try {
    const geo = await fetchPublicGeolocation(ip);
    const result: GeoResult = { ip, isPrivate: false, ...geo };
    await storeCached(pool, result);
    return result;
  } catch (err) {
    log.warn({ err, ip }, "geolocation: lookup request failed");
    return { ip, isPrivate: false, ...EMPTY_GEO };
  }
}
