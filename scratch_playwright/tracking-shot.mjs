import { chromium } from "playwright";

const TOKEN = "1e666ab731c8de98cccdfd434fe9ceb7942537b5deb571c10abbf1a7b9c0f0ad";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto("http://localhost:3000/tracking", { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "tracking-light.png", fullPage: true });
console.log("saved tracking-light.png — console errors:", JSON.stringify(consoleErrors));
await browser.close();
