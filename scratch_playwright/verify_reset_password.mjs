import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest24");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(2000);

await page.getByRole("link", { name: /organizations/i }).click();
await page.waitForTimeout(500);

// Create a fresh test org with a known original password
await page.getByRole("button", { name: /create organization/i }).click();
await page.waitForTimeout(300);
await page.getByLabel(/organization name/i).fill("Reset Test Org");
await page.getByLabel(/^first name$/i).fill("Test");
await page.getByLabel(/^last name$/i).fill("Admin");
await page.getByLabel(/^username$/i).fill("resettestadmin");
await page.getByLabel(/password \(min/i).fill("OriginalPass9x2");
await page.getByRole("button", { name: /^create organization$/i }).click();
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /^done$/i }).click();
await page.waitForTimeout(1000);

// Open "Users" for that org, reset the password via the new UI
await page.getByRole("row", { name: /reset test org/i }).getByRole("button", { name: /users/i }).click();
await page.waitForTimeout(1000);
await page.getByRole("button", { name: /reset password/i }).click();
await page.waitForTimeout(500);
await page.locator('input[type="password"]').fill("BrandNewPass9x2");
await page.getByRole("button", { name: /^reset password$/i }).last().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "scratch_playwright/reset-password-result.png" });

const successText = await page.locator("text=/Password reset for/i").first().textContent().catch(() => null);
console.log("reset confirmation shown:", successText);
await page.getByRole("button", { name: /^close$/i }).click();
await browser.close();

// Now verify: OLD password fails, NEW password works — via direct API, not UI, for speed/certainty
const oldRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "reset-test-org" },
  body: JSON.stringify({ username: "resettestadmin", password: "OriginalPass9x2" }),
});
console.log("login with OLD password status (should be 401):", oldRes.status);

const newRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "reset-test-org" },
  body: JSON.stringify({ username: "resettestadmin", password: "BrandNewPass9x2" }),
});
console.log("login with NEW password status (should be 200):", newRes.status);
