import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest13", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();

await page.goto(`${BASE}/uninstall-software`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest13");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

await page.getByPlaceholder(/search online devices/i).click();
await page.getByPlaceholder(/search online devices/i).fill("DESKTOP-1NH0P21");
await page.waitForTimeout(500);
await page.getByText("DESKTOP-1NH0P21", { exact: false }).first().click();
await page.waitForTimeout(300);

// Dispatch the scan, then immediately cut the network so the WebSocket
// drops before it can ever deliver the terminal "command_output" chunk —
// this reproduces exactly what the user hit (K-Lite Codecs finished
// server-side while the tab's socket had dropped mid-install and the UI
// never recovered). The scan itself still runs to completion on the real
// agent regardless of whether this browser is listening.
await page.getByRole("button", { name: /scan installed programs/i }).click();
console.log("dispatched scan, cutting network in 300ms...");
await page.waitForTimeout(300);
await context.setOffline(true);
console.log("offline now — waiting 8s for the scan to actually finish server-side...");
await page.waitForTimeout(8000);

const stuckText = await page.locator("text=/Waiting for the device|Scanning/i").count();
console.log("still shows in-progress while offline:", stuckText > 0);

console.log("going back online...");
await context.setOffline(false);

let recovered = false;
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(1000);
  const found = await page.locator("text=/programs? found on/i").count();
  if (found > 0) { recovered = true; console.log(`recovered after ~${i + 1}s back online`); break; }
}
console.log("RECOVERED:", recovered);

await page.screenshot({ path: "scratch_playwright/ws-reconcile-result.png" });
await browser.close();
