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

const beforeRows = await page.locator("tbody tr").count();
console.log("Before filter:", beforeRows, "rows");

const countrySelect = page.locator("select").nth(3);
await countrySelect.selectOption("Thailand");
await page.waitForTimeout(300);
const afterRows = await page.locator("tbody tr").count();
console.log("After filtering by country=Thailand:", afterRows, "rows");

const typeSelect = page.locator("select").nth(2);
await countrySelect.selectOption("all");
await typeSelect.selectOption({ index: 1 });
const selectedType = await typeSelect.inputValue();
await page.waitForTimeout(300);
const afterTypeRows = await page.locator("tbody tr").count();
console.log(`After filtering by type="${selectedType}":`, afterTypeRows, "rows");

await browser.close();
