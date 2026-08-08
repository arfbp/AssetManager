import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest", password: "TempPass9x2Kq" }),
});
const loginData = await loginRes.json();
const TOKEN = loginData.token;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

await page.goto(`${BASE}/software-deploy`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);

await page.getByText("7-Zip", { exact: true }).click();
const select = page.getByRole("main").getByRole("combobox");
await select.selectOption("DESKTOP-1NH0P21");
await page.waitForTimeout(300);

await page.getByRole("button", { name: /Deploy/ }).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: "software-deploy-result.png", fullPage: true });

const resultText = await page.locator("main").innerText();
console.log(resultText.includes("Dispatched") ? "DISPATCHED" : "NOT DISPATCHED");
console.log(resultText.split("\n").filter(l => l.includes("Dispatched") || l.includes("not currently")).join("\n"));

await browser.close();
