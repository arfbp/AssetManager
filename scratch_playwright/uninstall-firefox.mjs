import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest5", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });

await page.goto(`${BASE}/uninstall-software`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest5");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

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

const filterInput = page.getByPlaceholder("Filter by name or publisher…");
await filterInput.fill("Firefox");
await page.waitForTimeout(500);
await page.screenshot({ path: "uninstall-firefox-filtered.png", fullPage: true });

await page.getByRole("button", { name: "Uninstall" }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: "uninstall-firefox-confirm.png", fullPage: true });

const uninstallButtons = page.getByRole("button", { name: "Uninstall" });
const count = await uninstallButtons.count();
console.log("uninstall button count (card buttons + confirm button):", count);
await uninstallButtons.nth(count - 1).click();

for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2000);
  const text = await page.locator("main").innerText();
  if (text.includes("Completed successfully") || text.includes("Failed")) break;
}
await page.screenshot({ path: "uninstall-firefox-result.png", fullPage: true });
console.log("done");
await browser.close();
