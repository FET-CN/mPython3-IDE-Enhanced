// e2e/agent-edit.e2e.mjs — End-to-end validation of the FULL agent loop on the
// real online.mpython.cn: a scripted fake LLM (installed as a window.fetch shim)
// drives read_workspace → edit_blocks → final reply via streamed tool_calls; we
// click the confirm card, then assert the real Blockly workspace gained the
// expected blocks. Data + bundle are served from dist/ via route interception.
//   bun run build:bookmarklet  then  bun e2e/agent-edit.e2e.mjs

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

// One SSE "data:" event from an OpenAI-style chunk.
const evt = (o) => `data: ${JSON.stringify(o)}\n\n`;
const toolCallChunk = (id, name, args) =>
  evt({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  evt({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
const textChunk = (text) =>
  evt({ choices: [{ delta: { content: text } }] }) +
  evt({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";

const OPS = [
  { op: "clear" },
  { op: "insert", anchor: { at: "new" }, blocks: [{ type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "m3e-loop" } } } }] },
];
// Scripted LLM turns, in order.
const SCRIPT = [
  toolCallChunk("rc1", "read_workspace", {}),
  toolCallChunk("ec1", "edit_blocks", { ops: OPS }),
  textChunk("已为你清空并添加一句“打印 m3e-loop”。"),
];

const main = async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));

  // Serve dist/* for BASE/* (catalog, knowledge, seeds).
  await page.route(`${BASE}/**`, (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, "");
    const f = resolve(DIST, p);
    if (existsSync(f)) route.fulfill({ status: 200, contentType: mime(p), headers: { "Access-Control-Allow-Origin": "*" }, body: readFileSync(f) });
    else route.fulfill({ status: 404, body: "nf" });
  });

  // Before any page script: seed config + install the fake-LLM fetch shim.
  await page.addInitScript((script) => {
    localStorage.setItem("m3e_apiKey", "test-key");
    localStorage.setItem("m3e_baseURL", "https://llm.local/v1");
    localStorage.setItem("m3e_model", "fake");
    const orig = window.fetch.bind(window);
    window.__m3eTurn = 0;
    window.fetch = (url, opts) => {
      if (String(url).includes("/chat/completions")) {
        const body = script[window.__m3eTurn++] || "data: [DONE]\n\n";
        return Promise.resolve(new Response(new Blob([body]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      }
      return orig(url, opts);
    };
  }, SCRIPT);

  let result = {};
  try {
    await page.goto(SITE, { waitUntil: "commit", timeout: 90000 });
    await page.waitForFunction(() => !!(window.vm && window.vm.$store), null, { timeout: 90000 });
    await page.waitForTimeout(4000);
    await page.evaluate((b) => { window.__M3E_BASE__ = b; }, BASE);
    await page.addScriptTag({ content: bundle });
    await page.waitForSelector("#m3e-panel-host", { timeout: 15000, state: "attached" });
    await page.waitForTimeout(5000); // data load

    // Type a request and send (Enter).
    await page.evaluate(() => {
      const root = document.getElementById("m3e-panel-host").shadowRoot;
      const ta = root.querySelector("[data-input]");
      ta.value = "清空工作区，加一句打印 m3e-loop";
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // The edit_blocks confirm card should appear → click "允许一次".
    await page.waitForFunction(() => {
      const root = document.getElementById("m3e-panel-host")?.shadowRoot;
      return !!root?.querySelector('[data-c="once"]');
    }, null, { timeout: 15000 });
    await page.evaluate(() => {
      document.getElementById("m3e-panel-host").shadowRoot.querySelector('[data-c="once"]').click();
    });
    await page.waitForTimeout(3000);

    result = await page.evaluate(() => {
      const store = window.vm.$store;
      const ws = store.state.workspace;
      const blocks = ws && ws.getAllBlocks ? ws.getAllBlocks(false) : [];
      const root = document.getElementById("m3e-panel-host").shadowRoot;
      return {
        types: blocks.map((b) => b.type),
        count: blocks.length,
        feed: (root.querySelector("[data-feed]")?.textContent || "").replace(/\s+/g, " ").slice(0, 300),
        turns: window.__m3eTurn,
      };
    });
    await page.screenshot({ path: resolve(ROOT, "e2e/out/agent-edit.png") });

    const hasPrint = result.types.includes("text_print");
    const ok = hasPrint && result.turns >= 3 && errors.filter((e) => !/Blockly|Canvas2D|Phaser|HUE/.test(e)).length === 0;
    console.log("RESULT:", JSON.stringify(result, null, 2));
    console.log("ERRORS:", errors.filter((e) => !/Blockly|Canvas2D|Phaser|HUE/.test(e)));
    console.log(ok ? "[agent-edit] PASS — 真实工作区已通过 agent 循环注入积木" : "[agent-edit] FAIL");
    await browser.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error("[agent-edit] ERROR:", e.message);
    console.log("ERRORS:", errors.slice(-15));
    await browser.close().catch(() => {});
    process.exit(1);
  }
};
main();
