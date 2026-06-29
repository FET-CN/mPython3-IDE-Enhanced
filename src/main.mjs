// src/main.mjs — Entry point for the multi-turn chat assistant. Detects the host,
// loads the catalog/knowledge, builds the agent's stable system prompt, and wires
// the chat panel to the tool-calling agent loop: user turn → runAgentTurn (which
// streams the reply and calls tools: read_workspace / search_blocks / edit_blocks
// / run_code / think / update_todos) → render. Conversation state is in-memory.

import { detectHost, watchNight } from "./host/hostBridge.mjs";
import { readWorkspaceIR } from "./host/read.mjs";
import { snapshot, restore } from "./host/inject.mjs";
import { computeEditPreview, renderWorkspaceSvg } from "./host/renderBlocks.mjs";
import { blockTreeHtml } from "./ui/blockTree.mjs";
import { createLock } from "./host/lock.mjs";
import { installSerialProxy } from "./host/serialProxy.mjs";
import { installTerminalFix } from "./host/termFix.mjs";
import { installFilePanel } from "./host/filePanel.mjs";
import { createPanel } from "./ui/panel.mjs";
import { loadData, cfg } from "./runtime/data.mjs";
import { makeClient } from "./llm/client.mjs";
import { boardFromMaster, resolveVersion } from "./kb/knowledge.mjs";
import { coreTypes, preferredTypes } from "./kb/retriever.mjs";
import { buildAgentSystem } from "./ctx/agent-prompt.mjs";
import { createHistory } from "./agent/history.mjs";
import { runAgentTurn } from "./agent/loop.mjs";
import { ALL_TOOLS } from "./agent/tools/index.mjs";
import { parseSlash, commandPrompt, COMMANDS, helpText, parseRewindArgs } from "./agent/commands.mjs";
import { log } from "./runtime/log.mjs";

