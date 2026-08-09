import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();

// Login screen — check for bilibili leftovers and new branding
const loginPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await loginPage.goto(`${BASE}/`, { waitUntil: "networkidle" });
await loginPage.screenshot({ path: "scratch_playwright/redesign-login.png" });
const bilibiliRefs = await loginPage.locator('img[alt="bilibili"]').count();
console.log("1. bilibili <img> elements on login page (should be 0):", bilibiliRefs);
const markVisible = await loginPage.locator('img[src="/optifleet-mark.svg"]').first().isVisible();
console.log("2. new mark visible on login:", markVisible);

await loginPage.locator('input[type="text"], input:not([type])').first().fill("_swtest60");
await loginPage.locator('input[type="password"]').fill("TempPass9x2Kq");
await loginPage.getByRole("button", { name: /sign in/i }).click();
await loginPage.waitForTimeout(2000);

// Light theme dashboard + sidebar
await loginPage.screenshot({ path: "scratch_playwright/redesign-dashboard-default.png", fullPage: false });
const sectionLabels = await loginPage.locator("aside p.uppercase").allTextContents();
console.log("3. sidebar section labels found:", sectionLabels);

// Force dark theme via the toggle, screenshot again
const themeToggle = loginPage.getByRole("button", { name: /theme|dark|light/i }).first();
if (await themeToggle.count() > 0) {
  await themeToggle.click();
  await loginPage.waitForTimeout(300);
  await themeToggle.click(); // cycle once more if first click landed on "system"
  await loginPage.waitForTimeout(300);
}
await loginPage.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await loginPage.waitForTimeout(300);
await loginPage.screenshot({ path: "scratch_playwright/redesign-dashboard-dark.png", fullPage: false });

await loginPage.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
await loginPage.waitForTimeout(300);
await loginPage.screenshot({ path: "scratch_playwright/redesign-dashboard-light.png", fullPage: false });

await browser.close();
console.log("done");
