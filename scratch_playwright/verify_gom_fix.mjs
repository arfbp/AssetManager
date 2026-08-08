import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest11", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

await page.goto(`${BASE}/uninstall-software`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest11");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

await page.getByPlaceholder(/search online devices/i).click();
await page.getByPlaceholder(/search online devices/i).fill("DESKTOP-1NH0P21");
await page.waitForTimeout(500);
await page.getByText("DESKTOP-1NH0P21", { exact: false }).first().click();
await page.waitForTimeout(300);

await page.getByRole("button", { name: /scan installed programs/i }).click();
console.log("scanning...");
await page.waitForSelector("text=/programs? found on/i", { timeout: 30000 });
await page.waitForTimeout(500);

await page.getByPlaceholder(/filter by name or publisher/i).fill("GOM");
await page.waitForTimeout(500);

await page.getByRole("button", { name: /uninstall/i }).first().click();
console.log("modal opened, clicking dispatch...");
await page.waitForTimeout(500);

const modal = page.locator("div.relative.z-10");
await modal.getByRole("button", { name: /uninstall/i }).click();
console.log("uninstall dispatched, waiting for result inside modal...");

for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000);
  const modalText = await modal.textContent();
  if (/Completed successfully|Failed:/.test(modalText)) {
    console.log(`RESULT (after ${(i + 1) * 3}s):`, modalText.match(/(✓ Completed successfully\.|✗ Failed:[^\n]*)/)?.[0]);
    break;
  }
  console.log(`...still waiting at ${(i + 1) * 3}s`);
}

await page.screenshot({ path: "scratch_playwright/gom-verify-result2.png" });
await browser.close();
