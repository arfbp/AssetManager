import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text()); });
page.on("requestfailed", (req) => console.log("REQUEST FAILED:", req.url(), req.failure()?.errorText));
page.on("response", (res) => { if (res.url().includes("/installer")) console.log("installer response:", res.status(), res.url()); });

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest22");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(2000);

await page.getByRole("link", { name: /organizations/i }).click();
await page.waitForTimeout(1000);

await page.getByRole("button", { name: /create organization/i }).click();
await page.waitForTimeout(300);
await page.getByLabel(/organization name/i).fill("Installer Test Org");
await page.getByLabel(/^first name$/i).fill("Test");
await page.getByLabel(/^last name$/i).fill("Admin");
await page.getByLabel(/^username$/i).fill("installertestadmin");
await page.getByLabel(/password \(min/i).fill("InstallerPass9x2");
await page.getByRole("button", { name: /^create organization$/i }).click();
await page.waitForTimeout(2000);

// Download directly from the credentials modal
const [download1] = await Promise.all([
  page.waitForEvent("download", { timeout: 60000 }),
  page.getByRole("button", { name: "download Download installer" }).click(),
]);
console.log("modal download filename:", download1.suggestedFilename());
const path1 = await download1.path();
console.log("modal download size (bytes):", path1 ? (await import("node:fs")).statSync(path1).size : "FAILED - no path");

await page.getByRole("button", { name: /^done$/i }).click();
await page.waitForTimeout(1000);

// Download again from the table row (proves re-download works without needing the creation-time credentials)
const [download2] = await Promise.all([
  page.waitForEvent("download", { timeout: 60000 }),
  page.getByRole("row", { name: /installer test org/i }).getByRole("button", { name: /installer/i }).click(),
]);
console.log("table row re-download filename:", download2.suggestedFilename());
const path2 = await download2.path();
console.log("table row re-download size (bytes):", path2 ? (await import("node:fs")).statSync(path2).size : "FAILED - no path");

await browser.close();
