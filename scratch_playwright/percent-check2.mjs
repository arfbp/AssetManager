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
await page.goto(`${BASE}/software-deploy`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest11");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(20000); // wait for the previous PeaZip install (already in progress from last script) to finish
const text = await page.locator("main").innerText();
console.log("Contains 'Completed successfully':", text.includes("Completed successfully"));
const deployButtonVisible = await page.getByRole("button", { name: /Deploy$/ }).first().isVisible().catch(() => false);
console.log("Deploy button still visible:", deployButtonVisible);
await page.screenshot({ path: "percent-final-state.png" });
await browser.close();
