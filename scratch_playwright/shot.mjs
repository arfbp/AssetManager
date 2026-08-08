import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

// Wait for the live WS connection to actually push agent data in, not just
// the initial "connecting..." shell.
await page.waitForSelector("text=DESKTOP-P8G7C64", { timeout: 15000 });
await page.waitForTimeout(500); // let meters finish their CSS transition

await page.screenshot({ path: "dashboard.png", fullPage: true });
console.log("screenshot saved");

console.log("console errors:", JSON.stringify(consoleErrors, null, 2));

await browser.close();
