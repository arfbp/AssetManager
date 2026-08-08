import { chromium } from "playwright";
const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest4", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/software-deploy`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest4");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.getByText("Firefox", { exact: true }).click();
const select = page.getByRole("main").getByRole("combobox");
await select.selectOption("DESKTOP-1NH0P21");
await page.getByRole("button", { name: /Deploy/ }).first().click();
await page.waitForTimeout(3000);
await page.screenshot({ path: "final-progress-bar.png", fullPage: false, clip: { x: 0, y: 0, width: 1600, height: 700 } });
await browser.close();
