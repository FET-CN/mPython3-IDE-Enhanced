// e2e/runtime.e2e.mjs — Reproduce the real user scenario: load online.mpython.cn,
// run the bundled main.min.js with __M3E_BASE__ pointed at the local CORS server,
// and report exactly what happens (panel mount? data load? console errors?).
// Requires `bunx serve dist --cors -l 8080` running. Run: bun e2e/runtime.e2e.mjs

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.M3E_BASE || "http://localhost:8080";
const URL = process.env.M3E_URL || "https://online.mpython.cn/";
const bundle = readFileSync(resolve(ROOT, "dist/main.min.js"), "utf8");

const main = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--allow-running-insecure-content",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const msgs = [];
  page.on("console", (m) => msgs.push(`${m.type()}: ${m.text()}`.slice(0, 240)));
  page.on("pageerror", (e) => msgs.push("pageerror: " + e.message.slice(0, 240)));
  page.on("requestfailed", (r) => msgs.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));

  try {
    await page.goto(URL, { waitUntil: "commit", timeout: 90000 });
    await page.waitForFunction(() => !!(window.vm && window.vm.$store), null, { timeout: 90000 });
    await page.waitForTimeout(3000);

    // set base + run the bundle directly (avoids mixed-content on the <script> tag)
    await page.evaluate((b) => { window.__M3E_BASE__ = b; }, BASE);
    await page.addScriptTag({ content: bundle });

    // wait up to 15s for the panel to mount and report
    await page.waitForSelector("#m3e-panel-host", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(6000);

    const state = await page.evaluate(() => {
      const host = document.getElementById("m3e-panel-host");
      if (!host) return { mounted: false };
      const root = host.shadowRoot;
      return {
        mounted: true,
        logText: root?.querySelector("[data-log]")?.textContent || "",
        hasPanel: !!root?.querySelector(".wrap"),
      };
    });

    console.log("=== panel state ===");
    console.log(JSON.stringify(state, null, 2));
    console.log("\n=== console / network (last 30) ===");
    console.log(msgs.slice(-30).join("\n"));
    await page.screenshot({ path: resolve(ROOT, "e2e/out/runtime.png") });
  } catch (e) {
    console.error("ERROR:", e.message);
    console.log("\n=== console (last 30) ===\n" + msgs.slice(-30).join("\n"));
  } finally {
    await browser.close();
  }
};
main();
