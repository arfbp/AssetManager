import { chromium } from "playwright";
import path from "node:path";

const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest2", password: "TempPass9x2Kq" }),
});
if (!loginRes.ok) {
  console.error("login failed", loginRes.status, await loginRes.text());
  process.exit(1);
}
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}/software-deploy`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest2");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// Select target device (shared selector)
const select = page.getByRole("main").getByRole("combobox");
await select.selectOption("DESKTOP-1NH0P21");

// Upload the custom installer
const fileInput = page.locator('input[type="file"]');
await fileInput.setInputFiles(path.resolve("C:/Users/PC/AppData/Local/Temp/test-installer.exe"));
await page.getByRole("button", { name: "Upload" }).click();
await page.waitForTimeout(3000);
await page.screenshot({ path: "custom-upload-filled.png", fullPage: true });

const uploadedText = await page.locator("main").innerText();
console.log("Upload confirmed:", uploadedText.includes("Uploaded"));

const deployButtons = page.getByRole("button", { name: /Deploy/ });
const count = await deployButtons.count();
console.log("deploy button count:", count);
await deployButtons.nth(count - 1).click(); // the custom-installer section's Deploy is the last one
await page.waitForTimeout(2000);
await page.screenshot({ path: "custom-upload-result.png", fullPage: true });

const resultText = await page.locator("main").innerText();
console.log(resultText.includes("Dispatched") ? "DISPATCHED" : "NOT DISPATCHED");

console.log("console errors:", JSON.stringify(consoleErrors));
await browser.close();
