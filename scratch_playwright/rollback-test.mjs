import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";
const TARGET_VERSION = process.argv[2]; // e.g. "2026.08.05-8"

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest3", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });

await page.goto(`${BASE}/agent-updates`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest3");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

const row = page.locator("tr", { hasText: TARGET_VERSION });
await row.getByRole("button", { name: "Set active" }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `rollback-${TARGET_VERSION}.png`, fullPage: true });

console.log(`activated ${TARGET_VERSION}`);
await browser.close();
