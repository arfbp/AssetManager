import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.fill('input[value=""]', ""); // no-op, just ensure page loaded
await page.locator("input").nth(0).fill("test_viewer2");
await page.locator("input").nth(1).fill("testpass123");
await page.locator('button:has-text("Sign in")').click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "viewer-dashboard.png" });

await page.goto("http://localhost:3000/users", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: "viewer-users-attempt.png" });
await browser.close();
