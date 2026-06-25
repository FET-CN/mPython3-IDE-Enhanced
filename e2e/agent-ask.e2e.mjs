// e2e/agent-ask.e2e.mjs — Prove the structured clarify flow (ask_user) end-to-end
// on the real online.mpython.cn: a scripted fake LLM calls ask_user; the panel
// renders clickable options and BLOCKS; we click one; the choice feeds back as the
// tool_result and the loop resumes to a final reply that echoes the chosen label.
//   bun run build:bookmarklet  then  bun e2e/agent-ask.e2e.mjs

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

const evt = (o) => `data: ${JSON.stringify(o)}\n\n`;
const toolCallChunk = (id, name, args) =>
  evt({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  evt({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
const textChunk = (text) =>
  evt({ choices: [{ delta: { content: text } }] }) +
  evt({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";

const SCRIPT = [
  toolCallChunk("ask1", "ask_user", {
    question: "目标板型按哪个处理？",
    options: [{ label: "掌控板V3", description: "新版" }, { label: "掌控板V2", description: "旧版" }],
  }),
  textChunk("好的，按掌控板V3 处理。"),
];

const main = async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));

  await page.route(`${BASE}/**`, (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, "");
    const f = resolve(DIST, p);
    if (existsSync(f)) route.fulfill({ status: 200, contentType: mime(p), headers: { "Access-Control-Allow-Origin": "*" }, body: readFileSync(f) });
    else route.fulfill({ status: 404, body: "nf" });
  });

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
    await page.waitForTimeout(5000);

    await page.evaluate(() => {
      const root = document.getElementById("m3e-panel-host").shadowRoot;
      const ta = root.querySelector("[data-input]");
      ta.value = "帮我写个按键显示温度的程序";
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // The ask_user option card should appear and BLOCK the loop at turn 1.
    await page.waitForFunction(() => {
      const root = document.getElementById("m3e-panel-host")?.shadowRoot;
      return !!root?.querySelector('[data-o="0"]');
    }, null, { timeout: 15000 });
    const turnsAtBlock = await page.evaluate(() => window.__m3eTurn);

    // Click the first option ("掌控板V3").
    await page.evaluate(() => {
      document.getElementById("m3e-panel-host").shadowRoot.querySelector('[data-o="0"]').click();
    });
    await page.waitForTimeout(2500);

    result = await page.evaluate(() => {
      const root = document.getElementById("m3e-panel-host").shadowRoot;
      return {
        feed: (root.querySelector("[data-feed]")?.textContent || "").replace(/\s+/g, " ").slice(0, 400),
        turns: window.__m3eTurn,
      };
    });
    await page.screenshot({ path: resolve(ROOT, "e2e/out/agent-ask.png") });

    const blocked = turnsAtBlock === 1;                       // paused before the 2nd model call
    const resumed = result.turns >= 2;                        // resumed after the click
    const echoed = /掌控板V3/.test(result.feed);              // final reply reflects the choice
    const clean = errors.filter((e) => !/Blockly|Canvas2D|Phaser|HUE/.test(e)).length === 0;
    const ok = blocked && resumed && echoed && clean;
    console.log("RESULT:", JSON.stringify({ ...result, turnsAtBlock }, null, 2));
    console.log("ERRORS:", errors.filter((e) => !/Blockly|Canvas2D|Phaser|HUE/.test(e)));
    console.log(ok ? "[agent-ask] PASS — ask_user 阻塞等待并把用户选择回灌给 agent" : "[agent-ask] FAIL");
    await browser.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error("[agent-ask] ERROR:", e.message);
    console.log("ERRORS:", errors.slice(-15));
    await browser.close().catch(() => {});
    process.exit(1);
  }
};
main();
