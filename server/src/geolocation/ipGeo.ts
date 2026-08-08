// IP-based geolocation for the "Live Tracking" page — deliberately not real
// GPS. This project has no vehicle/GPS hardware anywhere in it; what it does
// have is each agent's real public IP (self-reported by the agent via an
// external lookup — internal/telemetry/publicip.go — since only the agent's
// own network position can determine its internet-facing address; a
// same-LAN server would otherwise only ever see a private one), which this
// resolves to an approximate location AND ISP/ASN/postal/timezone detail
// via a free external API — the same level of detail a "what's my IP" site
// shows. Two honest limits worth knowing: (1) a private/LAN IP can never be
// geolocated at all — there's nothing to look up — so those are marked
// isPrivate rather than guessed at; (2) even a real public IP only
// geolocates to roughly the ISP's regional point, not a precise address,
// and every device behind the same office router shares that one point.
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

// RFC1918 (IPv4 private), link-local, and IPv6 unique-local/link-local
// ranges — the addresses every device on a LAN actually has. Assumes
// ws/server.ts's normalizeIp already stripped any "::ffff:" IPv4-mapped
// prefix, so a dual-stack peer's address looks like plain IPv4 here.
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

// ip-api.com's free tier: no API key, ~45 requests/minute, HTTP only (not
// HTTPS) on the free plan — fine here since the call originates server-side,
// never from the browser. Swap this for a paid/keyed provider (ipinfo.io,
// MaxMind, ...) if the fleet grows past that rate or needs HTTPS-only
// egress; the cache above means this only ever runs once per IP per 30
// days regardless.
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
    // ip-api's "as" field is "AS24187 KIRZ Leaseline Network" — the whole
    // string, ASN and org name together, same as ISP lookup sites show it.
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
