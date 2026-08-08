import { chromium } from "playwright";
const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest11", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/uninstall-software`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest11");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// First install PeaZip via Software Deploy to have a safe target
await page.goto(`${BASE}/software-deploy`, { waitUntil: "networkidle" });
await page.getByText("PeaZip", { exact: true }).click();
const searchInput = page.getByPlaceholder("Search online devices…");
await searchInput.fill("DESKTOP");
await page.waitForTimeout(300);
await page.getByText("DESKTOP-1NH0P21", { exact: true }).click();
await page.getByRole("button", { name: "Deploy" }).first().click();
console.log("deploy clicked - watching button text over time...");
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(1500);
  const btnText = await page.getByRole("button", { name: /Deploy|Dispatching/ }).first().innerText().catch(() => "(button gone)");
  console.log(`[t+${(i+1)*1.5}s] button:`, btnText);
}
await browser.close();
