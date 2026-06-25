// tools/dump-toolbox.mjs — Refresh data/toolbox.visible.json from the LIVE site.
//
// The "side palette" (default toolbox) is built dynamically in the IDE's JS per
// `masterControl`, so it cannot be recovered from the static vendor bundle. This
// script drives a headless browser against online.mpython.cn, switches the board
// to each supported master, reads the real rendered toolbox def
// (`ws.options.languageTree`) plus the dynamic VARIABLE/PROCEDURE flyouts, and
// writes the per-board set of visible block types.
//
// NETWORK REQUIRED. Not part of `bun run build`. Run manually to refresh the
// snapshot when the site updates:  `bun run dump:toolbox`
//
// Output: data/toolbox.visible.json  (committed; a time-stamped snapshot — the
// default toolbox drifts with site versions, so it carries source + capturedAt).
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./lib/paths.mjs";

const URL = process.env.M3E_SITE_URL || "https://online.mpython.cn/";
const BOARDS = ["mPython", "mPython_V3"];
const OUT = resolve(DATA_DIR, "toolbox.visible.json");
const log = (...a) => console.log("[dump-toolbox]", ...a);

// Runs in the page: read the real toolbox def + open custom flyouts.
function extract() {
  const r = { staticTypes: [], dynamicTypes: [], categories: [], errors: [] };
  try {
    const sws = window.vm && window.vm.$store && window.vm.$store.state.workspace;
    const ws = (window.Blockly && window.Blockly.getMainWorkspace && window.Blockly.getMainWorkspace()) || sws;
    const lt = ws && ws.options && ws.options.languageTree;
    const stat = new Set();
    if (lt) {
      lt.querySelectorAll("block, shadow").forEach((n) => {
        const t = n.getAttribute("type");
        if (t) stat.add(t);
      });
      [...lt.querySelectorAll("category")].forEach((c) => {
        const types = [...c.querySelectorAll("block, shadow")].map((b) => b.getAttribute("type")).filter(Boolean);
        r.categories.push({ name: c.getAttribute("name"), custom: c.getAttribute("custom") || null, types: [...new Set(types)] });
      });
    } else r.errors.push("no languageTree");
    r.staticTypes = [...stat];

    // dynamic custom categories (VARIABLE / PROCEDURE) render via flyout
    const dyn = new Set();
    try {
      if (ws.createVariable) { try { ws.createVariable("item"); } catch (e) {} }
      const tb = ws.getToolbox && ws.getToolbox();
      const tree = tb && tb.tree_;
      const readFlyout = () => {
        const fl = tb.getFlyout && tb.getFlyout();
        const fws = fl && fl.getWorkspace && fl.getWorkspace();
        return fws && fws.getTopBlocks ? fws.getTopBlocks(false).map((b) => b.type).filter(Boolean) : [];
      };
      if (tree && tree.children_) {
        for (const node of tree.children_) {
          try {
            if (tree.setSelectedItem) tree.setSelectedItem(node);
            readFlyout().forEach((t) => dyn.add(t));
          } catch (e) { r.errors.push("flyout:" + String(e).slice(0, 80)); }
        }
      }
    } catch (e) { r.errors.push("dyn:" + String(e).slice(0, 120)); }
    r.dynamicTypes = [...dyn];
  } catch (e) { r.errors.push(String((e && e.stack) || e).slice(0, 300)); }
  return r;
}

async function dumpBoard(browser, board) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  try {
    await page.goto(URL, { waitUntil: "commit", timeout: 90000 });
    await page.evaluate((b) => { localStorage.setItem("masterControl", b); localStorage.setItem("modeSate", "0"); }, board);
    await page.reload({ waitUntil: "commit", timeout: 90000 });
    await page.waitForFunction(() => !!window.vm, null, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(8000);
    const data = await page.evaluate(extract);
    return { board, types: [...new Set([...(data.staticTypes || []), ...(data.dynamicTypes || [])])], errors: data.errors };
  } finally {
    await page.close();
  }
}

async function main() {
  // validate scraped types against the committed catalog → drop anything unknown
  const catalog = new Set(JSON.parse(readFileSync(resolve(DATA_DIR, "catalog.index.json"), "utf8")).map((b) => b.type));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const byBoard = {};
  let dropped = 0;
  try {
    for (const b of BOARDS) {
      const rec = await dumpBoard(browser, b);
      const known = rec.types.filter((t) => catalog.has(t));
      dropped += rec.types.length - known.length;
      byBoard[b] = [...new Set(known)].sort();
      log(b, "visible", byBoard[b].length, "(dropped non-catalog:", rec.types.length - known.length + ")", "errors", (rec.errors || []).length);
    }
  } finally {
    await browser.close();
  }
  const out = {
    _comment: "侧边积木栏(默认工具箱)里实际可见的 block type，按板分。由 `bun run dump:toolbox` 联网刷新。带时效性，见 source/capturedAt。",
    source: `${URL} (headless chromium, no account)`,
    capturedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(byBoard).map(([k, v]) => [k, v.length])),
    byBoard,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 0));
  log("wrote", OUT, "| dropped non-catalog types:", dropped);
}

main();
