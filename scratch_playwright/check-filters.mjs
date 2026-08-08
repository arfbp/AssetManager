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
await page.goto(`${BASE}/devices`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest7");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const selects = page.locator("select");
const count = await selects.count();
for (let i = 0; i < count; i++) {
  const options = await selects.nth(i).locator("option").allTextContents();
  console.log(`select[${i}]:`, options);
}

// Test the type filter actually filters
const typeSelect = selects.nth(1);
const opts = await typeSelect.locator("option").allInnerTexts();
if (opts.length > 1) {
  await typeSelect.selectOption({ index: 1 });
  await page.waitForTimeout(300);
  const rows = await page.locator("tbody tr").count();
  console.log(`After filtering by type "${opts[1]}": ${rows} row(s)`);
}
await browser.close();
