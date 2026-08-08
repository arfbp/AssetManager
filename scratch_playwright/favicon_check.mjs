import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

const allResponses = [];
page.on("response", (res) => allResponses.push(`${res.status()} ${res.url()}`));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

const iconLinks = await page.evaluate(() =>
  Array.from(document.querySelectorAll('link[rel*="icon"]')).map((l) => l.outerHTML),
);
console.log("icon <link> tags in <head>:", JSON.stringify(iconLinks, null, 2));

// Explicitly request /favicon.ico the way a browser does as a fallback probe.
const favRes = await page.request.get("http://localhost:3000/favicon.ico");
console.log("direct GET /favicon.ico ->", favRes.status());

const iconRelated = allResponses.filter((r) => /icon|favicon/i.test(r));
console.log("icon-related responses seen during load:", JSON.stringify(iconRelated, null, 2));

await browser.close();
