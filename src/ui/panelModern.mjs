// src/ui/panelModern.mjs — modern 主题聊天面板（Shadow DOM，注入宿主页）。
//
// main.mjs 直接挂载本面板。这里是纯视图：渲染消息 / 工具卡 / 任务清单 /
// 流式气泡 / 确认卡，回调（onSend/onStop/onSaveConfig）交给 main.mjs 接 agent 循环。
//
// 形态：右缘抽屉，可切换为可拖拽/缩放浮窗（停靠状态 + 几何持久化于 m3e_* localStorage）。
// 主题：严格遵循 uidotsh —— 中性只用 zinc、全局唯一强调蓝（blue-600 亮 / blue-500 暗，仅焦点环/主按钮/
// 链接/激活）、分隔用不透明度色而非实心灰线、卡片 ring-1 + inset-ring-white/5、暗底 zinc-950(非纯黑)、
// dark:shadow-none、每界面一个 primary、数字 tabular-nums、根 antialiased+isolate。图标一律 Heroicons Micro。
// 暗色类驱动（.dark），跟随宿主夜间，非 OS 偏好。样式为预编译 Tailwind v4（PANEL_CSS_MODERN）内联。

import { PANEL_CSS_MODERN } from "./stylesModern.generated.mjs";
import { ICON } from "./iconsMicro.mjs";
import { activateModernFonts } from "./fontsModern.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/** 轻量、安全的 Markdown → HTML。顶层围栏代码块；散文内：ATX 标题、引用、有/无序列表、分隔线、
 *  段落、行内跨度（code/bold/italic/strike/link）。先转义再叠加标记。 */
