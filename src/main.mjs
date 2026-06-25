// src/main.mjs — Entry point for the multi-turn chat assistant. Detects the host,
// loads the catalog/knowledge, builds the agent's stable system prompt, and wires
// the chat panel to the tool-calling agent loop: user turn → runAgentTurn (which
// streams the reply and calls tools: read_workspace / search_blocks / edit_blocks
// / run_code / think / update_todos) → render. Conversation state is in-memory.

import { detectHost } from "./host/hostBridge.mjs";
import { readWorkspaceIR } from "./host/read.mjs";
import { snapshot, restore } from "./host/inject.mjs";
import { createLock } from "./host/lock.mjs";
import { createPanel } from "./ui/panel.mjs";
import { loadData, cfg } from "./runtime/data.mjs";
import { makeClient } from "./llm/client.mjs";
import { boardFromMaster, resolveVersion } from "./kb/knowledge.mjs";
import { coreTypes } from "./kb/retriever.mjs";
import { buildAgentSystem } from "./ctx/agent-prompt.mjs";
import { createHistory } from "./agent/history.mjs";
import { runAgentTurn } from "./agent/loop.mjs";
import { ALL_TOOLS } from "./agent/tools/index.mjs";
import { parseSlash, commandPrompt, COMMANDS, helpText } from "./agent/commands.mjs";

// Human-facing titles for tool cards / confirmation prompts.
const TOOL_META = {
  read_workspace: { icon: "📖", label: "读取工作区" },
  search_blocks: { icon: "🔍", label: "检索积木" },
  edit_blocks: { icon: "✏️", label: "修改积木", confirmTitle: "应用积木修改？" },
  run_code: { icon: "▶️", label: "运行程序", confirmTitle: "在掌控板上运行当前程序？" },
  think: { icon: "💭", label: "思考" },
  update_todos: { icon: "✅", label: "更新任务清单" },
};

