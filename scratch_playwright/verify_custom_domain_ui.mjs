import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest41");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(2000);

await page.getByRole("link", { name: /organizations/i }).click();
await page.waitForTimeout(500);

// Create a disposable test org (invite-link path, no password field)
await page.getByRole("button", { name: /create organization/i }).click();
await page.waitForTimeout(300);
await page.getByLabel(/organization name/i).fill("Domain UI Test Org");
await page.getByLabel(/^first name$/i).fill("Test");
await page.getByLabel(/^last name$/i).fill("Admin");
await page.getByLabel(/^username$/i).fill("domainuitestadmin");
await page.getByRole("button", { name: /^create organization$/i }).click();
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /^done$/i }).click();
await page.waitForTimeout(1000);

// Open the Domain modal for that org and set a test domain
await page.getByRole("row", { name: /domain ui test org/i }).getByRole("button", { name: /domain/i }).click();
await page.waitForTimeout(500);
await page.locator('input[placeholder="assets.customer.com"]').fill("assets.domainuitest.example.com");
await page.getByRole("button", { name: /^save$/i }).click();
await page.waitForTimeout(1500);

const domainCell = await page.locator("text=/assets.domainuitest.example.com/i").first().textContent().catch(() => null);
console.log("custom domain shown in table after save:", domainCell);

// Reopen and clear it
await page.getByRole("row", { name: /domain ui test org/i }).getByRole("button", { name: /domain/i }).click();
await page.waitForTimeout(500);
await page.getByRole("button", { name: /remove custom domain/i }).click();
await page.waitForTimeout(1500);

const domainCellAfterClear = await page
  .locator("text=/assets.domainuitest.example.com/i")
  .first()
  .textContent()
  .catch(() => "GONE (expected)");
console.log("custom domain cell after clear (should be GONE):", domainCellAfterClear);

await browser.close();
