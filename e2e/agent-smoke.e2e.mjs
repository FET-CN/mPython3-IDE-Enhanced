// e2e/agent-smoke.e2e.mjs — Boot the rewritten chat assistant against the real
// online.mpython.cn and verify: panel mounts, data loads, no console errors, and
// the chat UI structure is present. Data + bundle are served via route
// interception from dist/ (no separate static server needed).
//   bun run build:bookmarklet  then  bun e2e/agent-smoke.e2e.mjs

import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");
const SITE = process.env.M3E_URL || "https://online.mpython.cn/";
const BASE = "https://m3e.local";
const bundle = readFileSync(resolve(DIST, "main.min.js"), "utf8");

const mime = (p) => (p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : p.endsWith(".md") ? "text/markdown" : "text/plain");

const main = async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));

  // Serve dist/<path> for any request to BASE/*
  await page.route(`${BASE}/**`, (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, "");
    const f = resolve(DIST, p);
    if (existsSync(f)) route.fulfill({ status: 200, contentType: mime(p), headers: { "Access-Control-Allow-Origin": "*" }, body: readFileSync(f) });
    else route.fulfill({ status: 404, body: "nf" });
  });

  let report = {};
  try {
    await page.goto(SITE, { waitUntil: "commit", timeout: 90000 });
    await page.waitForFunction(() => !!(window.vm && window.vm.$store), null, { timeout: 90000 });
    await page.waitForTimeout(4000);

    await page.evaluate((b) => { window.__M3E_BASE__ = b; }, BASE);
    await page.addScriptTag({ content: bundle });
    await page.waitForSelector("#m3e-panel-host", { timeout: 15000, state: "attached" });
    // let data load + the "已就绪" notice render
    await page.waitForTimeout(6000);

    report = await page.evaluate(() => {
      const host = document.getElementById("m3e-panel-host");
      const root = host?.shadowRoot;
      const feedText = root?.querySelector("[data-feed]")?.textContent || "";
      return {
        mounted: !!host,
        hasWrap: !!root?.querySelector("[data-wrap]"),
        hasInput: !!root?.querySelector("[data-input]"),
        hasStyle: (root?.querySelector("style")?.textContent || "").length,
        boardText: root?.querySelector("[data-board]")?.textContent || "",
        ready: /已就绪/.test(feedText),
        feedSample: feedText.replace(/\s+/g, " ").slice(0, 200),
      };
    });

    await page.screenshot({ path: resolve(DIST, "..", "e2e/out/agent-smoke.png") });
    const ok = report.mounted && report.hasWrap && report.hasInput && report.hasStyle > 1000 && errors.filter((e) => !/Blockly|Canvas2D|Phaser|HUE/.test(e)).length === 0;
    console.log("REPORT:", JSON.stringify(report, null, 2));
    console.log("CONSOLE ERRORS (filtered):", errors.filter((e) => !/Blockly|Canvas2D|Phaser|HUE/.test(e)));
    console.log(ok ? "[smoke] PASS" : "[smoke] CHECK");
    await browser.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error("[smoke] ERROR:", e.message);
    console.log("CONSOLE:", errors.slice(-20));
    await browser.close().catch(() => {});
    process.exit(1);
  }
};
main();