async function boot() {
  if (window.__m3e__) { window.__m3e__.focus?.(); return; }
  window.__m3e__ = { booting: true };

  let caps;
  try {
    caps = detectHost();
  } catch (e) {
    alert("AI 编程助手无法启动：" + e.message);
    return;
  }

  const lock = createLock(caps);
  const panel = createPanel({
    onSend: ({ text }) => handleInput(text),
    onStop: () => currentAbort?.abort(),
    onSaveConfig: (c) => { for (const k in c) cfg.set(k, c[k]); panel.setStatus("设置已保存", "ok"); rebuildClient(); },
  });
  panel.loadConfig(cfg.llm());

  const session = { lastSnapshot: null, todos: [], approvals: new Set() };
  let data = null;
  let history = null;
  let client = null;
  let currentAbort = null;
  let board = boardFromMaster(currentMaster());
  let version = "unknown";

  window.__m3e__ = { focus: () => panel.setHidden(false), panel, caps, session };

  function currentMaster() {
    return window.localStorage.masterControl || caps.state().masterControl || "";
  }
  function rebuildClient() {
    const llm = cfg.llm();
    client = makeClient({ ...llm, fetchImpl: window.fetch.bind(window) });
  }
  function refreshBoard() {
    board = boardFromMaster(currentMaster());
    if (board.supported) panel.setBoard("● " + board.label, "ok");
    else panel.setBoard("⚠ " + board.label + "(不支持)", "err");
    return board;
  }

  rebuildClient();
  refreshBoard();
  panel.notice("正在加载积木知识库…");
  try {
    data = await loadData();
    version = board.version !== "unknown" ? board.version
      : resolveVersion({ master: currentMaster(), triggers: data.knowledge?.triggers });
    const system = buildAgentSystem({
      catalog: data.catalog,
      coreTypes: coreTypes(data.index, board.board),
      seeds: data.seeds,
      core: data.knowledge?.core,
      antipatterns: data.knowledge?.antipatterns,
      version,
    });
    history = createHistory(system);
    panel.notice(`已就绪：${data.index.length} 个积木 · ${board.label}`, "ok");
    panel.notice("用中文描述需求或提问，输入 /help 查看命令。");
  } catch (e) {
    panel.notice("加载知识库失败：" + e.message, "err");
  }

  // ---- input dispatch ----

  function handleInput(text) {
    if (!text) return;
    const slash = parseSlash(text);
    if (slash?.unknown) { panel.notice(`未知命令 /${slash.name}，输入 /help 查看`, "err"); return; }
    if (slash) {
      if (COMMANDS[slash.name].kind === "local") return runLocalCommand(slash.name);
      panel.addUser("/" + slash.name + (slash.arg ? " " + slash.arg : ""));
      return runTurn(commandPrompt(slash.name, slash.arg));
    }
    panel.addUser(text);
    runTurn(text);
  }

  async function runLocalCommand(name) {
    switch (name) {
      case "clear":
        history?.clear(); panel.clearFeed(); session.todos = [];
        panel.notice("已清空对话（工作区保留）", "ok");
        break;
      case "compact":
        if (!ensureReady()) break;
        panel.setBusy(true);
        try { await history.compact(client); panel.notice("已把对话压缩为摘要", "ok"); }
        catch (e) { panel.notice("压缩失败：" + e.message, "err"); }
        finally { panel.setBusy(false); }
        break;
      case "undo":
        if (session.lastSnapshot) {
          restore(caps, session.lastSnapshot); session.lastSnapshot = null;
          panel.notice("已撤销上一次积木改动", "ok");
        } else panel.notice("无可撤销内容");
        break;
      case "config":
        panel.openSettings();
        break;
      case "help": {
        const card = panel.toolCard({ icon: "❔", title: "命令帮助" });
        card.setBody(helpText());
        break;
      }
    }
  }

  function ensureReady() {
    if (!refreshBoard().supported) { panel.notice("当前主控不受支持，请切换到「掌控板」或「掌控板V3」", "err"); return false; }
    if (!data || !history) { panel.notice("知识库未就绪", "err"); return false; }
    if (!cfg.llm().apiKey) { panel.notice("请在 ⚙ 设置里填写 API Key", "err"); panel.openSettings(); return false; }
    return true;
  }

  // ---- one user turn through the agent loop ----

  async function runTurn(content) {
    if (!ensureReady()) return;
    const n = countBlocks(readWorkspaceIR(caps));
    const hint = n ? `（当前工作区约 ${n} 个积木；编辑前请调用 read_workspace 获取精确结构与 id）` : "（当前工作区为空）";
    history.addUser(`${content}\n${hint}`);

    currentAbort = new AbortController();
    panel.setBusy(true);
    lock.lock();
    const ui = createTurnUI();
    try {
      const r = await runAgentTurn({
        messages: history.messages(),
        tools: ALL_TOOLS,
        client,
        ctx: { caps, data, board, version, session, confirm: confirmTool },
        onEvent: ui.onEvent,
        signal: currentAbort.signal,
      });
      ui.finish();
      if (r.stopped === "max_steps") panel.notice("已达到单轮最多步骤数，已停止。可继续追问。", "err");
    } catch (e) {
      if (currentAbort.signal.aborted) panel.notice("已停止。");
      else panel.notice("出错：" + (e?.message || String(e)), "err");
    } finally {
      lock.unlock();
      panel.setBusy(false);
      currentAbort = null;
    }
  }

  /** Translate agent-loop events into panel rendering. */
  function createTurnUI() {
    let cur = null;            // current streaming assistant bubble
    const pending = new Map(); // name → queue of open tool cards
    let runCard = null;        // live run_code output card
    let runText = "";          // accumulated run_code output

    const openCard = (name, card) => {
      if (!pending.has(name)) pending.set(name, []);
      pending.get(name).push(card);
    };
    const closeBubble = (hasTools) => {
      if (!cur) return;
      const txt = cur.text();
      if (!txt && hasTools) cur.el.remove();
      else cur.done();
      cur = null;
    };

    return {
      onEvent(ev) {
        switch (ev.type) {
          case "assistant_start":
            cur = panel.beginAssistant();
            break;
          case "assistant_delta":
            if (!cur) cur = panel.beginAssistant();
            cur.delta(ev.text);
            break;
          case "assistant_done":
            closeBubble(ev.tool_calls?.length > 0);
            break;
          case "think":
            panel.toolCard({ icon: "💭", title: "思考" }).setBody(ev.thought);
            break;
          case "todos":
            panel.setTodos(ev.todos);
            break;
          case "tool_start": {
            if (ev.name === "think" || ev.name === "update_todos") break; // dedicated events render these
            const meta = TOOL_META[ev.name] || { icon: "·", label: ev.name };
            const sub = ev.name === "search_blocks" && ev.args?.query ? "：" + ev.args.query : "";
            const card = panel.toolCard({ icon: meta.icon, title: meta.label + sub });
            openCard(ev.name, card);
            if (ev.name === "run_code") { runCard = card; runText = ""; }
            break;
          }
          case "run_output":
            if (runCard) { runText += ev.chunk; runCard.setBody(runText, true); }
            break;
          case "tool_result": {
            const card = pending.get(ev.name)?.shift();
            if (card) card.setTone(ev.is_error ? "err" : "ok");
            break;
          }
          case "tool_rejected": {
            const card = pending.get(ev.name)?.shift();
            if (card) { card.setTone("err"); card.setBody("已拒绝"); }
            break;
          }
          case "applied":
            // editBlocks already stored the pre-edit snapshot on session for /undo.
            break;
        }
      },
      finish() { closeBubble(false); },
    };
  }

  // ---- confirmation gate for write/side-effecting tools ----
  async function confirmTool(tool, args) {
    const meta = TOOL_META[tool.name] || {};
    let detail = "";
    if (tool.name === "edit_blocks") detail = `共 ${Array.isArray(args?.ops) ? args.ops.length : "?"} 个编辑算子。`;
    if (tool.name === "run_code") detail = "将把当前程序下发到已连接的设备运行。";
    return panel.confirm({ title: meta.confirmTitle || `执行 ${tool.name}？`, detail });
  }
}

function countBlocks(program) {
  let n = 0;
  const walk = (node) => {
    if (!node || !node.type) return;
    n++;
    for (const v of Object.values(node.inputs || {})) walk(v);
    for (const seq of Object.values(node.statements || {})) for (const c of seq) walk(c);
  };
  for (const stack of program || []) for (const node of stack) walk(node);
  return n;
}

boot();
