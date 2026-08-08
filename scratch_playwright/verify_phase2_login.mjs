import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest18");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(2500);

const url = page.url();
const bodyText = await page.locator("body").textContent();
console.log("post-login URL:", url);
console.log("contains 'Dashboard' or nav:", /Dashboard|Devices|Software Deploy/.test(bodyText ?? ""));
console.log("console errors:", JSON.stringify(consoleErrors));

await page.screenshot({ path: "scratch_playwright/phase2-login-result.png" });
await browser.close();
