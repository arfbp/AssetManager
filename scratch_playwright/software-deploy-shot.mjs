import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest", password: "TempPass9x2Kq" }),
});
if (!loginRes.ok) {
  console.error("login failed", loginRes.status, await loginRes.text());
  process.exit(1);
}
const loginData = await loginRes.json();
const TOKEN = loginData.token;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}/software-deploy`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "software-deploy-initial.png", fullPage: true });

// Check some boxes and select a device to see the generated command
await page.getByText("Chrome", { exact: true }).click();
await page.getByText("7-Zip", { exact: true }).click();
await page.getByText("Git", { exact: true }).click();
const select = page.getByRole("main").getByRole("combobox");
const optionCount = await select.locator("option").count();
console.log("device option count:", optionCount);
if (optionCount > 1) {
  await select.selectOption({ index: 1 });
}
await page.waitForTimeout(300);
await page.screenshot({ path: "software-deploy-filled.png", fullPage: true });

console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
