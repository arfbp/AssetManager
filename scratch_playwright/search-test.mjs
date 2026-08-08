import { chromium } from "playwright";
const TOKEN = "1e666ab731c8de98cccdfd434fe9ceb7942537b5deb571c10abbf1a7b9c0f0ad";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 800 } });
await page.goto("http://localhost:3000/devices?q=zzz-nomatch", { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.screenshot({ path: "search-nomatch.png" });

await page.goto("http://localhost:3000/devices?q=DESKTOP", { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.screenshot({ path: "search-match.png" });
console.log("done");
await browser.close();
