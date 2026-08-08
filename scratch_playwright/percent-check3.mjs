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

// Uninstall the PeaZip that's already installed from the earlier test, in the SAME session, watching state throughout
const searchInput = page.getByPlaceholder("Search online devices…");
await searchInput.fill("DESKTOP");
await page.waitForTimeout(300);
await page.getByText("DESKTOP-1NH0P21", { exact: true }).click();
await page.getByRole("button", { name: /Scan installed programs/ }).click();
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000);
  const text = await page.locator("main").innerText();
  if (text.includes("programs found")) break;
}
await page.getByPlaceholder("Filter by name or publisher…").fill("PeaZip");
await page.waitForTimeout(500);
await page.getByRole("button", { name: "Uninstall" }).first().click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Uninstall" }).last().click();

for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(2000);
  const btnCount = await page.getByRole("button", { name: /Uninstalling|^Uninstall$/ }).count();
  const successVisible = await page.getByText("Completed successfully").isVisible().catch(() => false);
  console.log(`[t+${(i+1)*2}s] uninstall-button-count=${btnCount} success-visible=${successVisible}`);
  if (successVisible) break;
}
await page.screenshot({ path: "percent-disappear-check.png" });
await browser.close();
