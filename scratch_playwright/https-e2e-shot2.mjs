import { chromium } from "playwright";
const TOKEN = "1e666ab731c8de98cccdfd434fe9ceb7942537b5deb571c10abbf1a7b9c0f0ad";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
const consoleErrors = [];
const failedRequests = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on("requestfailed", (req) => failedRequests.push(`${req.url()} :: ${req.failure()?.errorText}`));

await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "admin");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.screenshot({ path: "https-dashboard.png" });
console.log("console errors:", JSON.stringify(consoleErrors));
console.log("failed requests:", JSON.stringify(failedRequests));
await browser.close();
