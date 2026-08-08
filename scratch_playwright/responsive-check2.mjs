import { chromium } from "playwright";
const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest8", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`${BASE}/console`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest8");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.screenshot({ path: "resp2-mobile-console-header.png" });

// open the hamburger drawer
await page.getByLabel("Open menu").click();
await page.waitForTimeout(400);
await page.screenshot({ path: "resp2-mobile-drawer-open.png" });

// click a nav item in the drawer (Uninstall Software) and confirm navigation + drawer closes
await page.getByRole("link", { name: "Uninstall Software" }).click();
await page.waitForTimeout(800);
console.log("URL after nav click:", page.url());
await page.screenshot({ path: "resp2-mobile-uninstall.png" });

await browser.close();
