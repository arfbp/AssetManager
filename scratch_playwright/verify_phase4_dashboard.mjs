import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest19");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: "scratch_playwright/phase4-dashboard.png", fullPage: true });

// Also check the Devices page and Assets page render with real data
await page.goto(`${BASE}/devices`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "scratch_playwright/phase4-devices.png" });

console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
