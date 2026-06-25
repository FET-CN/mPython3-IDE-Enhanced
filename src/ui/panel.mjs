// src/ui/panel.mjs — Shadow-DOM chat drawer injected into the host page. Fully
// style-isolated; styling is precompiled Tailwind (PANEL_CSS) inlined into the
// shadow <style>. This is a pure view: it renders messages / tool cards / a todo
// list / a streaming assistant bubble / confirm prompts, and emits callbacks
// (onSend, onUndo, onStop, onSaveConfig) that main.mjs wires to the agent loop.
//
// Design follows the uidotsh guidelines for an always-dark application UI: zinc
// palette, ring/opacity separation (not solid gray borders), recessed wells for
// logs/output, one primary button, tabular-nums for counts.

import { PANEL_CSS } from "./styles.generated.mjs";

const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="size-[17px]"><circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.4 2.6 2.9-.6.6 2.9 2.6 1.4-1.5 2.5 1.5 2.5-2.6 1.4-.6 2.9-2.9-.6L12 21.5l-1.4-2.6-2.9.6-.6-2.9-2.6-1.4 1.5-2.5L4 9.7l2.6-1.4.6-2.9 2.9.6z"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="size-[17px]"><path d="M7 6l6 6-6 6M13 6l6 6-6 6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" class="size-3.5"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/** Minimal, safe markdown: fenced code blocks, inline code, paragraphs. */
function renderMarkdown(text) {
  const parts = String(text).split(/```(\w*)\n?([\s\S]*?)```/g);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i];
    if (prose) {
      html += prose
        .split(/\n{2,}/)
        .map((p) => `<p>${inlineMd(p)}</p>`)
        .join("");
    }
    const code = parts[i + 2];
    if (code != null) html += `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
  }
  return html;
}
function inlineMd(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code class="rounded bg-white/10 px-1 py-0.5 text-[12px]">$1</code>').replace(/\n/g, "<br>");
}

export function createPanel(opts = {}) {
  const doc = document;
  const host = doc.createElement("div");
  host.id = "m3e-panel-host";
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <style>${PANEL_CSS}</style>
    <div class="m3e">
      <button data-act="reopen" class="m3e-launcher fixed right-0 top-[46%] z-[2147483600] hidden rounded-l-xl bg-blue-600 px-2 py-3.5 font-semibold tracking-[3px] text-white shadow-lg [writing-mode:vertical-rl] hover:bg-blue-500">AI 编程</button>
      <div data-wrap class="m3e-wrap fixed right-0 top-0 z-[2147483600] flex h-[100dvh] w-96 flex-col bg-zinc-950 text-zinc-100 antialiased shadow-[-8px_0_32px_rgba(0,0,0,.5)] outline outline-1 outline-white/10 transition-transform duration-200">
        <header class="flex items-center gap-2 border-b border-white/10 bg-zinc-900 px-3 py-2.5">
          <b class="flex-1 text-sm font-semibold tracking-tight">AI 图形化编程</b>
          <span data-board class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/5 px-2 py-1 text-[11.5px] tabular-nums text-zinc-400">检测中…</span>
          <button data-act="settings" title="设置" aria-label="设置" class="grid size-[30px] place-items-center rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-100">${ICON.gear}</button>
          <button data-act="toggle" title="收起" aria-label="收起" class="grid size-[30px] place-items-center rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-100">${ICON.collapse}</button>
        </header>

        <div data-feed class="m3e-scroll flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3.5 text-[13px] leading-relaxed"></div>

        <div data-settings class="hidden flex-col gap-2.5 border-t border-white/10 bg-zinc-900 px-3 py-3">
          <label class="text-xs text-zinc-400" for="m3e-base">LLM Base URL（OpenAI 兼容）</label>
          <input id="m3e-base" name="baseURL" data-cfg="baseURL" placeholder="https://api.deepseek.com/v1" class="rounded-lg bg-black/40 px-2.5 py-2 text-[12.5px] text-zinc-100 outline-1 ring-1 ring-white/10 placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:outline-blue-500">
          <label class="text-xs text-zinc-400" for="m3e-key">API Key</label>
          <input id="m3e-key" name="apiKey" data-cfg="apiKey" type="password" placeholder="sk-..." class="rounded-lg bg-black/40 px-2.5 py-2 text-[12.5px] text-zinc-100 ring-1 ring-white/10 placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:outline-blue-500">
          <label class="text-xs text-zinc-400" for="m3e-model">模型</label>
          <input id="m3e-model" name="model" data-cfg="model" placeholder="deepseek-chat" class="rounded-lg bg-black/40 px-2.5 py-2 text-[12.5px] text-zinc-100 ring-1 ring-white/10 placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:outline-blue-500">
          <button data-act="saveCfg" type="button" class="mt-1 self-end rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500">保存设置</button>
        </div>

        <div class="border-t border-white/10 bg-zinc-950 px-3 py-2.5">
          <div data-status class="mb-1.5 hidden text-[11.5px] tabular-nums text-zinc-500"></div>
          <div class="flex items-end gap-2">
            <textarea data-input rows="2" placeholder="描述需求或提问，例如：按A键显示温度 / 把刚才那块改成红色（/help 查看命令）" class="m3e-scroll max-h-40 flex-1 resize-none rounded-xl bg-zinc-900 px-3 py-2 text-[13px] leading-relaxed text-zinc-100 ring-1 ring-white/10 placeholder:text-zinc-500 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-500"></textarea>
            <button data-act="send" type="button" title="发送" class="grid size-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white hover:bg-blue-500 disabled:bg-white/5 disabled:text-zinc-600">${ICON.send}</button>
            <button data-act="stop" type="button" title="停止" class="hidden size-9 shrink-0 place-items-center rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10">${ICON.stop}</button>
          </div>
        </div>
      </div>
    </div>`;
  doc.body.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const wrap = $("[data-wrap]");
  const launcher = $("[data-act='reopen']");
  const feed = $("[data-feed]");
  const input = $("[data-input]");
  const statusEl = $("[data-status]");
  const boardEl = $("[data-board]");
  const sendBtn = $("[data-act='send']");
  const stopBtn = $("[data-act='stop']");
  const settings = $("[data-settings]");

  const scrollToEnd = () => { feed.scrollTop = feed.scrollHeight; };
  const append = (el) => { feed.appendChild(el); scrollToEnd(); return el; };
  const div = (cls, html) => { const d = doc.createElement("div"); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };

  // ---- message primitives ----

  function addUser(text) {
    const row = div("flex justify-end");
    row.appendChild(div("max-w-[85%] whitespace-pre-wrap rounded-2xl bg-blue-600 px-3 py-2 text-[13px] text-white", esc(text)));
    return append(row);
  }

  function notice(text, kind = "") {
    const tone = kind === "err" ? "text-red-400" : kind === "ok" ? "text-emerald-400" : "text-zinc-500";
    return append(div(`text-center text-[11.5px] ${tone}`, esc(text)));
  }

  function beginAssistant() {
    const bubble = div("m3e-prose m3e-caret max-w-full text-[13px] text-zinc-100");
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

  /** A tool-call card (think / search / edit / run / todos). */
  function toolCard({ icon = "·", title, body = "", tone = "" }) {
    const ring = tone === "err" ? "ring-red-500/30" : tone === "ok" ? "ring-emerald-500/25" : "ring-white/10";
    const card = div(`rounded-lg bg-zinc-900/60 p-2.5 ring-1 ${ring}`);
    card.innerHTML =
      `<div class="flex items-center gap-1.5 text-[12px] font-medium text-zinc-300"><span class="text-zinc-500">${esc(icon)}</span><span>${esc(title)}</span></div>` +
      (body ? `<div data-body class="mt-1 text-[12px] text-zinc-400"></div>` : "");
    if (body) card.querySelector("[data-body]").textContent = body;
    append(card);
    return {
      el: card,
      setBody(text, mono = false) {
        let b = card.querySelector("[data-body]");
        if (!b) { b = div("mt-1 text-[12px] text-zinc-400"); card.appendChild(b); }
        b.className = mono ? "mt-1 m3e-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-black/40 p-2 font-mono text-[11px] text-zinc-300" : "mt-1 text-[12px] text-zinc-400";
        b.textContent = text;
        scrollToEnd();
      },
      setTone(t) {
        card.className = `rounded-lg bg-zinc-900/60 p-2.5 ring-1 ${t === "err" ? "ring-red-500/30" : t === "ok" ? "ring-emerald-500/25" : "ring-white/10"}`;
      },
    };
  }

  /** Render/refresh the task checklist as a single card kept at a stable node. */
  let todoCard = null;
  function setTodos(todos) {
    if (!todos || !todos.length) { todoCard?.el.remove(); todoCard = null; return; }
    const mark = { completed: "✓", in_progress: "▸", pending: "○" };
    const color = { completed: "text-emerald-400", in_progress: "text-blue-400", pending: "text-zinc-500" };
    const rows = todos
      .map((t) => `<div class="flex items-start gap-1.5 text-[12px] ${t.status === "completed" ? "text-zinc-500 line-through" : "text-zinc-300"}"><span class="${color[t.status]}">${mark[t.status] || "○"}</span><span>${esc(t.title)}</span></div>`)
      .join("");
    const html = `<div class="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">任务清单</div>${rows}`;
    if (!todoCard) { todoCard = { el: append(div("rounded-lg bg-zinc-900/60 p-2.5 ring-1 ring-white/10")) }; }
    todoCard.el.innerHTML = html;
    scrollToEnd();
  }

  /** Inline confirmation card → resolves 'once' | 'session' | false. */
  function confirm({ title, detail }) {
    return new Promise((resolve) => {
      const card = div("rounded-lg bg-amber-500/10 p-2.5 ring-1 ring-amber-500/30");
      card.innerHTML =
        `<div class="text-[12.5px] font-medium text-amber-200">${esc(title)}</div>` +
        (detail ? `<div class="mt-1 text-[12px] text-zinc-300">${esc(detail)}</div>` : "") +
        `<div class="mt-2 flex gap-2">
          <button data-c="once" class="rounded-lg bg-blue-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-blue-500">允许一次</button>
          <button data-c="session" class="rounded-lg bg-white/5 px-2.5 py-1 text-[12px] text-zinc-200 hover:bg-white/10">本会话允许</button>
          <button data-c="no" class="rounded-lg bg-white/5 px-2.5 py-1 text-[12px] text-zinc-300 hover:bg-white/10">拒绝</button>
        </div>`;
      append(card);
      card.addEventListener("click", (e) => {
        const c = e.target.closest?.("[data-c]")?.getAttribute("data-c");
        if (!c) return;
        card.querySelectorAll("button").forEach((b) => (b.disabled = true));
        const label = c === "once" ? "已允许一次" : c === "session" ? "本会话允许" : "已拒绝";
        card.className = "rounded-lg bg-zinc-900/60 p-2.5 ring-1 ring-white/10";
        card.innerHTML = `<div class="text-[12px] text-zinc-400">${esc(title)} — ${label}</div>`;
        resolve(c === "no" ? false : c);
      });
    });
  }

  // ---- header / status helpers ----
  const setBoard = (text, cls = "") => {
    boardEl.textContent = text.replace(/^[●⚠]\s*/, "");
    boardEl.className = `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-[11.5px] tabular-nums ${cls === "ok" ? "bg-emerald-500/15 text-emerald-300" : cls === "err" ? "bg-red-500/15 text-red-300" : "bg-white/5 text-zinc-400"}`;
  };
  const setStatus = (m, cls = "") => {
    statusEl.classList.toggle("hidden", !m);
    statusEl.className = `mb-1.5 text-[11.5px] tabular-nums ${cls === "err" ? "text-red-400" : cls === "ok" ? "text-emerald-400" : "text-zinc-500"} ${m ? "" : "hidden"}`;
    statusEl.textContent = m || "";
  };
  const setBusy = (b) => {
    sendBtn.disabled = b;
    sendBtn.classList.toggle("hidden", b);
    stopBtn.classList.toggle("hidden", !b);
    stopBtn.classList.toggle("grid", b);
  };
  const setHidden = (h) => { wrap.style.transform = h ? "translateX(100%)" : "translateX(0)"; launcher.classList.toggle("hidden", !h); };
  const setGenerateEnabled = (en) => { sendBtn.disabled = !en; sendBtn.style.opacity = en ? "1" : ".5"; };

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

  root.addEventListener("click", (e) => {
    const act = e.target.closest?.("[data-act]")?.getAttribute("data-act");
    if (act === "toggle") setHidden(true);
    else if (act === "reopen") setHidden(false);
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
    addUser, notice, beginAssistant, toolCard, setTodos, confirm,
    // header / status
    setBoard, setStatus, setBusy, setHidden, setGenerateEnabled, loadConfig,
    openSettings: () => settings.classList.remove("hidden"),
    clearFeed: () => { feed.innerHTML = ""; todoCard = null; },
    focusInput: () => input.focus(),
  };
}