function renderMarkdown(text) {
  const parts = String(text).split(/```(\w*)\n?([\s\S]*?)```/g);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) html += renderProse(parts[i]);
    const code = parts[i + 2];
    if (code != null) html += `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
  }
  return html;
}

function renderProse(src) {
  const lines = String(src).replace(/\n$/, "").split("\n");
  let out = "";
  let para = [];
  let list = null;
  let quote = null;
  const flushPara = () => { if (para.length) { out += `<p class="my-1">${para.map(inlineMd).join("<br>")}</p>`; para = []; } };
  const flushList = () => {
    if (!list) return;
    const cls = list.tag === "ol" ? "my-1 list-decimal pl-5 space-y-0.5" : "my-1 list-disc pl-5 space-y-0.5";
    out += `<${list.tag} class="${cls}">${list.items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</${list.tag}>`;
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    out += `<blockquote class="my-1 border-l-2 border-zinc-950/15 pl-3 text-zinc-500 dark:border-white/15 dark:text-zinc-400">${quote.map(inlineMd).join("<br>")}</blockquote>`;
    quote = null;
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushAll(); continue; }

    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushAll();
      const lvl = m[1].length;
      const size = lvl <= 1 ? "text-[0.9375rem]" : lvl === 2 ? "text-sm" : "text-[0.8125rem]";
      out += `<div class="${size} font-semibold text-zinc-900 dark:text-zinc-100 mt-2 mb-1">${inlineMd(m[2])}</div>`;
    } else if (/^(\s*)([-*_])(\s*\2){2,}\s*$/.test(line)) {
      flushAll();
      out += `<hr class="my-2 border-zinc-950/10 dark:border-white/10">`;
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flushPara(); flushList();
      (quote ||= []).push(m[1]);
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
      list.items.push(m[1]);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
      list.items.push(m[1]);
    } else {
      flushList(); flushQuote();
      para.push(line);
    }
  }
  flushAll();
  return out;
}

/** 单行文本的行内跨度。先转义，再叠加标记。 */
function inlineMd(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code class="rounded bg-zinc-950/8 px-1 py-0.5 text-xs dark:bg-white/10">$1</code>');
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300">$1</a>');
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return h;
}

export function createPanelModern(opts = {}) {
  const doc = document;
  const host = doc.createElement("div");
  host.id = "m3e-panel-host";
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <style>${PANEL_CSS_MODERN}</style>
    <div class="m3e isolate font-sans">
      <button data-act="reopen" class="m3e-launcher pointer-events-auto absolute right-0 top-[46%] hidden rounded-l-xl bg-zinc-900 px-2 py-3.5 text-xs font-semibold tracking-[3px] text-white shadow-lg transition-colors hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white [writing-mode:vertical-rl]">AI 编程</button>
      <div data-wrap class="m3e-wrap pointer-events-auto absolute flex flex-col overflow-hidden bg-white text-zinc-900 antialiased ring-1 ring-zinc-950/10 transition-[transform,opacity] duration-200 dark:bg-zinc-950 dark:text-zinc-100 dark:ring-white/10">
        <header data-drag class="flex items-center gap-1.5 border-b border-zinc-950/5 px-3 py-2.5 dark:border-white/10">
          <b class="flex-1 truncate text-[0.8125rem] font-semibold tracking-tight">AI 图形化编程</b>
          <span data-board class="inline-flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums text-zinc-500 dark:text-zinc-400"><span class="size-1.5 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-500"></span><span>检测中…</span></span>
          <button data-act="dock" type="button" title="切换浮窗/停靠" aria-label="切换浮窗/停靠" class="grid size-7 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-950/5 hover:text-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200">${ICON.float}</button>
          <button data-act="settings" type="button" title="设置" aria-label="设置" class="grid size-7 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-950/5 hover:text-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200">${ICON.gear}</button>
          <button data-act="toggle" type="button" title="收起" aria-label="收起" class="grid size-7 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-950/5 hover:text-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200">${ICON.collapse}</button>
        </header>

        <div data-feed class="m3e-scroll flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3.5 text-[0.8125rem]/6"></div>

        <div data-settings class="hidden flex-col gap-2.5 border-t border-zinc-950/5 bg-zinc-50 px-3 py-3 dark:border-white/10 dark:bg-white/2">
          <label class="text-xs text-zinc-500 dark:text-zinc-400" for="m3e-base">LLM Base URL（OpenAI 兼容）</label>
          <input id="m3e-base" name="baseURL" data-cfg="baseURL" placeholder="https://api.deepseek.com/v1" class="rounded-lg bg-white px-2.5 py-2 text-xs text-zinc-900 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-black/40 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500">
          <label class="text-xs text-zinc-500 dark:text-zinc-400" for="m3e-key">API Key</label>
          <input id="m3e-key" name="apiKey" data-cfg="apiKey" type="password" placeholder="sk-..." class="rounded-lg bg-white px-2.5 py-2 text-xs text-zinc-900 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-black/40 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500">
          <label class="text-xs text-zinc-500 dark:text-zinc-400" for="m3e-model">模型</label>
          <input id="m3e-model" name="model" data-cfg="model" placeholder="deepseek-chat" class="rounded-lg bg-white px-2.5 py-2 text-xs text-zinc-900 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-black/40 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500">
          <label class="text-xs text-zinc-500 dark:text-zinc-400" for="m3e-serial">串口代理地址（Firefox 等用，留空则用浏览器原生）</label>
          <input id="m3e-serial" name="serialProxy" data-cfg="serialProxy" placeholder="ws://127.0.0.1:8765" class="rounded-lg bg-white px-2.5 py-2 text-xs text-zinc-900 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-black/40 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500">
          <button data-act="saveCfg" type="button" class="mt-1 self-end rounded-lg bg-blue-600 px-3 py-1.5 text-[0.8125rem] font-medium text-white transition-colors hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400">保存设置</button>
        </div>

        <div class="border-t border-zinc-950/5 dark:border-white/10">
          <div data-progress class="hidden border-b border-zinc-950/5 dark:border-white/10"></div>
          <div class="px-3 py-2.5">
            <div data-status class="mb-1.5 hidden text-xs tabular-nums text-zinc-500 dark:text-zinc-500"></div>
            <div class="flex items-end gap-2">
              <textarea data-input name="prompt" rows="2" aria-label="描述需求或提问" placeholder="描述需求或提问，例如：按A键显示温度 / 把刚才那块改成红色（/help 查看命令）" class="m3e-scroll max-h-40 flex-1 resize-none rounded-xl bg-zinc-950/3 px-3 py-2 text-[0.8125rem]/6 text-zinc-900 ring-1 ring-zinc-950/8 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-white/5 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500"></textarea>
              <button data-act="send" type="button" title="发送" aria-label="发送" class="grid size-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white transition-colors hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:bg-zinc-950/5 disabled:text-zinc-400 dark:bg-blue-500 dark:hover:bg-blue-400 dark:disabled:bg-white/5 dark:disabled:text-zinc-600">${ICON.send}</button>
              <button data-act="stop" type="button" title="停止" aria-label="停止" class="hidden size-9 shrink-0 place-items-center rounded-xl bg-zinc-950/5 text-zinc-600 transition-colors hover:bg-zinc-950/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10">${ICON.stop}</button>
            </div>
          </div>
        </div>

        <div data-resize class="absolute right-0 bottom-0 hidden size-4 cursor-nwse-resize touch-none [clip-path:polygon(100%_0,100%_100%,0_100%)]"></div>
      </div>
    </div>`;
  doc.body.appendChild(host);

  // 注册内嵌字体（Geist + Sarasa）；失败优雅降级到系统/等宽（见 fontsModern）。
  try { activateModernFonts(doc); } catch {}

  const $ = (s) => root.querySelector(s);
  const m3eRoot = $(".m3e");
  const wrap = $("[data-wrap]");
  const launcher = $("[data-act='reopen']");
  const header = $("[data-drag]");
  const feed = $("[data-feed]");
  const input = $("[data-input]");
  const statusEl = $("[data-status]");
  const boardEl = $("[data-board]");
  const sendBtn = $("[data-act='send']");
  const stopBtn = $("[data-act='stop']");
  const settings = $("[data-settings]");
  const dockBtn = $("[data-act='dock']");
  const progress = $("[data-progress]");
  const resizeHandle = $("[data-resize]");

  const scrollToEnd = () => { feed.scrollTop = feed.scrollHeight; };
  const append = (el) => { dropHint?.(); feed.appendChild(el); scrollToEnd(); return el; };
  const div = (cls, html) => { const d = doc.createElement("div"); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };

  function feedMark() {
    dropHint?.();
    const marker = doc.createComment("m3e-feed-mark");
    feed.appendChild(marker);
    return marker;
  }

  function restoreFeedMark(marker) {
    if (!marker || marker.parentNode !== feed) return false;
    while (marker.nextSibling) marker.nextSibling.remove();
    marker.remove();
    if (!feed.childNodes.length) feed.appendChild(emptyHint);
    scrollToEnd();
    return true;
  }

  // ---- message primitives ----

  function addUser(text, meta = {}) {
    const row = div("flex justify-end");
    if (meta.turnId) row.dataset.turnId = meta.turnId;
    row.appendChild(div("max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-zinc-100 px-3 py-2 text-[0.8125rem] text-zinc-900 ring-1 ring-zinc-950/5 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/10", esc(text)));
    return append(row);
  }

  function notice(text, kind = "") {
    const tone = kind === "err" ? "text-red-600 dark:text-red-400" : kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500";
    return append(div(`text-center text-xs ${tone}`, esc(text)));
  }

  function beginAssistant() {
    const bubble = div("m3e-prose m3e-caret max-w-full text-[0.8125rem] text-zinc-900 dark:text-zinc-100");
    append(bubble);
    let raw = "";
    return {
      el: bubble,
      delta(t) { raw += t; bubble.textContent = raw; scrollToEnd(); },
      text: () => raw,
      done(finalText) {
        raw = finalText != null ? finalText : raw;
        bubble.classList.remove("m3e-caret");
        bubble.innerHTML = renderMarkdown(raw);
        scrollToEnd();
      },
    };
  }

  // 已结算的一行式摘要行 —— 无卡片外框，仅弱化文本。
  const settledCls = "rounded-lg px-2.5 py-2 text-xs text-zinc-500 dark:text-zinc-400";

  // 工具状态色只落在前导图标（唯一显色处，无 ring/border）。
  const toneIc = (tone = "") =>
    tone === "err" ? "text-red-500 dark:text-red-400"
    : tone === "ok" ? "text-emerald-500 dark:text-emerald-400"
    : "text-zinc-400 dark:text-zinc-500";

  /** 工具调用行（think / search / edit / run）。无边框：整行 hover 高亮；下方日志 well 运行时展开、
   *  setTone(ok/err) 完成后自动收起为一行式表头。状态色只染前导图标。 */
  function toolCard({ icon = "help", title, body = "", tone = "", expanded: initialExpanded = true }) {
    const card = div("rounded-lg");
    card.innerHTML =
      `<button type="button" data-head class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-950/4 dark:text-zinc-300 dark:hover:bg-white/5">` +
        `<span data-ic class="${toneIc(tone)}">${ICON[icon] || ICON.help}</span>` +
        `<span data-title class="flex-1 truncate">${esc(title)}</span>` +
        `<span data-chev class="text-zinc-300 transition-transform duration-150 dark:text-zinc-600">${ICON.chevron}</span>` +
      `</button>` +
      `<div data-wrapbody class="px-2 pb-1.5"><div data-body class="text-xs text-zinc-500 dark:text-zinc-400"></div></div>`;
    if (body) card.querySelector("[data-body]").textContent = body;
    append(card);

    const chev = card.querySelector("[data-chev]");
    const iconEl = card.querySelector("[data-ic]");
    const wrapBody = card.querySelector("[data-wrapbody]");
    let expanded = !!initialExpanded;
    let hasBody = !!body;
    const sync = () => {
      const show = expanded && hasBody;
      wrapBody.classList.toggle("hidden", !show);
      chev.classList.toggle("rotate-90", expanded);
      chev.classList.toggle("opacity-0", !hasBody);
    };
    sync();
    card.querySelector("[data-head]").addEventListener("click", () => { if (!hasBody) return; expanded = !expanded; sync(); });

    return {
      el: card,
      setBody(text, mono = false) {
        const b = card.querySelector("[data-body]");
        b.className = mono
          ? "m3e-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950/4 p-2.5 font-mono text-[0.6875rem] text-zinc-600 dark:bg-white/5 dark:text-zinc-300"
          : "text-xs text-zinc-500 dark:text-zinc-400";
        b.textContent = text;
        hasBody = text != null && text !== "";
        sync();
        scrollToEnd();
      },
      setTone(t) {
        iconEl.className = toneIc(t);
        if (t === "ok" || t === "err") expanded = false;
        sync();
      },
    };
  }

  /** 任务清单 → 输入框上方固定进度条（非 feed）。空则隐藏。默认折叠为一行「✓done/total · 当前步」，
   *  点表头或 Alt+T 展开完整列表。 */
  let todoExpanded = false;
  let lastTodos = [];
  function renderProgress() {
    const todos = lastTodos;
    if (!todos.length) { progress.classList.add("hidden"); progress.innerHTML = ""; return; }
    progress.classList.remove("hidden");
    const done = todos.filter((t) => t.status === "completed").length;
    const cur = todos.find((t) => t.status === "in_progress") || todos.find((t) => t.status === "pending");
    const mark = { completed: ICON.check, in_progress: ICON.running, pending: ICON.pending };
    const color = { completed: "text-emerald-600 dark:text-emerald-400", in_progress: "text-blue-600 dark:text-blue-400", pending: "text-zinc-400 dark:text-zinc-500" };

    const head =
      `<button type="button" data-phead class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-950/3 dark:hover:bg-white/3">` +
        `<span class="text-zinc-500 dark:text-zinc-500">${ICON.todos}</span>` +
        `<span class="shrink-0 font-medium tabular-nums text-zinc-700 dark:text-zinc-200">${done}/${todos.length}</span>` +
        (cur ? `<span class="flex-1 truncate text-zinc-500 dark:text-zinc-400">${esc(cur.title)}</span>` : `<span class="flex-1"></span>`) +
        `<span data-pchev class="text-zinc-400 transition-transform duration-150 dark:text-zinc-500 ${todoExpanded ? "rotate-90" : ""}">${ICON.chevron}</span>` +
      `</button>`;
    const rows = todos
      .map((t) => `<div class="flex items-start gap-1.5 text-xs ${t.status === "completed" ? "text-zinc-400 line-through dark:text-zinc-500" : "text-zinc-700 dark:text-zinc-300"}"><span class="${color[t.status] || "text-zinc-400"}">${mark[t.status] || ICON.pending}</span><span>${esc(t.title)}</span></div>`)
      .join("");
    const list = `<div data-plist class="m3e-scroll max-h-44 space-y-1 overflow-y-auto px-3 pb-2.5 ${todoExpanded ? "" : "hidden"}">${rows}</div>`;
    progress.innerHTML = head + list;
    progress.querySelector("[data-phead]").addEventListener("click", () => { todoExpanded = !todoExpanded; renderProgress(); });
  }
  function setTodos(todos) {
    lastTodos = Array.isArray(todos) ? todos : [];
    renderProgress();
  }

  /** 行内结构化提问 → resolve 选中 label（单选）/ label 数组（多选）/ null（关闭）。与 confirm 卡呼应。 */
  function ask({ question, options = [], multi = false }) {
    return new Promise((resolve) => {
      const card = div("rounded-xl bg-zinc-950/3 p-2.5 ring-1 ring-zinc-950/8 dark:bg-white/3 dark:ring-white/10");
      const opts = options.map((o, i) => {
        const desc = o.description ? `<div class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">${esc(o.description)}</div>` : "";
        return `<button type="button" data-o="${i}" aria-pressed="false" class="w-full rounded-lg bg-white px-2.5 py-1.5 text-left text-xs text-zinc-700 ring-1 ring-zinc-950/6 transition-colors hover:ring-zinc-950/15 aria-pressed:bg-blue-500/10 aria-pressed:ring-blue-500/40 dark:bg-white/5 dark:text-zinc-200 dark:ring-white/10 dark:hover:ring-white/20 dark:aria-pressed:bg-blue-500/15 dark:aria-pressed:ring-blue-400/40"><span class="font-medium text-zinc-900 dark:text-zinc-100">${esc(o.label)}</span>${desc}</button>`;
      }).join("");
      card.innerHTML =
        `<div class="text-xs font-medium text-zinc-900 dark:text-zinc-100">${esc(question)}</div>` +
        `<div data-opts class="mt-2 flex flex-col gap-1.5">${opts}</div>` +
        (multi ? `<button type="button" data-submit class="mt-2 self-end rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:bg-zinc-950/5 disabled:text-zinc-400 dark:bg-blue-500 dark:hover:bg-blue-400 dark:disabled:bg-white/5 dark:disabled:text-zinc-600" disabled>提交</button>` : "");
      append(card);

      const chosen = new Set();
      const finish = (labels) => {
        card.querySelectorAll("button").forEach((b) => (b.disabled = true));
        card.className = settledCls;
        const shown = labels && labels.length ? labels.join("、") : "（已关闭）";
        card.innerHTML = `<div class="${settledCls}">${esc(question)} — ${esc(shown)}</div>`;
        resolve(labels && labels.length ? (multi ? labels : labels[0]) : null);
      };
      card.addEventListener("click", (e) => {
        const btn = e.target.closest?.("button");
        if (!btn) return;
        if (btn.hasAttribute("data-submit")) { finish([...chosen].map((i) => options[i].label)); return; }
        const i = btn.getAttribute("data-o");
        if (i == null) return;
        if (!multi) { finish([options[+i].label]); return; }
        const on = !chosen.has(+i);
        on ? chosen.add(+i) : chosen.delete(+i);
        btn.setAttribute("aria-pressed", String(on));
        card.querySelector("[data-submit]").disabled = chosen.size === 0;
      });
    });
  }

  /** 行内确认卡 → resolve 'once' | 'session' | false。preview 可选：DOM 节点或 HTML 字符串（如渲染的
   *  积木树），落在详情与按钮之间的可滚动 well；结算成一行式摘要时丢弃。 */
  function confirm({ title, detail, preview }) {
    return new Promise((resolve) => {
      const card = div("rounded-xl bg-zinc-950/3 p-2.5 ring-1 ring-amber-500/25 dark:bg-white/3 dark:ring-amber-400/25");
      card.innerHTML =
        `<div class="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300"><span class="text-amber-500 dark:text-amber-400">${ICON.alert}</span><span class="flex-1">${esc(title)}</span></div>` +
        (detail ? `<div class="mt-1 pl-[22px] text-xs text-zinc-600 dark:text-zinc-300">${esc(detail)}</div>` : "") +
        (preview ? `<div data-preview class="m3e-scroll mt-2 max-h-72 overflow-auto rounded-lg bg-zinc-950/3 p-2 ring-1 ring-zinc-950/6 dark:bg-black/20 dark:ring-white/10"></div>` : "") +
        `<div class="mt-2.5 flex gap-2">
          <button type="button" data-c="once" class="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400">允许一次</button>
          <button type="button" data-c="session" class="rounded-lg bg-zinc-950/5 px-2.5 py-1 text-xs text-zinc-700 transition-colors hover:bg-zinc-950/10 dark:bg-white/5 dark:text-zinc-200 dark:hover:bg-white/10">本会话允许</button>
          <button type="button" data-c="no" class="ml-auto rounded-lg px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-200">拒绝</button>
        </div>`;
      if (preview) {
        const slot = card.querySelector("[data-preview]");
        if (typeof preview === "string") slot.innerHTML = preview;
        else if (preview.nodeType) slot.appendChild(preview);
      }
      append(card);
      card.addEventListener("click", (e) => {
        const c = e.target.closest?.("[data-c]")?.getAttribute("data-c");
        if (!c) return;
        card.querySelectorAll("button").forEach((b) => (b.disabled = true));
        const label = c === "once" ? "已允许一次" : c === "session" ? "本会话允许" : "已拒绝";
        card.className = settledCls;
        card.innerHTML = `<div class="${settledCls}">${esc(title)} — ${label}</div>`;
        resolve(c === "no" ? false : c);
      });
    });
  }

  let rewindCleanup = null;
  function exitRewindMode() {
    rewindCleanup?.();
    rewindCleanup = null;
  }

  function summarizeTurn(t) {
    const text = String(t.previewText || t.displayText || "").replace(/\s+/g, " ").trim();
    return text.length > 42 ? text.slice(0, 42) + "…" : text || "（空输入）";
  }

  function enterRewindMode({ turns = [], onPick, onListAll, onCancel } = {}) {
    exitRewindMode();
    return new Promise((resolve) => {
      let done = false;
      const cleanups = [];
      const finish = (turn) => {
        if (done) return;
        done = true;
        exitRewindMode();
        resolve(turn || null);
      };
      const bar = div("rounded-xl bg-blue-500/6 p-2.5 text-xs text-blue-700 ring-1 ring-blue-500/20 dark:bg-white/3 dark:text-blue-300 dark:ring-blue-400/25");
      bar.innerHTML =
        `<div class="font-medium">选择要回退到哪一轮之前</div>` +
        `<div class="mt-1 text-blue-700/80 dark:text-blue-300/80">点击任意用户消息，或查看所有回合。</div>` +
        `<div class="mt-2 flex gap-2"><button type="button" data-rw-list class="rounded-lg bg-blue-600 px-2.5 py-1 text-white transition-colors hover:bg-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400">查看所有回合</button><button type="button" data-rw-cancel class="rounded-lg bg-zinc-950/5 px-2.5 py-1 text-zinc-700 transition-colors hover:bg-zinc-950/10 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15">取消</button></div>`;
      append(bar);
      cleanups.push(() => bar.remove());

      const PICK_CLS = ["outline-2", "outline-offset-2", "outline-blue-600/75", "cursor-pointer"];
      turns.forEach((t) => {
        const row = t.userNode;
        if (!row?.isConnected) return;
        const bubble = row.firstElementChild || row;
        bubble.classList.add(...PICK_CLS);
        const badge = div("ml-2 shrink-0 cursor-pointer self-center whitespace-nowrap text-xs text-blue-600 dark:text-blue-400", `回退到此轮之前 · 最近第 ${t.count} 轮`);
        row.appendChild(badge);
        const pick = (e) => { e.preventDefault(); e.stopPropagation(); onPick?.(t); finish(t); };
        row.addEventListener("click", pick);
        const badgePick = (e) => { e.preventDefault(); e.stopPropagation(); onPick?.(t); finish(t); };
        badge.addEventListener("click", badgePick);
        cleanups.push(() => {
          row.removeEventListener("click", pick);
          badge.removeEventListener("click", badgePick);
          bubble.classList.remove(...PICK_CLS);
          badge.remove();
        });
      });

      bar.querySelector("[data-rw-cancel]").addEventListener("click", () => { onCancel?.(); finish(null); });
      bar.querySelector("[data-rw-list]").addEventListener("click", async () => { onListAll?.(); const picked = await showRewindTurnList({ turns }); if (picked) finish(picked); });
      rewindCleanup = () => cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} });
    });
  }

  function showRewindTurnList({ turns = [] } = {}) {
    return new Promise((resolve) => {
      const card = div("rounded-xl bg-zinc-950/3 p-2.5 ring-1 ring-zinc-950/8 dark:bg-white/3 dark:ring-white/10");
      const rows = turns.map((t, i) => {
        const flags = [t.hadWorkspaceEdit ? "含工作区修改" : "", t.hadRunCode ? "含设备运行" : "", t.status && t.status !== "closed" ? t.status : ""].filter(Boolean).join(" · ");
        return `<button type="button" data-rw-i="${i}" class="w-full rounded-lg bg-white px-2.5 py-1.5 text-left text-xs text-zinc-700 ring-1 ring-zinc-950/6 transition-colors hover:ring-blue-500/40 dark:bg-white/5 dark:text-zinc-200 dark:ring-white/10"><span class="font-medium text-zinc-900 dark:text-zinc-100">最近第 ${t.count} 轮</span><span class="ml-2">${esc(summarizeTurn(t))}</span>${flags ? `<div class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">${esc(flags)}</div>` : ""}</button>`;
      }).join("");
      card.innerHTML =
        `<div class="text-xs font-medium text-zinc-900 dark:text-zinc-100">所有可回退回合</div>` +
        `<div class="m3e-scroll mt-2 flex max-h-72 flex-col gap-1.5 overflow-y-auto">${rows}</div>` +
        `<button type="button" data-rw-close class="mt-2 rounded-lg px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-200">关闭</button>`;
      append(card);
      const finish = (turn) => { card.remove(); resolve(turn || null); };
      card.addEventListener("click", (e) => {
        const i = e.target.closest?.("[data-rw-i]")?.getAttribute("data-rw-i");
        if (i != null) finish(turns[+i]);
        else if (e.target.closest?.("[data-rw-close]")) finish(null);
      });
    });
  }

  function confirmRewind({ turn, count, hasRunCode, hasWorkspaceSnapshot = true } = {}) {
    const detail = [
      `将回退最近 ${count || turn?.count || 1} 轮对话。`,
      hasWorkspaceSnapshot ? "默认同时恢复工作区。" : "该回合缺少工作区快照，只能仅回退聊天。",
      hasRunCode ? "注意：已经下发到设备运行的副作用无法撤销。" : "",
    ].filter(Boolean).join("\n");
    return ask({
      question: `确认回退到「${summarizeTurn(turn)}」之前？\n${detail}`,
      options: [
        { label: "对话 + 工作区", description: hasWorkspaceSnapshot ? "回退聊天并恢复 Blockly 工作区" : "缺少工作区快照，不可用" },
        { label: "仅对话", description: "只回退聊天、任务清单和模型上下文" },
        { label: "取消", description: "不改变当前状态" },
      ],
    }).then((v) => v === "对话 + 工作区" && hasWorkspaceSnapshot ? "both" : v === "仅对话" ? "chat" : null);
  }

  // ---- header / status helpers ----
  const setBoard = (text, cls = "") => {
    const label = text.replace(/^[●⚠]\s*/, "");
    const dot = cls === "ok" ? "bg-emerald-500" : cls === "err" ? "bg-red-500" : "bg-zinc-400 dark:bg-zinc-500";
    const tone = cls === "ok" ? "text-emerald-600 dark:text-emerald-400" : cls === "err" ? "text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400";
    boardEl.className = `inline-flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums ${tone}`;
    boardEl.innerHTML = `<span class="size-1.5 shrink-0 rounded-full ${dot}"></span><span>${esc(label)}</span>`;
  };
  const setStatus = (m, cls = "") => {
    statusEl.classList.toggle("hidden", !m);
    statusEl.className = `mb-1.5 text-xs tabular-nums ${cls === "err" ? "text-red-600 dark:text-red-400" : cls === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500"} ${m ? "" : "hidden"}`;
    statusEl.textContent = m || "";
  };
  const setBusy = (b) => {
    sendBtn.disabled = b;
    sendBtn.classList.toggle("hidden", b);
    stopBtn.classList.toggle("hidden", !b);
    stopBtn.classList.toggle("grid", b);
  };
  // ---- form: drawer ⇄ floating window (persisted under m3e_*) ----
  const LS = globalThis.localStorage;
  const readLS = (k, d) => { try { return LS?.getItem("m3e_" + k) ?? d; } catch { return d; } };
  const writeLS = (k, v) => { try { LS?.setItem("m3e_" + k, v); } catch {} };
  const MINW = 320, MINH = 360;
  const DRAWER_CLASSES = ["inset-y-0", "right-0", "w-96", "shadow-[-8px_0_32px_rgba(0,0,0,.15)]", "dark:shadow-none"];
  const FLOAT_CLASSES = ["rounded-2xl", "shadow-2xl", "dark:shadow-none"];

  let dock = readLS("dock", "drawer") === "float" ? "float" : "drawer";
  let geom = (() => {
    const def = { w: 400, h: 560, x: -1, y: 64 };
    let g = def;
    try { g = { ...def, ...JSON.parse(readLS("float", "")) }; } catch {}
    for (const k of ["w", "h", "x", "y"]) { const n = +g[k]; g[k] = Number.isFinite(n) ? n : def[k]; }
    return g;
  })();
  const clampGeom = () => {
    const vw = globalThis.innerWidth || 1280, vh = globalThis.innerHeight || 800;
    geom.w = Math.min(Math.max(geom.w, MINW), vw - 16);
    geom.h = Math.min(Math.max(geom.h, MINH), vh - 16);
    if (geom.x < 0) geom.x = vw - geom.w - 16;
    geom.x = Math.min(Math.max(geom.x, 8), Math.max(8, vw - geom.w - 8));
    geom.y = Math.min(Math.max(geom.y, 8), Math.max(8, vh - geom.h - 8));
  };
  const applyFloatGeom = () => {
    clampGeom();
    Object.assign(wrap.style, { left: geom.x + "px", top: geom.y + "px", width: geom.w + "px", height: geom.h + "px", right: "auto", bottom: "auto" });
  };
  const applyDock = () => {
    if (dock === "float") {
      wrap.classList.remove(...DRAWER_CLASSES);
      wrap.classList.add(...FLOAT_CLASSES);
      applyFloatGeom();
      header.classList.add("cursor-move", "select-none");
      resizeHandle.classList.remove("hidden");
      dockBtn.innerHTML = ICON.dock;
      dockBtn.title = dockBtn.ariaLabel = "停靠到右侧";
    } else {
      wrap.classList.remove(...FLOAT_CLASSES);
      wrap.classList.add(...DRAWER_CLASSES);
      for (const p of ["left", "top", "width", "height", "right", "bottom"]) wrap.style[p] = "";
      header.classList.remove("cursor-move", "select-none");
      resizeHandle.classList.add("hidden");
      dockBtn.innerHTML = ICON.float;
      dockBtn.title = dockBtn.ariaLabel = "切换为浮窗";
    }
  };
  const toggleDock = () => { dock = dock === "float" ? "drawer" : "float"; writeLS("dock", dock); applyDock(); };

  // Drag (float only): header is the handle; ignore drags that start on buttons.
  header.addEventListener("pointerdown", (e) => {
    if (dock !== "float" || e.button !== 0 || e.target.closest("button")) return;
    const sx = e.clientX, sy = e.clientY, ox = geom.x, oy = geom.y;
    header.setPointerCapture(e.pointerId);
    const move = (ev) => { geom.x = ox + (ev.clientX - sx); geom.y = oy + (ev.clientY - sy); applyFloatGeom(); };
    const up = () => { header.removeEventListener("pointermove", move); header.removeEventListener("pointerup", up); writeLS("float", JSON.stringify(geom)); };
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", up);
  });

  // Resize (float only): bottom-right handle.
  resizeHandle.addEventListener("pointerdown", (e) => {
    if (dock !== "float" || e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ow = geom.w, oh = geom.h;
    resizeHandle.setPointerCapture(e.pointerId);
    const move = (ev) => { geom.w = ow + (ev.clientX - sx); geom.h = oh + (ev.clientY - sy); applyFloatGeom(); };
    const up = () => { resizeHandle.removeEventListener("pointermove", move); resizeHandle.removeEventListener("pointerup", up); writeLS("float", JSON.stringify(geom)); };
    resizeHandle.addEventListener("pointermove", move);
    resizeHandle.addEventListener("pointerup", up);
  });

  globalThis.addEventListener?.("resize", () => { if (dock === "float") applyFloatGeom(); });

  let hidden = false;
  const setHidden = (h) => {
    hidden = h;
    if (dock === "float") {
      wrap.style.opacity = h ? "0" : "1";
      wrap.style.transform = h ? "scale(.96)" : "scale(1)";
      wrap.style.pointerEvents = h ? "none" : "";
    } else {
      wrap.style.opacity = ""; wrap.style.pointerEvents = ""; wrap.style.transform = h ? "translateX(100%)" : "translateX(0)";
    }
    launcher.classList.toggle("hidden", !h);
  };
  const setGenerateEnabled = (en) => { sendBtn.disabled = !en; sendBtn.style.opacity = en ? "1" : ".5"; };
  // Theme: follows the HOST SITE (not OS). main.mjs reads the site's night flag and
  // calls this; toggling `.dark` on `.m3e` makes all `dark:` utilities apply.
  const setDark = (on) => { m3eRoot.classList.toggle("dark", !!on); };

  applyDock();

  // ---- empty-state hint (shown until the first message is appended) ----
  const emptyHint = div("m-auto max-w-[28ch] text-center text-xs text-zinc-400 dark:text-zinc-500",
    "用中文描述需求或提问，例如「按 A 键显示温度」。<br>输入 <code class=\"rounded bg-zinc-950/8 px-1 py-0.5 dark:bg-white/10\">/help</code> 查看命令。");
  feed.appendChild(emptyHint);
  function dropHint() { if (emptyHint.isConnected) emptyHint.remove(); }

  // ---- input handling ----
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    opts.onSend?.({ text });
  }

  ["keydown", "keyup", "keypress"].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  root.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "t" || e.key === "T") && lastTodos.length) {
      e.preventDefault(); todoExpanded = !todoExpanded; renderProgress();
    }
  });

  root.addEventListener("click", (e) => {
    const act = e.target.closest?.("[data-act]")?.getAttribute("data-act");
    if (act === "toggle") setHidden(true);
    else if (act === "reopen") setHidden(false);
    else if (act === "dock") toggleDock();
    else if (act === "settings") settings.classList.toggle("hidden");
    else if (act === "send") submit();
    else if (act === "stop") opts.onStop?.();
    else if (act === "saveCfg") {
      const c = {};
      root.querySelectorAll("[data-cfg]").forEach((i) => { c[i.getAttribute("data-cfg")] = i.value.trim(); });
      opts.onSaveConfig?.(c);
      settings.classList.add("hidden");
    }
  });

  function loadConfig(c) {
    root.querySelectorAll("[data-cfg]").forEach((i) => { i.value = c[i.getAttribute("data-cfg")] || ""; });
  }

  return {
    host, root,
    // view primitives
    addUser, notice, beginAssistant, toolCard, setTodos, confirm, ask,
    feedMark, restoreFeedMark, enterRewindMode, exitRewindMode, showRewindTurnList, confirmRewind,
    // header / status
    setBoard, setStatus, setBusy, setHidden, setGenerateEnabled, setDark, loadConfig,
    openSettings: () => settings.classList.remove("hidden"),
    clearFeed: () => { feed.innerHTML = ""; setTodos([]); feed.appendChild(emptyHint); },
    focusInput: () => input.focus(),
  };
}
