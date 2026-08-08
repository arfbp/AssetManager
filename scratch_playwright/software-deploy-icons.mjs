import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest10", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1400 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}/software-deploy`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest10");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const categoryCount = await page.locator("h3.text-xs.font-semibold.uppercase").count();
const checkboxCount = await page.locator('input[type="checkbox"]').count();
const imgCount = await page.locator("img").count();

await page.screenshot({ path: "scratch_playwright/software-deploy-full.png", fullPage: true });
await page.screenshot({ path: "scratch_playwright/software-deploy-top.png" });

console.log("categories:", categoryCount, "checkboxes:", checkboxCount, "img icons:", imgCount);
console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
