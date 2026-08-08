import { chromium } from "playwright";
const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest8", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();

const browser = await chromium.launch();

const pages = ["/console", "/agent-updates", "/uninstall-software", "/software-deploy"];
const sizes = [
  { name: "laptop", width: 1366, height: 800 },
  { name: "tablet", width: 834, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];

for (const size of sizes) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.goto(`${BASE}${pages[0]}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ token }) => {
    window.localStorage.setItem("optifleet-session-token", token);
    window.localStorage.setItem("optifleet-session-username", "_swtest8");
    window.localStorage.setItem("optifleet-session-role", "admin");
  }, { token: TOKEN });
  for (const path of pages) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const name = path.replace("/", "") || "root";
    await page.screenshot({ path: `resp-${size.name}-${name}.png`, fullPage: true });
  }
  await page.close();
}
await browser.close();
console.log("done");
