import { chromium } from "playwright";
const BASE = "https://27-254-142-51.sslip.io";
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "_swtest12", password: "TempPass9x2Kq" }),
});
const { token: TOKEN } = await loginRes.json();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

// Install PeaZip fresh (quoted uninstall path with spaces, matches the failing pattern)
await page.goto(`${BASE}/software-deploy`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", "_swtest12");
  window.localStorage.setItem("optifleet-session-role", "admin");
}, { token: TOKEN });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.getByText("PeaZip", { exact: true }).click();
const searchInput = page.getByPlaceholder("Search online devices…");
await searchInput.fill("DESKTOP");
await page.waitForTimeout(300);
await page.getByText("DESKTOP-1NH0P21", { exact: true }).click();
await page.getByRole("button", { name: "Deploy" }).first().click();
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000);
  const text = await page.locator("main").innerText();
  if (text.includes("Completed successfully") || text.includes("Failed")) {
    console.log("INSTALL:", text.split("\n").find(l => l.includes("Completed") || l.includes("Failed")));
    break;
  }
}

// Now uninstall it with the fixed command
await page.goto(`${BASE}/uninstall-software`, { waitUntil: "networkidle" });
await searchInput.fill("DESKTOP").catch(() => {});
await page.getByPlaceholder("Search online devices…").fill("DESKTOP");
await page.waitForTimeout(300);
await page.getByText("DESKTOP-1NH0P21", { exact: true }).click();
await page.getByRole("button", { name: /Scan installed programs/ }).click();
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000);
  const text = await page.locator("main").innerText();
  if (text.includes("programs found")) break;
}
await page.getByPlaceholder("Filter by name or publisher…").fill("PeaZip");
await page.waitForTimeout(500);
await page.getByRole("button", { name: "Uninstall" }).first().click();
await page.waitForTimeout(300);
const cmdText = await page.locator("textarea").inputValue();
console.log("Generated uninstall command:\n", cmdText);
await page.getByRole("button", { name: "Uninstall" }).last().click();
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000);
  const text = await page.locator("main").innerText();
  if (text.includes("Completed successfully") || text.includes("Failed:")) {
    console.log("UNINSTALL:", text.split("\n").find(l => l.includes("Completed") || l.includes("Failed:")));
    break;
  }
}
await browser.close();
