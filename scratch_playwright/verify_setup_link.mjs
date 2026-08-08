import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest40");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(2000);

await page.getByRole("link", { name: /organizations/i }).click();
await page.waitForTimeout(500);

// Create a fresh test org with NO password field (the new invite-only path)
await page.getByRole("button", { name: /create organization/i }).click();
await page.waitForTimeout(300);
await page.getByLabel(/organization name/i).fill("Setup Link Test Org");
await page.getByLabel(/^first name$/i).fill("Test");
await page.getByLabel(/^last name$/i).fill("Admin");
await page.getByLabel(/^username$/i).fill("setuplinktestadmin");
await page.getByRole("button", { name: /^create organization$/i }).click();
await page.waitForTimeout(2000);

const setupLinkText = await page.locator("p", { hasText: "/setup-password?token=" }).first().textContent();
console.log("setup link shown in modal:", setupLinkText);
if (!setupLinkText || !setupLinkText.includes("/setup-password?token=")) {
  throw new Error("No setup link found in CredentialsModal — invite flow broken");
}
const setupLink = setupLinkText.trim();

await page.getByRole("button", { name: /^done$/i }).click();
await page.waitForTimeout(500);
await browser.close();

// Open the setup link in a completely fresh context (no session at all).
// ignoreHTTPSErrors: the new subdomain's TLS cert doesn't have a SAN for it
// yet (a known, separate infra limitation — certbot --expand needs to be
// re-run per new subdomain, not something this test is checking), so this
// bypasses that to verify the app logic itself.
const browser2 = await chromium.launch();
const page2 = await browser2.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
await page2.goto(setupLink, { waitUntil: "networkidle" });
await page2.screenshot({ path: "scratch_playwright/setup-password-page.png" });

await page2.locator('input[autocomplete="new-password"]').first().fill("BrandNewSetupPass9x2");
await page2.locator('input[autocomplete="new-password"]').nth(1).fill("BrandNewSetupPass9x2");
await page2.getByRole("button", { name: /^set password$/i }).click();
await page2.waitForTimeout(1500);
const confirmText = await page2.locator("text=/Password set/i").first().textContent().catch(() => null);
console.log("setup confirmation shown:", confirmText);
await browser2.close();

// Verify via direct API: login with the new password succeeds
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "setup-link-test-org" },
  body: JSON.stringify({ username: "setuplinktestadmin", password: "BrandNewSetupPass9x2" }),
});
console.log("login with new self-set password status (should be 200):", loginRes.status);

// Verify the link can't be reused (single-use enforcement)
const reuseRes = await fetch(`${BASE}/api/auth/setup-password`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: setupLink.split("token=")[1], password: "AnotherPassword9x2" }),
});
console.log("reusing the same setup token status (should be 400):", reuseRes.status);
