import { chromium } from "playwright";

const BASE = "https://360qm.27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest23");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(2500);

console.log("post-login URL:", page.url());
console.log("console errors:", JSON.stringify(consoleErrors));
await page.screenshot({ path: "scratch_playwright/subdomain-full-login-result.png", fullPage: true });
await browser.close();
