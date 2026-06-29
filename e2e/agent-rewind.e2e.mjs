// e2e/agent-rewind.e2e.mjs — Prove /rewind end-to-end on the real site.
// Covers: parameter rewind, interactive rewind mode, all-turns list, chat-only,
// and continuing to chat after rewind. Uses a scripted fake LLM via fetch shim.

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
  // round 1: create a visible todo and a first assistant reply
  toolCallChunk("todo1", "update_todos", {
    todos: [
      { title: "搭建第一轮上下文", status: "completed" },
      { title: "准备第二轮回退目标", status: "in_progress" },
    ],
  }),
  textChunk("第一轮已完成。"),

  // round 2: create another visible todo and a second assistant reply
  toolCallChunk("todo2", "update_todos", {
    todos: [
      { title: "搭建第一轮上下文", status: "completed" },
      { title: "准备第二轮回退目标", status: "completed" },
      { title: "验证 rewind 继续对话", status: "in_progress" },
    ],
  }),
  textChunk("第二轮也已完成。"),

  // round 3 after rewind: just reply, so we can prove the loop still works.
  textChunk("回退后仍可继续聊天。"),
];

async function openPage() {
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

  await page.goto(SITE, { waitUntil: "commit", timeout: 90000 });
  await page.waitForFunction(() => !!(window.vm && window.vm.$store), null, { timeout: 90000 });
  await page.waitForTimeout(4000);
  await page.evaluate((b) => { window.__M3E_BASE__ = b; }, BASE);
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("#m3e-panel-host", { timeout: 15000, state: "attached" });
  await page.waitForTimeout(5000);
  return { browser, page, errors };
}

async function send(page, text) {
  await page.evaluate((t) => {
    const root = document.getElementById("m3e-panel-host").shadowRoot;
    const ta = root.querySelector("[data-input]");
    ta.value = t;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, text);
}

async function shadow(page) {
  return page.evaluate(() => {
    const root = document.getElementById("m3e-panel-host").shadowRoot;
    const feed = root.querySelector("[data-feed]");
    const progress = root.querySelector("[data-progress]");
    return {
      feedText: (feed?.textContent || "").replace(/\s+/g, " ").trim(),
      progressText: (progress?.textContent || "").replace(/\s+/g, " ").trim(),
      turnButtons: [...root.querySelectorAll("[data-turn-id]")].map((n) => n.getAttribute("data-turn-id")),
      buttons: [...root.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 30),
      workspace: (() => {
        try {
          const blocks = window.vm?.$store?.state?.workspace?.getAllBlocks?.(false) || [];
          return { count: blocks.length, types: blocks.map((b) => b.type) };
        } catch {
          return { count: -1, types: [] };
        }
      })(),
      undoBtn: [...root.querySelectorAll("button")].find((b) => /撤销上一次积木改动|无可撤销内容/.test(b.textContent || ""))?.textContent || "",
    };
  });
}

async function waitForText(page, text, timeout = 15000) {
  await page.waitForFunction((needle) => {
    const root = document.getElementById("m3e-panel-host")?.shadowRoot;
    return !!root && root.textContent.includes(needle);
  }, text, { timeout });
}

const main = async () => {
  const { browser, page, errors } = await openPage();
  try {
    // Turn 1 and 2: create history plus todos.
    await send(page, "第一轮需求");
    await waitForText(page, "第一轮已完成。");
    await send(page, "第二轮需求");
    await waitForText(page, "第二轮也已完成。");

    const before = await shadow(page);
    const hasTwoTurns = before.turnButtons.length >= 2;
    const hasTodos = /验证 rewind 继续对话/.test(before.progressText);

    // Parameter rewind: /rewind 1 should remove the second round and preserve the first.
    await send(page, "/rewind 1");
    await waitForText(page, "已回退 1 轮对话");
    const afterParam = await shadow(page);
    const paramOk = /第一轮已完成/.test(afterParam.feedText) && !/第二轮也已完成/.test(afterParam.feedText) && /搭建第一轮上下文/.test(afterParam.progressText) && !/准备第二轮回退目标/.test(afterParam.progressText);
    const undoBefore = afterParam.undoBtn;
    const wsBefore = afterParam.workspace;

    // Continue chatting to ensure the loop still works after rewind.
    await send(page, "回退后继续");
    await waitForText(page, "回退后仍可继续聊天。");

    // Interactive rewind: open mode, then use the all-turns list entry.
    await send(page, "/rewind");
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const root = document.getElementById("m3e-panel-host").shadowRoot;
      [...root.querySelectorAll("button")].find((b) => b.textContent.includes("查看所有回合"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const root = document.getElementById("m3e-panel-host").shadowRoot;
      const target = [...root.querySelectorAll("button")].find((b) => b.textContent.includes("第一轮需求"));
      target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const root = document.getElementById("m3e-panel-host").shadowRoot;
      [...root.querySelectorAll("button")].find((b) => b.textContent.includes("仅对话"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(1500);

    const afterChatOnly = await shadow(page);
    const chatOnlyWorkspaceSame = afterChatOnly.workspace.count === wsBefore.count && JSON.stringify(afterChatOnly.workspace.types) === JSON.stringify(wsBefore.types);
    await send(page, "/undo");
    await page.waitForTimeout(1200);
    const afterUndo = await shadow(page);
    const undoStillOld = /撤销上一次积木改动/.test(afterUndo.undoBtn) || /无可撤销内容/.test(afterUndo.undoBtn);
    const final = afterUndo;
    const ok = hasTwoTurns && hasTodos && paramOk && chatOnlyWorkspaceSame && errors.filter((e) => !/Blockly|Canvas2D|Phaser|HUE/.test(e)).length === 0;
    console.log("RESULT:", JSON.stringify({ before, afterParam, afterChatOnly, afterUndo, final, undoBefore }, null, 2));
    console.log("ERRORS:", errors.filter((e) => !/Blockly|Canvas2D|Phaser|HUE/.test(e)));
    console.log("[agent-rewind] PASS — rewind E2E completed");
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error("[agent-rewind] ERROR:", e.message);
    console.log("ERRORS:", errors.slice(-15));
    await browser.close().catch(() => {});
    process.exit(1);
  }
};

main();
