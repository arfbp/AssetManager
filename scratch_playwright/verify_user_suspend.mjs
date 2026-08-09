import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

// Log in as the target user first to get a real open session token, since
// the point of validateSession's status check is rejecting an ALREADY-OPEN
// session, not just blocking a future login attempt.
const targetLoginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "legacy" },
  body: JSON.stringify({ username: "_swtest51", password: "TempPass9x2Kq" }),
});
const { token: targetToken } = await targetLoginRes.json();
console.log("1. target user logged in, session token acquired:", Boolean(targetToken));

const meBeforeSuspend = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${targetToken}` } });
console.log("2. /auth/me before suspend (should be 200):", meBeforeSuspend.status);

// Suspend via the dashboard UI (as an admin in the same org)
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest50");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(1500);
await page.getByRole("link", { name: /users/i }).click();
await page.waitForTimeout(800);
await page.getByRole("row", { name: /_swtest51/i }).getByRole("button", { name: /suspend/i }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: /^suspend$/i }).last().click();
await page.waitForTimeout(1500);
const statusPill = await page.getByRole("row", { name: /_swtest51/i }).locator("text=/suspended/i").first().textContent().catch(() => null);
console.log("3. status pill shows suspended:", statusPill);
await browser.close();

// The target's OLD session token, already open before the suspend, must
// now be rejected on its very next request — not just at next login.
const meAfterSuspend = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${targetToken}` } });
console.log("4. /auth/me AFTER suspend, same old token (should be 401):", meAfterSuspend.status);

const loginAfterSuspend = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "legacy" },
  body: JSON.stringify({ username: "_swtest51", password: "TempPass9x2Kq" }),
});
console.log("5. fresh login attempt while suspended (should be 401):", loginAfterSuspend.status);
