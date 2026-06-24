// e2e/probe.mjs — Exploratory probe of the live online.mpython.cn host surface.
// Confirms the reverse-engineered assumptions (window.vm.$store, loadXMLCode
// mutation, state keys, localStorage, XML format) and tests a real injection.
// Run: bun e2e/probe.mjs   (authorized headless visit, read-only, no account)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/xml/compile.mjs";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const URL = process.env.M3E_URL || "https://online.mpython.cn/";

// A tiny program built by OUR compiler — to verify the app accepts our XML.
const TEST_XML = compile([[
  { type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "m3e-probe" } } } },
]]);

const log = (...a) => console.log("[probe]", ...a);

const main = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleMsgs = [];
  page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => consoleMsgs.push(`pageerror: ${e.message}`.slice(0, 300)));

  const report = { url: URL, ok: false, steps: {} };
  try {
    log("loading", URL);
    await page.goto(URL, { waitUntil: "commit", timeout: 90000 });
    log("navigated, waiting for window.vm…");
    // Wait for the Vue app instance to appear.
    await page.waitForFunction(() => !!window.vm, null, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(5000); // let blockly/toolbox settle

    // ---- 1. Host surface ----
    report.steps.surface = await page.evaluate(() => {
      const out = {};
      out.hasVm = typeof window.vm !== "undefined";
      out.hasStore = !!(window.vm && window.vm.$store);
      const store = window.vm && window.vm.$store;
      if (store) {
        out.stateKeys = Object.keys(store.state || {});
        out.mutationNames = Object.keys(store._mutations || {});
        out.hasLoadXMLCode = !!(store._mutations && store._mutations.loadXMLCode);
        out.hasChangeXmlCode = !!(store._mutations && store._mutations.changeXmlCode);
        out.hasSetTeachPyCode = !!(store._mutations && store._mutations.setTeachPyCode);
        const ws = store.state && store.state.workspace;
        out.workspaceType = ws ? (ws.constructor && ws.constructor.name) : null;
        out.workspaceHasGetAllBlocks = !!(ws && typeof ws.getAllBlocks === "function");
        out.modeSate = store.state && store.state.modeSate;
        out.xmlCodeSample = (store.state && typeof store.state.xmlCode === "string")
          ? store.state.xmlCode.slice(0, 400) : null;
      }
      out.hasBlocklyGlobal = typeof window.Blockly !== "undefined";
      out.localStorageKeys = Object.keys(localStorage);
      out.mPyXmlSample = (localStorage.mPyXml || "").slice(0, 400);
      out.pyCodeSample = (localStorage.pyCode || "").slice(0, 200);
      out.toolbarSelectors = {
        editorTool: !!document.querySelector(".editor-tool"),
        codeArea: !!document.querySelector(".codeArea"),
        areaCode: !!document.querySelector(".area-code"),
      };
      return out;
    });
    log("surface:", JSON.stringify(report.steps.surface, null, 2));

    await page.screenshot({ path: resolve(OUT, "01-loaded.png"), fullPage: false });

    // ---- 2. Injection test via loadXMLCode ----
    report.steps.inject = await page.evaluate((xml) => {
      try {
        const store = window.vm.$store;
        const before = (store.state.xmlCode || "").length;
        store.commit("loadXMLCode", { title: "m3e-probe", xmlCode: xml, notClear: false });
        return { committed: true, beforeLen: before };
      } catch (e) {
        return { committed: false, error: String(e && e.message || e) };
      }
    }, TEST_XML);
    await page.waitForTimeout(1500);

    // ---- 3. Read back ----
    report.steps.readback = await page.evaluate(() => {
      const store = window.vm.$store;
      return {
        xmlCodeLen: (store.state.xmlCode || "").length,
        xmlCodeHasPrint: (store.state.xmlCode || "").includes("text_print"),
        xmlCodeSample: (store.state.xmlCode || "").slice(0, 600),
        pyCode: (localStorage.pyCode || "").slice(0, 300),
        blockCount: store.state.workspace && store.state.workspace.getAllBlocks
          ? store.state.workspace.getAllBlocks(false).length : null,
      };
    });
    log("readback:", JSON.stringify(report.steps.readback, null, 2));
    await page.screenshot({ path: resolve(OUT, "02-injected.png"), fullPage: false });

    report.ok = !!(report.steps.surface.hasStore && report.steps.inject.committed);
  } catch (e) {
    report.error = String(e && e.stack || e);
    log("ERROR", report.error);
  } finally {
    report.console = consoleMsgs.slice(-40);
    report.testXml = TEST_XML;
    writeFileSync(resolve(OUT, "host-probe.json"), JSON.stringify(report, null, 2));
    await browser.close();
  }
  log("done. ok =", report.ok, "→ e2e/out/host-probe.json");
};

main();
