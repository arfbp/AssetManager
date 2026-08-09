import { chromium } from "playwright";

const BASE = "https://27-254-142-51.sslip.io";

// currentOrgSubdomain() (frontend/src/lib/session.ts) derives the org from
// window.location.hostname, not anything explicit — so logging into a
// non-legacy org means actually navigating to that org's own subdomain
// host, same pattern as this session's earlier verify_setup_link.mjs.
function urlFor(subdomain) {
  return subdomain === "legacy" ? BASE : `https://${subdomain}.27-254-142-51.sslip.io`;
}

async function login(page, subdomain, username, password) {
  await page.goto(`${urlFor(subdomain)}/`, { waitUntil: "networkidle" });
  await page.locator('input[type="text"], input:not([type])').first().fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(1500);
}

async function sendChat(page, text) {
  await page.locator('input[placeholder*="hung antivirus"]').fill(text);
  await page.getByRole("button", { name: /^send$/i }).click();
  await page.waitForTimeout(4000);
}

const browser = await chromium.launch();

// ---- Part 1: org admin (NOT platform admin) ----
// ignoreHTTPSErrors: the test org's subdomain has no TLS cert SAN of its
// own (same known, separate infra limitation noted earlier this session)
// — bypassed here to verify the app logic, not the cert coverage.
const page1 = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
await login(page1, "ai-cmd-test-org", "aicmdadmin", "TempPass9x2Kq");
await page1.getByRole("link", { name: /ai console/i }).first().click();
await page1.waitForTimeout(800);

try {
  await sendChat(page1, "create a new organization called Acme Test Corp, subdomain acmetestcorp123, admin username bob");
  const blockedText = await page1.locator("text=/platform/i").first().textContent().catch(() => null);
  console.log("1. non-platform-admin org creation blocked (should mention platform):", blockedText);
} catch (err) {
  console.log("1. FAILED:", err.message);
}

try {
  await sendChat(page1, "create a new user account, first name Dave, last name Carter, username davecarter, role it_support");
  await page1.waitForTimeout(1000);
  const modalVisible = await page1.getByRole("heading", { name: /add user/i }).isVisible().catch(() => false);
  console.log("2. AddUserModal opened after create_user command:", modalVisible);
  if (modalVisible) {
    const usernameVal = await page1.locator('label:has-text("Username") input').inputValue().catch(() => "");
    console.log("2b. prefilled username field:", usernameVal);
    await page1.locator('label:has-text("Password") input').fill("DaveCarterPass9x2");
    await page1.getByRole("button", { name: /^create user$/i }).click();
    await page1.waitForTimeout(1500);
    console.log("2c. submitted user creation form");
  }
} catch (err) {
  console.log("2. FAILED:", err.message);
}

try {
  await sendChat(page1, "generate an agent installer for this organization");
  await page1.waitForTimeout(500);
  const downloadBtn = await page1.getByRole("button", { name: /download installer/i }).first().isVisible().catch(() => false);
  console.log("3. installer download button appeared:", downloadBtn);
} catch (err) {
  console.log("3. FAILED:", err.message);
}

await page1.close();

// ---- Part 2: platform admin acting on the test org by name ----
const page2 = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await login(page2, "legacy", "_swtest70", "TempPass9x2Kq");
await page2.getByRole("link", { name: /ai console/i }).first().click();
await page2.waitForTimeout(800);

try {
  await sendChat(page2, "suspend the organization AI Cmd Test Org");
  await page2.waitForTimeout(500);
  const confirmVisible = await page2.getByRole("heading", { name: /confirm this action/i }).isVisible().catch(() => false);
  console.log("4. suspend confirmation dialog appeared:", confirmVisible);
  if (confirmVisible) {
    await page2.getByRole("button", { name: /^confirm$/i }).click();
    await page2.waitForTimeout(1500);
  }
} catch (err) {
  console.log("4. FAILED:", err.message);
}

const suspendCheck = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "ai-cmd-test-org" },
  body: JSON.stringify({ username: "aicmdadmin", password: "TempPass9x2Kq" }),
});
console.log("5. login to suspended org via AI command (should be 401):", suspendCheck.status);

try {
  await sendChat(page2, "reactivate the organization AI Cmd Test Org");
  await page2.waitForTimeout(500);
  const confirmVisible = await page2.getByRole("heading", { name: /confirm this action/i }).isVisible().catch(() => false);
  if (confirmVisible) {
    await page2.getByRole("button", { name: /^confirm$/i }).click();
    await page2.waitForTimeout(1500);
  }
} catch (err) {
  console.log("6. FAILED:", err.message);
}
const reactivateCheck = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-subdomain": "ai-cmd-test-org" },
  body: JSON.stringify({ username: "aicmdadmin", password: "TempPass9x2Kq" }),
});
console.log("6. login after AI-command reactivate (should be 200):", reactivateCheck.status);

try {
  await sendChat(page2, "permanently delete the organization AI Cmd Test Org");
  await page2.waitForTimeout(500);
  const deleteHeading = await page2.getByRole("heading", { name: /^delete "ai cmd test org"$/i }).isVisible().catch(() => false);
  console.log("7. delete type-to-confirm dialog appeared:", deleteHeading);
  if (deleteHeading) {
    const deleteBtn = page2.getByRole("button", { name: /delete permanently/i });
    const disabledBefore = await deleteBtn.isDisabled();
    console.log("7b. delete button disabled before typing name:", disabledBefore);
    await page2.locator('input').last().fill("AI Cmd Test Org");
    await deleteBtn.click();
    await page2.waitForTimeout(1500);
  }
} catch (err) {
  console.log("7. FAILED:", err.message);
}

await page2.close();
await browser.close();
console.log("done");
