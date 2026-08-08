import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "acme-test-corp" },
  body: JSON.stringify({ username: "acmeadmin", password: "AcmePass9x2Kq" }),
});
const loginBody = await loginRes.json();
console.log("new org admin login:", JSON.stringify(loginBody));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.evaluate(({ token, username, role, isPlatformAdmin }) => {
  window.localStorage.setItem("optifleet-session-token", token);
  window.localStorage.setItem("optifleet-session-username", username);
  window.localStorage.setItem("optifleet-session-role", role);
  window.localStorage.setItem("optifleet-session-platform-admin", String(isPlatformAdmin));
}, loginBody);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const orgsLinkCount = await page.getByRole("link", { name: /organizations/i }).count();
console.log("Organizations nav item count for acme-test-corp admin (should be 0):", orgsLinkCount);

// Direct navigation attempt too, not just checking the nav link
await page.goto(`${BASE}/organizations`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const bodyText = await page.locator("body").textContent();
console.log("direct /organizations visit shows permission error:", /don't have permission/i.test(bodyText ?? ""));
await page.screenshot({ path: "scratch_playwright/phase7-blocked-org-page.png" });

await browser.close();
