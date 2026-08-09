import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('input[type="text"], input:not([type])').first().fill("_swtest70");
await page.locator('input[type="password"]').fill("TempPass9x2Kq");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForTimeout(1500);
await page.getByRole("link", { name: /ai console/i }).first().click();
await page.waitForTimeout(800);

async function sendChat(text) {
  await page.locator('input[placeholder*="hung antivirus"]').fill(text);
  await page.getByRole("button", { name: /^send$/i }).click();
}

// --- Reactivate, with generous LLM-latency tolerance ---
await sendChat("reactivate the organization AI Cmd Test Org");
const confirmHeading = page.getByRole("heading", { name: /confirm this action/i });
await confirmHeading.waitFor({ state: "visible", timeout: 30000 });
console.log("1. reactivate confirmation dialog appeared");
await page.getByRole("button", { name: /^confirm$/i }).click();
await page.waitForTimeout(2000);

const reactivateCheck = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "ai-cmd-test-org" },
  body: JSON.stringify({ username: "aicmdadmin", password: "TempPass9x2Kq" }),
});
console.log("2. login after reactivate (should be 200):", reactivateCheck.status);

// --- Delete, type-to-confirm ---
await sendChat("permanently delete the organization AI Cmd Test Org, I understand this cannot be undone");
const deleteHeading = page.getByRole("heading", { name: /^delete "ai cmd test org"$/i });
await deleteHeading.waitFor({ state: "visible", timeout: 30000 });
console.log("3. delete type-to-confirm dialog appeared");

const deleteBtn = page.getByRole("button", { name: /delete permanently/i });
console.log("3b. delete button disabled before typing name:", await deleteBtn.isDisabled());
await page.locator("input").last().fill("wrong name");
console.log("3c. delete button disabled with WRONG name typed:", await deleteBtn.isDisabled());
await page.locator("input").last().fill("");
await page.locator("input").last().fill("AI Cmd Test Org");
console.log("3d. delete button disabled with CORRECT name typed:", await deleteBtn.isDisabled());
await deleteBtn.click();
await page.waitForTimeout(2000);

await browser.close();

const orgCheck = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "ai-cmd-test-org" },
  body: JSON.stringify({ username: "aicmdadmin", password: "TempPass9x2Kq" }),
});
console.log("4. login to deleted org (should be 401 — org no longer resolves):", orgCheck.status);
console.log("done");
