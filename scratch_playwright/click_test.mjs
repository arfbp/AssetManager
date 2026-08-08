import { chromium } from "playwright";

// Safety note: this deliberately does NOT click the real "Force close"
// button against a real top-process row — that PID belongs to an actual
// running process on this machine (chrome.exe / Code.exe / powershell.exe /
// node.exe / claude.exe are all in the current top_processes list) and
// clicking it would really kill it. Instead this calls the exact same
// endpoint, through the exact same browser fetch/CORS code path, with a
// PID that cannot correspond to a real process — that's sufficient to
// prove the CORS fix works without any real-world side effect. The UI
// button wires to the identical fetch call in src/lib/api.ts, so this
// exercises the code that was actually broken.
const FAKE_PID = 999999999;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
const failedRequests = [];
const responses = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on("requestfailed", (req) => failedRequests.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText}`));
page.on("response", (res) => {
  if (res.url().includes("favicon") || res.url().includes("icon")) {
    responses.push(`${res.status()} ${res.url()}`);
  }
});

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector("text=DESKTOP-P8G7C64", { timeout: 15000 });
console.log("dashboard loaded, favicon/icon responses:", JSON.stringify(responses, null, 2));

console.log("--- calling kill-process via in-page fetch (same code path as the UI button, fake PID for safety) ---");
const result = await page.evaluate(async (pid) => {
  const res = await fetch("http://localhost:8080/api/agents/DESKTOP-P8G7C64/kill-process", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-dashboard-token" },
    body: JSON.stringify({ pid, requestedBy: "playwright-cors-test" }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}, FAKE_PID);

console.log("in-page fetch result:", JSON.stringify(result));
console.log("console errors:", JSON.stringify(consoleErrors, null, 2));
console.log("failed requests (browser-level, e.g. CORS blocks):", JSON.stringify(failedRequests, null, 2));

// The bug reported was: browser blocks with net::ERR_FAILED before the
// request even reaches the server (no Access-Control-Allow-Origin). If CORS
// is fixed, the fetch completes and we get a real HTTP response (200 —
// dispatched; the agent will separately report back that the PID doesn't
// exist, which is fine and expected).
const corsFixed = failedRequests.length === 0 && result.status === 200;
console.log(corsFixed ? "PASS: CORS fixed, request reached the server" : "FAIL: request still blocked");

await browser.close();
process.exit(corsFixed ? 0 : 1);
