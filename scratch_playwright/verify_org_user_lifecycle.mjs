import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator('input[type="text"], input:not([type])').first().fill("_swtest50");
  await page.locator('input[type="password"]').fill("TempPass9x2Kq");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await login(page);

await page.getByRole("link", { name: /organizations/i }).click();
await page.waitForTimeout(500);

// --- Create test org (invite-link path) ---
await page.getByRole("button", { name: /create organization/i }).click();
await page.waitForTimeout(300);
await page.getByLabel(/organization name/i).fill("Lifecycle Test Org");
await page.getByLabel(/^first name$/i).fill("Test");
await page.getByLabel(/^last name$/i).fill("Admin");
await page.getByLabel(/^username$/i).fill("lifecycletestadmin");
await page.getByRole("button", { name: /^create organization$/i }).click();
await page.waitForTimeout(2000);
const setupLinkText = (await page.locator("p", { hasText: "/setup-password?token=" }).first().textContent()) ?? "";
const setupToken = setupLinkText.split("token=")[1]?.trim();
console.log("1. org created, setup token acquired:", Boolean(setupToken));
await page.getByRole("button", { name: /^done$/i }).click();
await page.waitForTimeout(1000);

// Complete setup-password via direct API (already verified via UI in a prior test this session)
const setupRes = await fetch(`${BASE}/api/auth/setup-password`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: setupToken, password: "LifecycleTestPass9x2" }),
});
console.log("2. setup-password completed (should be 204):", setupRes.status);

// --- Rename + change subdomain ---
await page.getByRole("row", { name: /lifecycle test org/i }).getByRole("button", { name: /rename/i }).click();
await page.waitForTimeout(400);
await page.locator("form").getByLabel(/organization name/i).fill("Lifecycle Test Org Renamed");
await page.getByLabel(/^subdomain$/i).fill("lifecycle-test-org-2");
await page.getByRole("button", { name: /^save$/i }).click();
await page.waitForTimeout(1500);
const renamedShown = await page.locator("text=/Lifecycle Test Org Renamed/i").first().textContent().catch(() => null);
console.log("3. rename + subdomain change shown in table:", renamedShown);

// Login under the NEW subdomain works immediately (no restart)
const loginNewSubdomain = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "lifecycle-test-org-2" },
  body: JSON.stringify({ username: "lifecycletestadmin", password: "LifecycleTestPass9x2" }),
});
console.log("4. login under NEW subdomain (should be 200):", loginNewSubdomain.status);

// --- Suspend org, verify login blocked ---
await page.getByRole("row", { name: /lifecycle test org renamed/i }).getByRole("button", { name: /suspend/i }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: /^suspend$/i }).last().click();
await page.waitForTimeout(1500);

const loginWhileSuspended = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "lifecycle-test-org-2" },
  body: JSON.stringify({ username: "lifecycletestadmin", password: "LifecycleTestPass9x2" }),
});
console.log("5. login while org SUSPENDED (should be 401):", loginWhileSuspended.status);

// --- Reactivate org, verify login works again ---
await page.getByRole("row", { name: /lifecycle test org renamed/i }).getByRole("button", { name: /reactivate/i }).click();
await page.waitForTimeout(1500);
const loginAfterReactivate = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "lifecycle-test-org-2" },
  body: JSON.stringify({ username: "lifecycletestadmin", password: "LifecycleTestPass9x2" }),
});
console.log("6. login after REACTIVATE (should be 200):", loginAfterReactivate.status);

// --- Delete org (type-to-confirm) ---
await page.getByRole("row", { name: /lifecycle test org renamed/i }).getByRole("button", { name: /delete/i }).click();
await page.waitForTimeout(400);
await page.locator('input').last().fill("Lifecycle Test Org Renamed");
await page.getByRole("button", { name: /delete permanently/i }).click();
await page.waitForTimeout(1500);
const stillListed = await page.locator("text=/Lifecycle Test Org Renamed/i").first().textContent().catch(() => null);
console.log("7. org still listed after delete (should be null):", stillListed);

// --- Audit log check ---
await page.getByRole("link", { name: /audit log/i }).click();
await page.waitForTimeout(1000);
const auditRowCount = await page.locator("tbody tr").count();
console.log("8. audit log row count (should be > 0):", auditRowCount);
const hasOrgCreated = await page.locator("text=/Created/i").first().isVisible().catch(() => false);
console.log("9. audit log shows an org creation event:", hasOrgCreated);

await browser.close();
