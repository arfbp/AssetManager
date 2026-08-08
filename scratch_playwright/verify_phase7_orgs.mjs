import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest20");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(2000);

console.log("Organizations nav item visible:", await page.getByRole("link", { name: /organizations/i }).isVisible());

await page.getByRole("link", { name: /organizations/i }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "scratch_playwright/phase7-orgs-list.png" });

await page.getByRole("button", { name: /create organization/i }).click();
await page.waitForTimeout(500);

await page.getByLabel(/organization name/i).fill("Acme Test Corp");
await page.waitForTimeout(300); // let subdomain auto-slug from name
const subdomainField = page.getByLabel(/subdomain/i);
console.log("auto-slugged subdomain:", await subdomainField.inputValue());

await page.getByLabel(/^first name$/i).fill("Test");
await page.getByLabel(/^last name$/i).fill("Admin");
await page.getByLabel(/^username$/i).fill("acmeadmin");
await page.getByLabel(/password \(min/i).fill("AcmePass9x2Kq");

await page.screenshot({ path: "scratch_playwright/phase7-create-form.png" });
await page.getByRole("button", { name: /^create organization$/i }).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: "scratch_playwright/phase7-credentials-modal.png" });

const modalText = await page.locator("text=/created/i").first().textContent().catch(() => null);
console.log("post-create modal shows:", modalText);

await page.getByRole("button", { name: /^done$/i }).click();
await page.waitForTimeout(1000);
await page.screenshot({ path: "scratch_playwright/phase7-orgs-list-after.png" });

console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
