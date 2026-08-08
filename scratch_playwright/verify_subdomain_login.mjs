import { chromium } from "playwright";

const BASE = "https://360qm.27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("requestfailed", (req) => consoleErrors.push(`REQUEST FAILED: ${req.url()} ${req.failure()?.errorText}`));

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
console.log("page loaded, url:", page.url());
console.log("console errors so far:", JSON.stringify(consoleErrors));

await page.screenshot({ path: "scratch_playwright/subdomain-login-page.png" });
