import { chromium } from "playwright";

const TOKEN = "1e666ab731c8de98cccdfd434fe9ceb7942537b5deb571c10abbf1a7b9c0f0ad";
const USERNAME = "admin";

const browser = await chromium.launch();

async function shoot(path, outFile, theme) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(`http://localhost:3000${path}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ token, username, theme }) => {
      window.localStorage.setItem("optifleet-session-token", token);
      window.localStorage.setItem("optifleet-session-username", username);
      if (theme) window.localStorage.setItem("optifleet-theme", theme);
    },
    { token: TOKEN, username: USERNAME, theme },
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200); // let the WS connection populate + meter transitions settle

  await page.screenshot({ path: outFile, fullPage: true });
  console.log(`saved ${outFile} — console errors:`, JSON.stringify(consoleErrors));
  await page.close();
}

await shoot("/", "dashboard-light.png", "light");
await shoot("/", "dashboard-dark.png", "dark");
await shoot("/devices", "devices-light.png", "light");

await browser.close();