// Human-facing titles for tool cards / confirmation prompts. `icon` is a key into
// the panel's unified SVG icon registry (no unicode emoji anywhere in the UI).
const TOOL_META = {
  read_workspace: { icon: "read", label: "读取工作区" },
  search_blocks: { icon: "search", label: "检索积木" },
  edit_blocks: { icon: "edit", label: "修改积木", confirmTitle: "应用积木修改？" },
  run_code: { icon: "run", label: "运行程序", confirmTitle: "在掌控板上运行当前程序？" },
  ask_user: { icon: "help", label: "请用户澄清" },
  think: { icon: "think", label: "思考" },
  update_todos: { icon: "todos", label: "更新任务清单" },
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
    onSaveConfig: (c) => { for (const k in c) cfg.set(k, c[k]); panel.setStatus("设置已保存", "ok"); rebuildClient(); setupSerialProxy(); },
  });
  panel.loadConfig({ ...cfg.llm(), serialProxy: cfg.get("serialProxy", "") });

  const session = { lastSnapshot: null, todos: [], approvals: new Set() };
  let data = null;
  let history = null;
  let client = null;
  let currentAbort = null;
  let board = boardFromMaster(currentMaster());
  let version = "unknown";
  let serialProxy = null;
  let isBusy = false;
  let rewindMode = false;
  const turnRecords = [];

  window.__m3e__ = { focus: () => { panel.setHidden(false); panel.focusInput?.(); }, panel, caps, session };

  // Self-heal: some host re-renders can wipe nodes out of <body>. Our panel host
  // carries the whole shadow tree + conversation state, so re-appending the SAME
  // node restores everything (no rebuild). Watch only direct children of <html>/
  // <body> — cheap, and deep xterm/Vue churn never trips a childList there.
  (function selfHeal() {
    const reattach = () => { if (panel.host && !panel.host.isConnected) (document.body || document.documentElement).appendChild(panel.host); };
    let bodyMO = null;
    const onMut = () => { reattach(); watchBody(); };
    function watchBody() { bodyMO?.disconnect(); if (document.body) { bodyMO = new MutationObserver(onMut); bodyMO.observe(document.body, { childList: true }); } }
    try { new MutationObserver(onMut).observe(document.documentElement, { childList: true }); watchBody(); }
    catch (e) { log.info("面板自愈未启用", e?.message); }
  })();

  // Follow the host site's light/dark theme (Vuex state.nightSwitch), not the OS.
  // watchNight fires cb once immediately with the current theme, then on changes.
  try { watchNight(caps, (dark) => panel.setDark(dark)); }
  catch (e) { log.info("主题跟随未启用", e?.message); }

  function currentMaster() {
    return window.localStorage.masterControl || caps.state().masterControl || "";
  }
  function rebuildClient() {
    const llm = cfg.llm();
    client = makeClient({ ...llm, fetchImpl: window.fetch.bind(window) });
  }
  function refreshBoard() {
    board = boardFromMaster(currentMaster());
    if (board.supported) panel.setBoard(board.label, "ok");
    else panel.setBoard(board.label + "（不支持）", "err");
    return board;
  }

  // 多个串口时，让用户在面板里选一个（替代浏览器原生的串口选择弹窗）。
  async function pickSerialPort(ports) {
    if (!ports?.length) return null;
    panel.setHidden(false);
    const options = ports.map((p) => ({
      label: p.path,
      description: [p.manufacturer, p.isBoard ? "掌控板" : "", p.vid ? `${p.vid}:${p.pid}` : ""].filter(Boolean).join(" · "),
    }));
    const chosen = await panel.ask({ question: "选择要连接的串口", options });
    return chosen ? ports.find((p) => p.path === chosen) : null;
  }

  // 按配置安装/重连本地串口代理（navigator.serial 垫片）。留空则不接管，走浏览器原生。
  async function setupSerialProxy() {
    if (serialProxy) { try { serialProxy.close(); } catch {} serialProxy = null; }
    const url = cfg.get("serialProxy", "").trim();
    if (!url) return;
    try {
      serialProxy = await installSerialProxy({ url, onStatus: (m, k) => panel.setStatus(m, k), pickPort: pickSerialPort });
      panel.notice("串口代理已连接：" + url + "（网站「连接设备」将走本地代理）", "ok");
    } catch (e) {
      panel.notice("串口代理未连接（" + (e?.message || e) + "）。请先启动本地 agent：uv run serial-proxy/m3e_serial_proxy.py", "err");
    }
  }

  rebuildClient();
  refreshBoard();
  setupSerialProxy();
  // 修复站点「右下角控制台/文件面板不显示」的 bug（xterm 孤立 + clearFn 崩溃 + 比例字体）。
  // 与串口代理无关，对原生 Chrome 用户也是净改善；站点结构不符时安静降级。
  try { installTerminalFix(caps); } catch (e) { log.info("终端自愈未启用", e?.message); }
  // 在网页版启用并补全站点「文件管理面板」：翻 isElectron 让面板渲染、routerDesk/​$serial 集中护栏、
  // 设备文件（mPythonList）经串口代理跑 os.* 读写。getExec 每次取「当前」串口代理 link 的 exec。
  try {
    installFilePanel({ caps, getExec: () => (serialProxy?.link?.exec ? serialProxy.link.exec.bind(serialProxy.link) : null) });
  } catch (e) { log.info("文件面板启用未生效", e?.message); }
  panel.notice("正在加载积木知识库…");
  try {
    data = await loadData();
    version = board.version !== "unknown" ? board.version
      : resolveVersion({ master: currentMaster(), triggers: data.knowledge?.triggers });
    const visibleSet = data.visible?.forBoard(board.board) || null;
    const system = buildAgentSystem({
      catalog: data.catalog,
      coreTypes: coreTypes(data.index, board.board, visibleSet),
      preferredTypes: preferredTypes(data.index, board.board, visibleSet),
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
  checkBookmarkVersion();

  // The bookmark string is frozen into the user's bookmark at install time, so
  // new bootstrap features (e.g. re-click → refocus) only take effect after they
  // re-drag it. main.min.js is stamped with the CURRENT loader version + build
  // rev; if the bookmark baked an older LOADER_VERSION (the bootstrap template
  // changed), nudge the user to reinstall. The commit rev is only for readable
  // display — it does NOT gate the prompt, so ordinary commits don't trip it.
  // __M3E_BASE__ is set only by the bookmark loader, so dev injections are exempt.
  function checkBookmarkVersion() {
    const base = window.__M3E_BASE__;
    const loaderV = window.__M3E_LOADER_VERSION__;
    if (!base || !loaderV) return;
    log.info("m3e 版本", { 运行: window.__M3E_BUILD_REV__ || "?", 书签: window.__M3E_BOOT_REV__ || "?", loader: loaderV });
    if (window.__M3E_BOOT_VERSION__ === loaderV) return;
    const from = window.__M3E_BOOT_REV__ || "旧版", to = window.__M3E_BUILD_REV__ || loaderV;
    panel.notice(`检测到书签为旧版本（书签 ${from} → 当前 ${to}），引导脚本已更新，部分新功能需重装书签后才生效。请打开 ${base}/install.html 重新拖拽安装书签。`);
  }

  // ---- input dispatch ----

  function handleInput(text) {
    if (!text) return;
    if (isBusy || currentAbort) { panel.notice("当前回合仍在运行，请先停止或等待完成。", "err"); return; }
    if (rewindMode) { panel.notice("请先完成或取消回退模式。", "err"); return; }
    const slash = parseSlash(text);
    if (slash?.unknown) { panel.notice(`未知命令 /${slash.name}，输入 /help 查看`, "err"); return; }
    if (slash) {
      if (COMMANDS[slash.name].kind === "local") return runLocalCommand(slash.name, slash.arg);
      return runTurn({ displayText: "/" + slash.name + (slash.arg ? " " + slash.arg : ""), contentText: commandPrompt(slash.name, slash.arg) });
    }
    runTurn({ displayText: text, contentText: text });
  }

  async function runLocalCommand(name, arg = "") {
    switch (name) {
      case "clear":
        panel.exitRewindMode?.(); rewindMode = false;
        history?.clear(); turnRecords.length = 0; panel.clearFeed(); session.todos = []; panel.setTodos([]);
        panel.notice("已清空对话（工作区保留）", "ok");
        break;
      case "compact":
        if (!ensureReady()) break;
        if (isBusy || currentAbort) { panel.notice("当前回合仍在运行，请稍后再压缩。", "err"); break; }
        panel.exitRewindMode?.(); rewindMode = false;
        setBusy(true);
        try { await history.compact(client); turnRecords.length = 0; panel.notice("已把对话压缩为摘要", "ok"); }
        catch (e) { panel.notice("压缩失败：" + e.message, "err"); }
        finally { setBusy(false); }
        break;
      case "rewind":
        await runRewindCommand(arg);
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
        const card = panel.toolCard({ icon: "help", title: "命令帮助" });
        card.setBody(helpText());
        break;
      }
    }
  }

  function ensureReady() {
    if (!refreshBoard().supported) { panel.notice("当前主控不受支持，请切换到「掌控板」或「掌控板V3」", "err"); return false; }
    if (!data || !history) { panel.notice("知识库未就绪", "err"); return false; }
    if (!cfg.llm().apiKey) { panel.notice("请在设置（右上角齿轮）里填写 API Key", "err"); panel.openSettings(); return false; }
    return true;
  }

  function setBusy(b) {
    isBusy = !!b;
    panel.setBusy(!!b);
  }

  const cloneTodos = (todos) => (Array.isArray(todos) ? todos.map((t) => ({ ...t })) : []);
  const clipText = (s, n = 80) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };

  function buildRewindChoices() {
    const closedIds = new Set(history?.closedTurns?.().map((t) => t.id) || []);
    const closed = turnRecords.filter((r) => closedIds.has(r.id));
    return closed.map((r, i) => ({ ...r, count: closed.length - i, previewText: clipText(r.displayText) }));
  }

  async function runRewindCommand(arg = "") {
    if (!ensureReady()) return;
    if (isBusy || currentAbort) { panel.notice("当前回合仍在运行，请先停止或等待完成。", "err"); return; }
    const parsed = parseRewindArgs(arg);
    if (parsed.mode === "error") { panel.notice(parsed.message, "err"); return; }
    if (parsed.mode === "interactive") return enterInteractiveRewind();
    return performRewind({ count: parsed.count, chatOnly: parsed.chatOnly });
  }

  async function enterInteractiveRewind() {
    const turns = buildRewindChoices();
    if (!turns.length) { panel.notice("无可回退的对话", "err"); return; }
    rewindMode = true;
    const picked = await panel.enterRewindMode({ turns });
    if (!picked) { rewindMode = false; panel.exitRewindMode?.(); return; }
    const affected = turns.filter((t) => t.count <= picked.count);
    panel.exitRewindMode?.();
    const mode = await panel.confirmRewind({ turn: picked, count: picked.count, hasRunCode: affected.some((t) => t.hadRunCode), hasWorkspaceSnapshot: !!picked.workspaceSnapOk });
    if (!mode) { rewindMode = false; panel.exitRewindMode?.(); return; }
    rewindMode = false;
    panel.exitRewindMode?.();
    await performRewind({ count: picked.count, chatOnly: mode === "chat" });
  }

  async function performRewind({ count = 1, chatOnly = false } = {}) {
    const available = history?.rewindableCount?.() || 0;
    if (!available) { panel.notice("无可回退的对话", "err"); return; }
    if (!Number.isSafeInteger(count) || count <= 0) { panel.notice("回退轮数必须是正整数", "err"); return; }
    if (count > available) { panel.notice(`只能回退最近 ${available} 轮对话`, "err"); return; }
    const closedIds = new Set(history.closedTurns().map((t) => t.id));
    const closedRecords = turnRecords.filter((r) => closedIds.has(r.id));
    const target = closedRecords[closedRecords.length - count];
    const removed = closedRecords.slice(closedRecords.length - count);
    if (!target) { panel.notice("无法找到对应的回退点", "err"); return; }

    panel.exitRewindMode?.(); rewindMode = false;
    const hist = history.rewind(count);
    if (!hist.ok) { panel.notice("回退失败：历史边界不可用", "err"); return; }
    const keep = new Set(history.closedTurns().map((t) => t.id));
    for (let i = turnRecords.length - 1; i >= 0; i--) if (!keep.has(turnRecords[i].id)) turnRecords.splice(i, 1);

    const uiOk = panel.restoreFeedMark(target.feedMark);
    session.todos = cloneTodos(target.todosBefore);
    panel.setTodos(session.todos);

    let wsOk = true;
    if (!chatOnly) {
      if (target.workspaceSnapOk && target.workspaceSnap) {
        try { restore(caps, target.workspaceSnap); session.lastSnapshot = null; }
        catch (e) { wsOk = false; panel.notice("对话已回退，但工作区恢复失败：" + (e?.message || e), "err"); }
      } else {
        wsOk = false;
        panel.notice("对话已回退，但该回合缺少工作区快照，未恢复工作区。", "err");
      }
    }
    const side = removed.some((r) => r.hadRunCode) ? "；设备运行副作用无法撤销" : "";
    const ui = uiOk ? "" : "；界面记录无法精确裁剪，必要时可 /clear";
    if (wsOk || chatOnly) panel.notice(`已回退 ${count} 轮对话${chatOnly ? "（工作区保留）" : "（工作区已恢复）"}${side}${ui}`, "ok");
  }

  // ---- one user turn through the agent loop ----

  async function runTurn(input) {
    const displayText = typeof input === "string" ? input : input?.displayText;
    const contentText = typeof input === "string" ? input : input?.contentText;
    if (!ensureReady()) return;
    if (isBusy || currentAbort) { panel.notice("当前回合仍在运行，请先停止或等待完成。", "err"); return; }
    let feedMark = null, workspaceSnap = null, workspaceSnapOk = false, historyTurn = null, record = null;
    try { feedMark = panel.feedMark(); } catch {}
    try { workspaceSnap = snapshot(caps); workspaceSnapOk = true; }
    catch (e) { panel.notice("工作区快照失败，本轮之后只能仅回退聊天：" + (e?.message || e), "err"); }
    const todosBefore = cloneTodos(session.todos);
    const lastSnapshotBefore = session.lastSnapshot;
    const n = countBlocks(readWorkspaceIR(caps));
    const hint = n ? `（当前工作区约 ${n} 个积木；编辑前请调用 read_workspace 获取精确结构与 id）` : "（当前工作区为空）";
    historyTurn = history.beginTurn(`${contentText}\n${hint}`);
    const userNode = panel.addUser(displayText, { turnId: historyTurn.id });
    record = {
      id: historyTurn.id, historyTurn, feedMark, userNode, workspaceSnap, workspaceSnapOk,
      todosBefore, lastSnapshotBefore, displayText, previewText: clipText(displayText),
      hadRunCode: false, hadWorkspaceEdit: false, status: "open",
    };
    turnRecords.push(record);
    log.info("用户输入", { 需求: displayText, 工作区积木数: n });

    currentAbort = new AbortController();
    setBusy(true);
    lock.lock();
    const ui = createTurnUI(record);
    try {
      const r = await runAgentTurn({
        messages: history.messages(),
        tools: ALL_TOOLS,
        client,
        ctx: { caps, data, board, version, session, confirm: confirmTool, ask: (q) => panel.ask(q) },
        onEvent: ui.onEvent,
        signal: currentAbort.signal,
      });
      ui.finish();
      record.status = r.stopped === "done" ? "closed" : r.stopped;
      if (r.stopped === "max_steps") panel.notice("已达到单轮最多步骤数，已停止。可继续追问。", "err");
    } catch (e) {
      record.status = currentAbort.signal.aborted ? "aborted" : "error";
      if (currentAbort.signal.aborted) panel.notice("已停止。");
      else panel.notice("出错：" + (e?.message || String(e)), "err");
    } finally {
      history.closeTurn(historyTurn, { status: record.status });
      lock.unlock();
      setBusy(false);
      currentAbort = null;
    }
  }

  /** Translate agent-loop events into panel rendering. */
  function createTurnUI(record = null) {
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
          case "assistant_discard":
            cur?.el?.remove?.();
            cur = null;
            break;
          case "assistant_done":
            closeBubble(ev.tool_calls?.length > 0);
            break;
          case "think":
            panel.toolCard({ icon: "think", title: "思考" }).setBody(ev.thought);
            break;
          case "todos":
            panel.setTodos(ev.todos);
            break;
          case "tool_repair": {
            const meta = TOOL_META[ev.name] || { icon: "help", label: ev.name };
            panel.toolCard({ icon: meta.icon, title: "正在修正积木方案", body: ev.detail || "", expanded: false });
            break;
          }
          case "tool_start": {
            if (ev.name === "run_code" && record) record.hadRunCode = true;
            if (ev.name === "think" || ev.name === "update_todos" || ev.name === "ask_user") break; // these render their own UI
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
            if (record) record.hadWorkspaceEdit = true;
            break;
        }
      },
      finish() { closeBubble(false); },
    };
  }

  // ---- confirmation gate for write/side-effecting tools ----
  async function confirmTool(tool, args) {
    const meta = TOOL_META[tool.name] || {};
    const title = meta.confirmTitle || `执行 ${tool.name}？`;
    if (tool.name === "edit_blocks") return confirmEdit(title, args);
    let detail = "";
    if (tool.name === "run_code") detail = "将把当前程序下发到已连接的设备运行。";
    return panel.confirm({ title, detail });
  }

  // edit_blocks gets a visual preview of the resulting blocks (computed offline,
  // no workspace mutation). Fidelity ladder: real Blockly SVG → self-drawn block
  // tree → text-only summary; each step degrades quietly so we never block on a
  // preview failure. The zh change summary is shown as the detail whenever it can
  // be computed — even when validation fails (so the card never reads as blank).
  function confirmEdit(title, args) {
    let detail = `共 ${Array.isArray(args?.ops) ? args.ops.length : "?"} 个编辑算子。`;
    let preview = null;
    try {
      const pre = computeEditPreview(caps, args?.ops, data.catalog);
      if (pre.summary?.length) detail = pre.summary.join("；");
      if (pre.ok) {
        const svg = pre.afterXml ? renderWorkspaceSvg(caps, pre.afterXml, { lock }) : null;
        preview = svg || blockTreeHtml(pre.postIR, data.catalog);
      } else if (pre.rawIR?.length) {
        preview = blockTreeHtml(pre.rawIR, data.catalog);
      }
    } catch (e) {
      log.debug("编辑预览生成失败", e?.message || String(e));
    }
    return panel.confirm({ title, detail, preview });
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
