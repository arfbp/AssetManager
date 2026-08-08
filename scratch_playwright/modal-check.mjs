import { chromium } from "playwright";
const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest9", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/uninstall-software`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest9");
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
// scroll down to a card far below (simulate long list) and click Uninstall
await page.getByPlaceholder("Filter by name or publisher…").fill("Notepad++");
await page.waitForTimeout(500);
await page.getByRole("button", { name: "Uninstall" }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: "modal-popup-check.png" });
console.log("modal visible:", await page.getByText("Uninstall command").isVisible());
await browser.close();
