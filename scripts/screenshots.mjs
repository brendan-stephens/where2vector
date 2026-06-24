// Capture dashboard screenshots for the README using the cached Playwright chromium.
//   node scripts/screenshots.mjs   (dev server must be running on :3000)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const EXE =
  process.env.CHROMIUM_BIN ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1160, height: 1000 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(120_000); // the exact TOASTed leg is intentionally slow (~10s/query)

async function setNumber(idx, val) {
  await page.evaluate(
    ({ idx, val }) => {
      const el = document.querySelectorAll('input[type="number"]')[idx];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, String(val));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { idx, val }
  );
}
async function setCheck(idx, on) {
  const el = page.locator('input[type="checkbox"]').nth(idx);
  if ((await el.isChecked()) !== on) await el.click();
}
async function runAndWait() {
  await page.click("button.run");
  await page.waitForFunction(
    () => !document.querySelector("button.run")?.disabled && document.querySelectorAll(".bar-val").length > 0
  );
  await page.waitForTimeout(400);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("table.stats", { timeout: 30_000 });

// 1) Exact KNN — the disk-latency story
await setNumber(0, 2); // queries
await setNumber(2, 1); // concurrency
await setCheck(0, false); // HNSW off
await setCheck(1, false); // prewarm off
await runAndWait();
await page.screenshot({ path: `${OUT}/dashboard-exact.png`, fullPage: true });
console.log("saved dashboard-exact.png");

// 2) HNSW (ANN) — the index story (fast, ~0 TOAST reads)
await setCheck(0, true); // HNSW on
await runAndWait();
await page.screenshot({ path: `${OUT}/dashboard-hnsw.png`, fullPage: true });
console.log("saved dashboard-hnsw.png");

await browser.close();
console.log("done");
