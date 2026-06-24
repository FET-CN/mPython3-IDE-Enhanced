// src/ui/panel.mjs — Shadow-DOM chat drawer injected into the host page. Fully
// style-isolated. Pure view: emits callbacks; main.mjs wires them to the
// pipeline. Visual language follows the uidotsh design guidelines adapted to an
// always-dark application UI: neutral (zinc) palette, ring/opacity separation
// instead of solid gray borders, recessed "well" surfaces for logs/output,
// compact buttons (one primary, the rest ghost), tabular-nums for counts.

const STYLE = `
:host{
  all:initial;
  --bg:#0c0c0e; --raised:#151517; --well:#08080a;
  --line:rgba(255,255,255,.08); --line-2:rgba(255,255,255,.12);
  --text:#ededf0; --muted:#a1a1aa; --faint:#71717a;
  --accent:#3b82f6; --accent-press:#2563eb;
  --ok:#34d399; --warn:#fbbf24; --err:#f87171;
  --r:10px;
}
*{box-sizing:border-box;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;}
.wrap{position:fixed;top:0;right:0;height:100dvh;width:384px;z-index:2147483600;
  background:var(--bg);color:var(--text);display:flex;flex-direction:column;
  box-shadow:-8px 0 32px rgba(0,0,0,.5);outline:1px solid var(--line);
  -webkit-font-smoothing:antialiased;transform:translateX(0);transition:transform .22s ease;}
.wrap.hidden{transform:translateX(392px);}

header{display:flex;align-items:center;gap:8px;padding:11px 12px;
  background:var(--raised);border-bottom:1px solid var(--line);}
header b{font-size:14px;font-weight:600;letter-spacing:.01em;flex:1;}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;line-height:1;
  padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.05);
  color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9;}
.badge.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent);}
.badge.err{color:var(--err);background:color-mix(in srgb,var(--err) 16%,transparent);}

button{cursor:pointer;border:none;border-radius:8px;padding:7px 12px;font-size:13px;
  font-weight:500;color:#fff;background:rgba(255,255,255,.06);transition:background .12s ease;}
button:hover{background:rgba(255,255,255,.1);}
button.primary{background:var(--accent);}
button.primary:hover{background:var(--accent-press);}
button.primary:disabled{background:rgba(255,255,255,.06);color:var(--faint);cursor:not-allowed;}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
button.ghost{background:transparent;color:var(--muted);padding:5px 9px;}
button.ghost:hover{background:rgba(255,255,255,.06);color:var(--text);}
button.xs{font-size:11.5px;padding:3px 8px;border-radius:7px;}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;
  width:30px;height:30px;padding:0;border-radius:8px;background:transparent;color:var(--muted);}
.icon-btn:hover{background:rgba(255,255,255,.07);color:var(--text);}
.icon-btn svg{width:17px;height:17px;display:block;stroke:currentColor;fill:none;
  stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;}

.body{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:11px;}
textarea{width:100%;min-height:76px;resize:vertical;border-radius:var(--r);
  border:1px solid var(--line-2);background:var(--well);color:var(--text);
  padding:9px 10px;font-size:13px;line-height:1.5;}
textarea::placeholder{color:var(--faint);}
textarea:focus-visible{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent;}
.row{display:flex;gap:8px;align-items:center;}

/* edit plan */
.plan{display:flex;flex-direction:column;gap:6px;}
.plan .item{background:var(--well);border-radius:9px;outline:1px solid var(--line);
  padding:8px 9px;display:flex;flex-direction:column;gap:6px;}
.plan .desc{font-size:12.5px;color:var(--text);line-height:1.45;}
.plan .desc .k{color:var(--faint);font:11px ui-monospace,monospace;}
.plan select{width:100%;border-radius:7px;border:1px solid var(--line-2);
  background:var(--bg);color:var(--text);padding:5px 7px;font-size:12px;}
.plan select:focus-visible{outline:2px solid var(--accent);outline-offset:-1px;}
.plan .lbl{font-size:11px;color:var(--muted);}

.muted{color:var(--faint);font-size:12px;}
[data-status]{font-variant-numeric:tabular-nums;}

/* recessed wells (logs / output) */
.well{background:var(--well);border-radius:var(--r);
  outline:1px solid var(--line);padding:9px 10px;}
.log{font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:pre-wrap;color:var(--muted);min-height:38px;max-height:150px;overflow:auto;
  font-variant-numeric:tabular-nums;}
.preview{font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:pre-wrap;color:#86efac;max-height:200px;overflow:auto;}

.err{color:var(--err);}
.ok{color:var(--ok);}
.warn{color:var(--warn);}

.settings{display:none;flex-direction:column;gap:9px;padding:12px;
  border-top:1px solid var(--line);background:var(--raised);}
.settings.show{display:flex;}
.settings input{width:100%;border-radius:8px;border:1px solid var(--line-2);
  background:var(--well);color:var(--text);padding:8px 9px;font-size:12.5px;}
.settings input:focus-visible{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent;}
label{font-size:12px;color:var(--muted);}

.launcher{position:fixed;top:46%;right:0;z-index:2147483600;display:none;
  writing-mode:vertical-rl;background:var(--accent);color:#fff;padding:14px 8px;
  border-radius:10px 0 0 10px;cursor:pointer;font-size:13px;font-weight:600;
  box-shadow:-3px 2px 14px rgba(0,0,0,.4);user-select:none;letter-spacing:3px;
  transition:background .12s ease;}
.launcher:hover{background:var(--accent-press);}
.launcher.show{display:block;}
`;

