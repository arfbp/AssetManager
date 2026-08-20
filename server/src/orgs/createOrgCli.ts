// CLI สำหรับ bootstrap organization ใหม่ — `npm run org:create -- <name> <subdomain>`
// พิมพ์ agent credentials ที่สร้างขึ้นออกมาแค่ครั้งเดียว (ไม่มีทางดึงกลับมาดู
// ได้อีกผ่าน endpoint ไหนเลย) — แนวทาง "จดไว้ตอนนี้เลย" เดียวกับ secret ที่
// สร้างขึ้นใหม่ตัวอื่น ๆ เมนู "Create organization" บน dashboard เอง (POST
// /orgs ใน routes.ts จำกัดเฉพาะ admin ภายใน platform org — ดู PLATFORM_ORG_ID
// ใน orgsStore.ts) คือ path ปกติ ส่วน CLI นี้มีไว้สำหรับ organization แรกสุด
// (ก่อนที่จะมี dashboard session ให้สร้างจากได้เลย) และเป็นทางเลือกแบบ
// scriptable/ops
//
// ช่องว่างที่รู้อยู่แล้วและตั้งใจไม่แก้ตรงนี้: process นี้ไม่มีทางส่งสัญญาณให้
// server ที่กำลังรันอยู่ reload OrgCredentialCache ในหน่วยความจำได้ (มีแค่
// HTTP route เท่านั้นที่เรียก credentials.reload() บน instance ที่รันอยู่จริง
// ได้ — ดู orgCredentials.ts) ถ้าใช้กับ server ที่กำลังรันอยู่ org ที่สร้าง
// ด้วยวิธีนี้จะใช้งานไม่ได้แบบเงียบ ๆ จนกว่าจะ restart คำเตือนที่พิมพ์ออกมา
// ด้านล่างคือทางบรรเทา แนะนำให้ใช้ flow ของ dashboard แทนเมื่อ server ยังรัน
// อยู่
import "dotenv/config";
import { initPool } from "../db/pool.js";
import { createOrganization, isValidSubdomain, DuplicateSubdomainError } from "./orgsStore.js";

async function main(): Promise<void> {
  const [, , name, subdomain] = process.argv;
  if (!name || !subdomain) {
    console.error("usage: npm run org:create -- <name> <subdomain>");
    process.exitCode = 1;
    return;
  }
  const normalizedSubdomain = subdomain.trim().toLowerCase();
  if (!isValidSubdomain(normalizedSubdomain)) {
    console.error(`invalid subdomain "${subdomain}" — lowercase letters, digits, hyphens only, can't start/end with a hyphen`);
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.OPTIFLEET_DATABASE_URL;
  if (!databaseUrl) {
    console.error("OPTIFLEET_DATABASE_URL must be set (see server/.env) — run `npm run db:migrate` first if you haven't.");
    process.exitCode = 1;
    return;
  }

  const pool = initPool(databaseUrl);
  try {
    const created = await createOrganization(pool, name, normalizedSubdomain);
    console.log(`organization "${created.org.name}" created (id ${created.org.id}, subdomain "${created.org.subdomain}").`);
    console.log("");
    console.log("Agent credentials — save these now, they are not shown again:");
    console.log(`  OPTIFLEET_AUTH_TOKEN=${created.agentAuthToken}`);
    console.log(`  OPTIFLEET_HMAC_SECRET=${created.agentHmacSecret}`);
    console.log("");
    console.log(`Next: npm run user:create -- <username> <password> admin ${created.org.subdomain}`);
    console.log("");
    console.log("*** IMPORTANT: this CLI runs as its own process and cannot reach an");
    console.log("*** already-running server's in-memory credential cache. If the server");
    console.log("*** is currently running, this org's agents/CORS will silently NOT work");
    console.log("*** until you run: systemctl restart optifleet-server (or your");
    console.log("*** deployment's equivalent). The dashboard's own \"Create organization\"");
    console.log("*** flow does not have this problem — prefer it when the server is live.");
  } catch (err) {
    if (err instanceof DuplicateSubdomainError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
