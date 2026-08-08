import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest4", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}/software-deploy`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest4");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

await page.getByText("Firefox", { exact: true }).click();
const select = page.getByRole("main").getByRole("combobox");
await select.selectOption("DESKTOP-1NH0P21");
await page.getByRole("button", { name: /Deploy/ }).first().click();

// Watch the progress bar update over ~20 seconds
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(2500);
  const text = await page.locator("main").innerText();
  const progressLine = text.split("\n").find((l) => l.includes("%") || l.includes("Downloading") || l.includes("Installing") || l.includes("Completed") || l.includes("Failed") || l.includes("Waiting"));
  console.log(`[t+${(i + 1) * 2.5}s]`, progressLine);
}

await page.screenshot({ path: "progress-final.png", fullPage: true });
console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