export function createPanel(opts) {
  const doc = document;
  const host = doc.createElement("div");
  host.id = "m3e-panel-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="launcher" data-act="reopen">AI 编程</div>
    <div class="wrap">
      <header>
        <b>AI 图形化编程</b>
        <span class="badge" data-board>检测中…</span>
        <button class="icon-btn" data-act="settings" title="设置" aria-label="设置">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.4 2.6 2.9-.6.6 2.9 2.6 1.4-1.5 2.5 1.5 2.5-2.6 1.4-.6 2.9-2.9-.6L12 21.5l-1.4-2.6-2.9.6-.6-2.9-2.6-1.4 1.5-2.5L4 9.7l2.6-1.4.6-2.9 2.9.6z"/></svg>
        </button>
        <button class="icon-btn" data-act="toggle" title="收起" aria-label="收起">
          <svg viewBox="0 0 24 24"><path d="M7 6l6 6-6 6M13 6l6 6-6 6"/></svg>
        </button>
      </header>
      <div class="body">
        <textarea placeholder="用中文描述你想做的修改，例如：按 A 键时在屏幕显示温度 / 删掉 RGB 那块"></textarea>
        <div class="row">
          <button class="ghost" data-act="undo">↶ 撤销</button>
          <span style="flex:1"></span>
          <button class="primary" data-act="gen">生成并应用</button>
        </div>
        <div class="row"><span class="muted" data-status></span></div>
        <div class="plan" data-plan style="display:none"></div>
        <div class="well log" data-log>就绪。</div>
        <div class="well preview" data-preview style="display:none"></div>
      </div>
      <div class="settings">
        <label>LLM Base URL (OpenAI 兼容)</label><input data-cfg="baseURL" placeholder="https://api.deepseek.com/v1">
        <label>API Key</label><input data-cfg="apiKey" type="password" placeholder="sk-...">
        <label>模型</label><input data-cfg="model" placeholder="deepseek-chat">
        <button class="primary" data-act="saveCfg">保存设置</button>
      </div>
    </div>`;
  doc.body.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const wrap = $(".wrap");
  const launcher = $(".launcher");
  const ta = $("textarea");
  const logEl = $("[data-log]");
  const statusEl = $("[data-status]");
  const previewEl = $("[data-preview]");
  const genBtn = $('[data-act="gen"]');
  const boardEl = $("[data-board]");
  const planEl = $("[data-plan]");

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const log = (m, cls = "") => { logEl.innerHTML += `\n${cls ? `<span class="${cls}">${esc(m)}</span>` : esc(m)}`; logEl.scrollTop = logEl.scrollHeight; };
  const setStatus = (m, cls = "") => { statusEl.className = "muted " + cls; statusEl.textContent = m; };
  const setBusy = (b) => { genBtn.disabled = b; genBtn.textContent = b ? "生成中…" : "生成并应用"; };
  const showPreview = (txt) => { previewEl.style.display = "block"; previewEl.textContent = txt; };
  const setHidden = (h) => { wrap.classList.toggle("hidden", h); launcher.classList.toggle("show", h); };
  const setBoard = (text, cls = "") => { boardEl.className = "badge " + cls; boardEl.textContent = text.replace(/^[●⚠]\s*/, ""); };
  const setGenerateEnabled = (en) => { genBtn.disabled = !en; genBtn.style.opacity = en ? "1" : ".5"; };

  /** Render the model's edit plan. `items`: [{ text, opIndex, anchor?: {options:[{key,label}], selectedKey} }].
   *  onAnchorChange(opIndex, key) is called when a落点 dropdown changes. */
  function setPlan(items, onAnchorChange) {
    planEl.innerHTML = "";
    if (!items || !items.length) { planEl.style.display = "none"; return; }
    planEl.style.display = "flex";
    for (const it of items) {
      const div = doc.createElement("div");
      div.className = "item";
      div.innerHTML = `<div class="desc">${it.text}</div>`;
      if (it.anchor) {
        const lbl = doc.createElement("div"); lbl.className = "lbl"; lbl.textContent = "落点";
        const sel = doc.createElement("select");
        for (const o of it.anchor.options) {
          const opt = doc.createElement("option");
          opt.value = o.key; opt.textContent = o.label;
          if (o.key === it.anchor.selectedKey) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener("change", () => onAnchorChange?.(it.opIndex, sel.value));
        div.appendChild(lbl); div.appendChild(sel);
      }
      planEl.appendChild(div);
    }
  }
  const clearPlan = () => { planEl.innerHTML = ""; planEl.style.display = "none"; };

  // Keep keystrokes typed inside our panel from reaching the host's global
  // shortcut handlers (Blockly deletes blocks on Backspace/Delete; because our
  // inputs live in a shadow DOM the host sees the host element, not a text
  // field, and would preventDefault the key). Stop them at the shadow root.
  ["keydown", "keyup", "keypress"].forEach((t) =>
    root.addEventListener(t, (e) => e.stopPropagation()));

  root.addEventListener("click", (e) => {
    const el = e.target.closest?.("[data-act]") || e.target;
    const act = el.getAttribute?.("data-act");
    if (act === "toggle") setHidden(true);
    if (act === "reopen") setHidden(false);
    if (act === "settings") $(".settings").classList.toggle("show");
    if (act === "gen") opts.onGenerate?.({ request: ta.value.trim() });
    if (act === "undo") opts.onUndo?.();
    if (act === "saveCfg") {
      const c = {};
      root.querySelectorAll("[data-cfg]").forEach((i) => { c[i.getAttribute("data-cfg")] = i.value.trim(); });
      opts.onSaveConfig?.(c);
      $(".settings").classList.remove("show");
    }
  });

  function loadConfig(c) {
    root.querySelectorAll("[data-cfg]").forEach((i) => { i.value = c[i.getAttribute("data-cfg")] || ""; });
  }

  return {
    host, root, log, setStatus, setBusy, showPreview, loadConfig, setHidden,
    setBoard, setGenerateEnabled, setPlan, clearPlan,
    clearLog: () => (logEl.textContent = ""),
  };
}
