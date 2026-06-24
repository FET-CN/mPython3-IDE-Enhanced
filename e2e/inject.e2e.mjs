// e2e/inject.e2e.mjs — Repeatable T2 gate: drive the real online.mpython.cn,
// inject an IR program compiled by OUR compiler via loadXMLCode, and assert the
// real Blockly workspace rendered the expected blocks with no unknown-block
// errors. Exits non-zero on failure. Run: bun e2e/inject.e2e.mjs
//
// Authorized headless visit; read-only; no account required.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/xml/compile.mjs";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const URL = process.env.M3E_URL || "https://online.mpython.cn/";

// event(button A) → repeat 3 → OLED DispChar "hi"  (real mPython block types)
const PROGRAM = [[
  {
    type: "mpython_Interrupt_AB",
    fields: { button: "button_a", action: "down" },
    statements: {
      DO: [
        {
          type: "controls_repeat_ext",
          inputs: { TIMES: { type: "math_number", fields: { NUM: "3" } } },
          statements: {
            DO: [
              {
                type: "mpython_display_DispChar",
                inputs: {
                  x: { type: "math_number", fields: { NUM: "0" } },
                  y: { type: "math_number", fields: { NUM: "0" } },
                  message: { type: "text", fields: { TEXT: "hi" } },
                },
              },
            ],
          },
        },
      ],
    },
  },
]];
const EXPECTED = [
  "mpython_Interrupt_AB", "controls_repeat_ext", "math_number",
  "mpython_display_DispChar", "text",
];
const XML = compile(PROGRAM);

const assert = (cond, msg) => { if (!cond) { throw new Error("ASSERT FAILED: " + msg); } };

const main = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));

  let result = {};
  try {
    await page.goto(URL, { waitUntil: "commit", timeout: 90000 });
    await page.waitForFunction(() => !!(window.vm && window.vm.$store), null, { timeout: 90000 });
    await page.waitForTimeout(5000);

    // host surface
    const surface = await page.evaluate(() => {
      const m = window.vm.$store._mutations || {};
      return {
        hasLoadXMLCode: !!m.loadXMLCode,
        hasBlockly: typeof window.Blockly !== "undefined",
        hasWorkspace: !!(window.vm.$store.state && window.vm.$store.state.workspace),
      };
    });
    assert(surface.hasLoadXMLCode, "loadXMLCode mutation present");
    assert(surface.hasWorkspace, "store.state.workspace present");

    // inject our compiled XML
    result = await page.evaluate((xml) => {
      const store = window.vm.$store;
      store.commit("loadXMLCode", { title: "m3e-e2e", xmlCode: xml, notClear: false });
      const ws = store.state.workspace;
      const blocks = ws.getAllBlocks(false);
      const types = blocks.map((b) => b.type);
      // detect Blockly "unknown/insertion marker" or undefined-def blocks
      const unknown = blocks.filter((b) => !b.type || b.type === "unknown").map((b) => b.type);
      return { count: blocks.length, types, unknown, xmlBack: (store.state.xmlCode || "").slice(0, 200) };
    }, XML);

    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(OUT, "e2e-injected.png") });

    for (const t of EXPECTED) {
      assert(result.types.includes(t), `expected block "${t}" present (got ${result.types.join(",")})`);
    }
    assert(result.unknown.length === 0, `no unknown blocks (got ${result.unknown.join(",")})`);
    assert(result.count >= EXPECTED.length, `block count ${result.count} >= ${EXPECTED.length}`);

    console.log("[e2e] PASS — injected", result.count, "blocks:", [...new Set(result.types)].join(", "));
    writeFileSync(resolve(OUT, "inject-e2e.json"), JSON.stringify({ ok: true, surface, result, errors }, null, 2));
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error("[e2e] FAIL —", e.message);
    writeFileSync(resolve(OUT, "inject-e2e.json"), JSON.stringify({ ok: false, error: e.message, result, errors }, null, 2));
    await browser.close().catch(() => {});
    process.exit(1);
  }
};

main();
