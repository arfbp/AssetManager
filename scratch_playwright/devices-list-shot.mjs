import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest7", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}/devices`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest7");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "devices-list-view.png", fullPage: true });

// Switch to grid view too
await page.getByLabel("Grid view").click();
await page.waitForTimeout(500);
await page.screenshot({ path: "devices-grid-view.png", fullPage: true });

console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
