import assert from "node:assert/strict";
import { chromium } from "playwright";

// Bootstrap proof only. Product/browser/client acceptance is a separate release gate.
const browser = await chromium.launch({ headless: true, timeout: 30_000 });
try {
  const page = await browser.newPage();
  await page.setContent("<title>FortiPi browser bootstrap</title>");
  assert.equal(await page.title(), "FortiPi browser bootstrap");
  console.log(
    JSON.stringify({
      browserBootstrap: "ok",
      headless: true,
      node: process.versions.node,
      platform: process.platform,
    }),
  );
} finally {
  await browser.close();
}
