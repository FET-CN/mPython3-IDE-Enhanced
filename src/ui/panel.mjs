// src/ui/panel.mjs — Shadow-DOM chat panel injected into the host page. Fully
// style-isolated; styling is precompiled Tailwind (PANEL_CSS) inlined into the
// shadow <style>. This is a pure view: it renders messages / tool cards / a todo
// list / a streaming assistant bubble / confirm prompts, and emits callbacks
// (onSend, onUndo, onStop, onSaveConfig) that main.mjs wires to the agent loop.
//
// Form: a right-edge drawer that can flip to a draggable, resizable floating
// window (dock state + geometry persisted under m3e_* localStorage). Theme:
// light base + dark via prefers-color-scheme (Tailwind dark: variants). Tool
// cards expand while running and collapse to a one-line status when done. The
// task checklist lives in a fixed progress strip above the composer (Alt+T
// toggles it). Design follows the uidotsh guidelines: zinc palette, ring/opacity
// separation, recessed wells for logs, one primary button, tabular-nums.

import { PANEL_CSS } from "./styles.generated.mjs";

// A single unified SVG icon registry — no unicode emoji anywhere in the UI.
// Header glyphs keep their bespoke sizes; tool/status glyphs share `m3e-ic`
// (size-[14px], currentColor) so they line up with the 12px card text.
const ic = (body, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="m3e-ic size-[14px] shrink-0 inline-block align-[-2px] ${extra}">${body}</svg>`;

const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="size-[17px] shrink-0"><circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.4 2.6 2.9-.6.6 2.9 2.6 1.4-1.5 2.5 1.5 2.5-2.6 1.4-.6 2.9-2.9-.6L12 21.5l-1.4-2.6-2.9.6-.6-2.9-2.6-1.4 1.5-2.5L4 9.7l2.6-1.4.6-2.9 2.9.6z"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="size-[17px] shrink-0"><path d="M7 6l6 6-6 6M13 6l6 6-6 6"/></svg>',
  // dock toggles: `float` shows when docked (offers floating), `dock` when floating.
  float: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="size-[17px] shrink-0"><rect x="8" y="8" width="12" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  dock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="size-[17px] shrink-0"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M14 4v16"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4 shrink-0"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" class="size-3.5 shrink-0"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  // chevron used by collapsible cards / progress strip (rotated via class)
  chevron: ic('<path d="M9 6l6 6-6 6"/>'),
  // tool icons
  read: ic('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 1 4 17.5z"/><path d="M11 4h7.5A1.5 1.5 0 0 1 20 5.5v12a1.5 1.5 0 0 1-1.5 1.5H11"/><path d="M7 8h1.5M7 11h1.5M14 8h2.5M14 11h2.5"/>'),
  search: ic('<circle cx="11" cy="11" r="6"/><path d="m20 20-3.4-3.4"/>'),
  edit: ic('<path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/>'),
  run: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" class="m3e-ic size-[14px] shrink-0 inline-block align-[-2px]"><path d="M7 5.5v13l11-6.5z"/></svg>',
  think: ic('<path d="M9.5 16.5h5M10.5 19h3"/><path d="M12 3a6 6 0 0 0-3.7 10.7c.6.5.95 1.1.95 1.8h5.5c0-.7.35-1.3.95-1.8A6 6 0 0 0 12 3z"/>'),
  todos: ic('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>'),
  help: ic('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2-2.4 3.6"/><path d="M12 17.5h.01"/>'),
  // confirmation prompt for device/workspace-mutating actions
  alert: ic('<path d="M12 3.2 1.8 20.5h20.4z"/><path d="M12 10v4.5"/><path d="M12 17.6h.01"/>'),
  // todo-status icons
  check: ic('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  running: ic('<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" stroke="none"/>'),
  pending: ic('<circle cx="12" cy="12" r="7.5"/>'),
};

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/** Lightweight, safe Markdown → HTML. Handles fenced code blocks at the top
 *  level; within prose: ATX headings, blockquotes, ordered/unordered lists,
 *  horizontal rules, paragraphs, and inline spans (code/bold/italic/strike/link).
 *  All text is HTML-escaped before any markup is introduced. */
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
  let list = null; // { tag: 'ul'|'ol', items: [] }
  let quote = null; // string[]
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
      const size = lvl <= 1 ? "text-[15px]" : lvl === 2 ? "text-[14px]" : "text-[13px]";
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

/** Inline spans on a single text run. Escapes first, then layers markup. */
function inlineMd(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code class="rounded bg-zinc-950/8 px-1 py-0.5 text-[12px] dark:bg-white/10">$1</code>');
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300">$1</a>');
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return h;
}

export function createPanel(opts = {}) {
  const doc = document;
  const host = doc.createElement("div");
  host.id = "m3e-panel-host";
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <style>${PANEL_CSS}</style>
    <div class="m3e isolate">
      <button data-act="reopen" class="m3e-launcher pointer-events-auto absolute right-0 top-[46%] hidden rounded-l-xl bg-zinc-900 px-2 py-3.5 text-[12px] font-semibold tracking-[3px] text-white shadow-lg hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white [writing-mode:vertical-rl]">AI 编程</button>
      <div data-wrap class="m3e-wrap pointer-events-auto absolute flex flex-col overflow-hidden bg-white text-zinc-900 antialiased outline outline-1 outline-zinc-950/10 transition-[transform,opacity] duration-200 dark:bg-zinc-950 dark:text-zinc-100 dark:outline-white/10">
        <header data-drag class="flex items-center gap-1.5 border-b border-zinc-950/[.06] px-3 py-2.5 dark:border-white/[.08]">
          <b class="flex-1 truncate text-[13px] font-semibold tracking-tight">AI 图形化编程</b>
          <span data-board class="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] tabular-nums text-zinc-500 dark:text-zinc-400"><span class="size-1.5 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-500"></span><span>检测中…</span></span>
          <button data-act="dock" type="button" title="切换浮窗/停靠" aria-label="切换浮窗/停靠" class="grid size-[30px] place-items-center rounded-lg text-zinc-400 hover:bg-zinc-950/5 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200">${ICON.float}</button>
          <button data-act="settings" type="button" title="设置" aria-label="设置" class="grid size-[30px] place-items-center rounded-lg text-zinc-400 hover:bg-zinc-950/5 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200">${ICON.gear}</button>
          <button data-act="toggle" type="button" title="收起" aria-label="收起" class="grid size-[30px] place-items-center rounded-lg text-zinc-400 hover:bg-zinc-950/5 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200">${ICON.collapse}</button>
        </header>

        <div data-feed class="m3e-scroll flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3.5 text-[13px] leading-relaxed"></div>

        <div data-settings class="hidden flex-col gap-2.5 border-t border-zinc-950/[.06] bg-zinc-50 px-3 py-3 dark:border-white/[.08] dark:bg-white/[.02]">
          <label class="text-xs text-zinc-500 dark:text-zinc-400" for="m3e-base">LLM Base URL（OpenAI 兼容）</label>
          <input id="m3e-base" name="baseURL" data-cfg="baseURL" placeholder="https://api.deepseek.com/v1" class="rounded-lg bg-white px-2.5 py-2 text-[12.5px] text-zinc-900 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-black/40 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500">
          <label class="text-xs text-zinc-500 dark:text-zinc-400" for="m3e-key">API Key</label>
          <input id="m3e-key" name="apiKey" data-cfg="apiKey" type="password" placeholder="sk-..." class="rounded-lg bg-white px-2.5 py-2 text-[12.5px] text-zinc-900 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-black/40 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500">
          <label class="text-xs text-zinc-500 dark:text-zinc-400" for="m3e-model">模型</label>
          <input id="m3e-model" name="model" data-cfg="model" placeholder="deepseek-chat" class="rounded-lg bg-white px-2.5 py-2 text-[12.5px] text-zinc-900 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-black/40 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500">
          <label class="text-xs text-zinc-500 dark:text-zinc-400" for="m3e-serial">串口代理地址（Firefox 等用，留空则用浏览器原生）</label>
          <input id="m3e-serial" name="serialProxy" data-cfg="serialProxy" placeholder="ws://127.0.0.1:8765" class="rounded-lg bg-white px-2.5 py-2 text-[12.5px] text-zinc-900 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-black/40 dark:text-zinc-100 dark:ring-white/10 dark:placeholder:text-zinc-500">
          <button data-act="saveCfg" type="button" class="mt-1 self-end rounded-lg bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">保存设置</button>
        </div>

        <div class="border-t border-zinc-950/[.06] dark:border-white/[.08]">
          <div data-progress class="hidden border-b border-zinc-950/[.06] dark:border-white/[.08]"></div>
          <div class="px-3 py-2.5">
            <div data-status class="mb-1.5 hidden text-[11.5px] tabular-nums text-zinc-500 dark:text-zinc-500"></div>
            <div class="flex items-end gap-2">
              <textarea data-input rows="2" placeholder="描述需求或提问，例如：按A键显示温度 / 把刚才那块改成红色（/help 查看命令）" class="m3e-scroll max-h-40 flex-1 resize-none rounded-xl bg-zinc-950/[.03] px-3 py-2 text-[13px] leading-relaxed text-zinc-900 ring-1 ring-zinc-950/[.07] placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500 dark:bg-white/[.04] dark:text-zinc-100 dark:ring-white/[.08] dark:placeholder:text-zinc-500"></textarea>
              <button data-act="send" type="button" title="发送" class="grid size-9 shrink-0 place-items-center rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:bg-zinc-950/5 disabled:text-zinc-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-white/5 dark:disabled:text-zinc-600">${ICON.send}</button>
              <button data-act="stop" type="button" title="停止" class="hidden size-9 shrink-0 place-items-center rounded-xl bg-zinc-950/5 text-zinc-600 hover:bg-zinc-950/10 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10">${ICON.stop}</button>
            </div>
          </div>
        </div>

        <div data-resize class="absolute bottom-0 right-0 hidden size-4 cursor-nwse-resize touch-none [clip-path:polygon(100%_0,100%_100%,0_100%)]"></div>
      </div>
    </div>`;
  doc.body.appendChild(host);

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

  // ---- message primitives ----

  function addUser(text) {
    const row = div("flex justify-end");
    row.appendChild(div("max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-zinc-900 px-3 py-2 text-[13px] text-white dark:bg-zinc-100 dark:text-zinc-900", esc(text)));
    return append(row);
  }

  function notice(text, kind = "") {
    const tone = kind === "err" ? "text-red-600 dark:text-red-400" : kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500";
    return append(div(`text-center text-[11.5px] ${tone}`, esc(text)));
  }

  function beginAssistant() {
    const bubble = div("m3e-prose m3e-caret max-w-full text-[13px] text-zinc-900 dark:text-zinc-100");
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

  // A quiet, borderless "resolved" row — used when an inline ask/confirm card
  // settles into its final one-line summary. No card chrome, just muted text.
  const settledCls = "rounded-lg px-2.5 py-2 text-[12px] text-zinc-500 dark:text-zinc-400";

  // Leading-icon tint per tool state (the only place tone shows — no ring/border).
  const toneIc = (tone = "") =>
    tone === "err" ? "text-red-500 dark:text-red-400"
    : tone === "ok" ? "text-emerald-500 dark:text-emerald-400"
    : "text-zinc-400 dark:text-zinc-500";

  /** A tool-call row (think / search / edit / run). `icon` is a key into the
   *  ICON registry; unknown keys fall back to the help glyph. Borderless: the
   *  whole header is a hover-highlighted row; the log well below expands while
   *  running and auto-collapses once `setTone` marks it done (ok/err). The header
   *  stays clickable to re-expand. Tone tints only the leading icon. */
  function toolCard({ icon = "help", title, body = "", tone = "" }) {
    const card = div("rounded-lg");
    card.innerHTML =
      `<button type="button" data-head class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium text-zinc-600 hover:bg-zinc-950/[.04] dark:text-zinc-300 dark:hover:bg-white/[.05]">` +
        `<span data-ic class="${toneIc(tone)}">${ICON[icon] || ICON.help}</span>` +
        `<span data-title class="flex-1 truncate">${esc(title)}</span>` +
        `<span data-chev class="text-zinc-300 transition-transform duration-150 dark:text-zinc-600">${ICON.chevron}</span>` +
      `</button>` +
      `<div data-wrapbody class="px-2 pb-1.5"><div data-body class="text-[12px] text-zinc-500 dark:text-zinc-400"></div></div>`;
    if (body) card.querySelector("[data-body]").textContent = body;
    append(card);

    const chev = card.querySelector("[data-chev]");
    const iconEl = card.querySelector("[data-ic]");
    const wrapBody = card.querySelector("[data-wrapbody]");
    let expanded = true;
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
          ? "m3e-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950/[.04] p-2.5 font-mono text-[11px] text-zinc-600 dark:bg-white/[.04] dark:text-zinc-300"
          : "text-[12px] text-zinc-500 dark:text-zinc-400";
        b.textContent = text;
        hasBody = text != null && text !== "";
        sync();
        scrollToEnd();
      },
      setTone(t) {
        iconEl.className = toneIc(t);
        // Done (ok/err) → collapse to the one-line header; running stays open.
        if (t === "ok" || t === "err") expanded = false;
        sync();
      },
    };
  }

  /** Task checklist → the fixed progress strip above the composer (not the feed).
   *  Hidden when empty. Collapsed by default to a one-line "✓done/total · current
   *  step" summary; click the header or press Alt+T to expand the full list. */
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
      `<button type="button" data-phead class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-zinc-950/[.03] dark:hover:bg-white/[.03]">` +
        `<span class="text-zinc-500 dark:text-zinc-500">${ICON.todos}</span>` +
        `<span class="shrink-0 font-medium tabular-nums text-zinc-700 dark:text-zinc-200">${done}/${todos.length}</span>` +
        (cur ? `<span class="flex-1 truncate text-zinc-500 dark:text-zinc-400">${esc(cur.title)}</span>` : `<span class="flex-1"></span>`) +
        `<span data-pchev class="text-zinc-400 transition-transform duration-150 dark:text-zinc-500 ${todoExpanded ? "rotate-90" : ""}">${ICON.chevron}</span>` +
      `</button>`;
    const rows = todos
      .map((t) => `<div class="flex items-start gap-1.5 text-[12px] ${t.status === "completed" ? "text-zinc-400 line-through dark:text-zinc-500" : "text-zinc-700 dark:text-zinc-300"}"><span class="${color[t.status] || "text-zinc-400"}">${mark[t.status] || ICON.pending}</span><span>${esc(t.title)}</span></div>`)
      .join("");
    const list = `<div data-plist class="m3e-scroll max-h-44 space-y-1 overflow-y-auto px-3 pb-2.5 ${todoExpanded ? "" : "hidden"}">${rows}</div>`;
    progress.innerHTML = head + list;
    progress.querySelector("[data-phead]").addEventListener("click", () => { todoExpanded = !todoExpanded; renderProgress(); });
  }
  function setTodos(todos) {
    lastTodos = Array.isArray(todos) ? todos : [];
    renderProgress();
  }

  /** Inline structured question → resolves to the chosen label (single) or an
   *  array of labels (multi), or null if dismissed. Mirrors the confirm card. */
  function ask({ question, options = [], multi = false }) {
    return new Promise((resolve) => {
      const card = div("rounded-xl bg-zinc-950/[.03] p-2.5 ring-1 ring-zinc-950/[.07] dark:bg-white/[.03] dark:ring-white/[.08]");
      const opts = options.map((o, i) => {
        const desc = o.description ? `<div class="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">${esc(o.description)}</div>` : "";
        return `<button type="button" data-o="${i}" aria-pressed="false" class="w-full rounded-lg bg-white px-2.5 py-1.5 text-left text-[12px] text-zinc-700 ring-1 ring-zinc-950/[.06] hover:ring-zinc-950/15 aria-pressed:bg-blue-500/10 aria-pressed:ring-blue-500/40 dark:bg-white/5 dark:text-zinc-200 dark:ring-white/10 dark:hover:ring-white/20 dark:aria-pressed:bg-blue-500/15 dark:aria-pressed:ring-blue-400/40"><span class="font-medium text-zinc-900 dark:text-zinc-100">${esc(o.label)}</span>${desc}</button>`;
      }).join("");
      card.innerHTML =
        `<div class="text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100">${esc(question)}</div>` +
        `<div data-opts class="mt-2 flex flex-col gap-1.5">${opts}</div>` +
        (multi ? `<button type="button" data-submit class="mt-2 self-end rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:bg-zinc-950/5 disabled:text-zinc-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-white/5 dark:disabled:text-zinc-600" disabled>提交</button>` : "");
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

  /** Inline confirmation card → resolves 'once' | 'session' | false. */
  function confirm({ title, detail }) {
    return new Promise((resolve) => {
      const card = div("rounded-xl bg-amber-500/[.08] p-2.5 ring-1 ring-amber-500/25 dark:bg-amber-400/[.06] dark:ring-amber-400/20");
      card.innerHTML =
        `<div class="flex items-start gap-1.5 text-[12.5px] font-medium text-amber-700 dark:text-amber-300"><span class="text-amber-500 dark:text-amber-400">${ICON.alert}</span><span class="flex-1">${esc(title)}</span></div>` +
        (detail ? `<div class="mt-1 pl-[22px] text-[12px] text-zinc-600 dark:text-zinc-300">${esc(detail)}</div>` : "") +
        `<div class="mt-2.5 flex gap-2">
          <button type="button" data-c="once" class="rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">允许一次</button>
          <button type="button" data-c="session" class="rounded-lg bg-zinc-950/[.05] px-2.5 py-1 text-[12px] text-zinc-700 hover:bg-zinc-950/10 dark:bg-white/5 dark:text-zinc-200 dark:hover:bg-white/10">本会话允许</button>
          <button type="button" data-c="no" class="ml-auto rounded-lg px-2.5 py-1 text-[12px] text-zinc-500 hover:bg-zinc-950/[.05] hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-200">拒绝</button>
        </div>`;
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

  // ---- header / status helpers ----
  const setBoard = (text, cls = "") => {
    const label = text.replace(/^[●⚠]\s*/, "");
    const dot = cls === "ok" ? "bg-emerald-500" : cls === "err" ? "bg-red-500" : "bg-zinc-400 dark:bg-zinc-500";
    const tone = cls === "ok" ? "text-emerald-600 dark:text-emerald-400" : cls === "err" ? "text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400";
    boardEl.className = `inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] tabular-nums ${tone}`;
    boardEl.innerHTML = `<span class="size-1.5 shrink-0 rounded-full ${dot}"></span><span>${esc(label)}</span>`;
  };
  const setStatus = (m, cls = "") => {
    statusEl.classList.toggle("hidden", !m);
    statusEl.className = `mb-1.5 text-[11.5px] tabular-nums ${cls === "err" ? "text-red-600 dark:text-red-400" : cls === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500"} ${m ? "" : "hidden"}`;
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
    // Sanitize: a corrupt/stale entry (NaN, non-number, wrong shape) must never
    // make the window collapse or fly off-screen — fall back per key to default.
    for (const k of ["w", "h", "x", "y"]) { const n = +g[k]; g[k] = Number.isFinite(n) ? n : def[k]; }
    return g;
  })();
  const clampGeom = () => {
    const vw = globalThis.innerWidth || 1280, vh = globalThis.innerHeight || 800;
    geom.w = Math.min(Math.max(geom.w, MINW), vw - 16);
    geom.h = Math.min(Math.max(geom.h, MINH), vh - 16);
    if (geom.x < 0) geom.x = vw - geom.w - 16; // first run: dock to right
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

  // Keep a floating window within the viewport on resize.
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
  // Theme: the panel follows the HOST SITE (not the OS). main.mjs reads the
  // site's night flag (host/hostBridge.watchNight) and calls this; we toggle the
  // `dark` class on the `.m3e` root so all `dark:` utilities + `.dark` rules apply.
  const setDark = (on) => { m3eRoot.classList.toggle("dark", !!on); };

  applyDock();

  // ---- empty-state hint (shown until the first message is appended) ----
  const emptyHint = div("m-auto max-w-[28ch] text-center text-[12.5px] text-zinc-400 dark:text-zinc-500",
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

  // Keep keystrokes inside the panel from reaching the host's global shortcuts.
  ["keydown", "keyup", "keypress"].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  // Alt+T toggles the progress strip (Ctrl+T is reserved by the browser).
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
    // header / status
    setBoard, setStatus, setBusy, setHidden, setGenerateEnabled, setDark, loadConfig,
    openSettings: () => settings.classList.remove("hidden"),
    clearFeed: () => { feed.innerHTML = ""; setTodos([]); feed.appendChild(emptyHint); },
    focusInput: () => input.focus(),
  };
}
