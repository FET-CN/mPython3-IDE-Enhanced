// src/main.mjs — Entry point. Singleton-guards, detects the host, loads data,
// builds the panel, and wires: generate → lock → pipeline → inject → undo.

import { detectHost, isPythonMode } from "./host/hostBridge.mjs";
import { readWorkspaceIR } from "./host/read.mjs";
import { injectOps, snapshot, restore } from "./host/inject.mjs";
import { applyOps, anchorKey, anchorFromKey } from "./host/ops.mjs";
import { createLock } from "./host/lock.mjs";
import { createPanel } from "./ui/panel.mjs";
import { loadData, cfg } from "./runtime/data.mjs";
import { makeClient } from "./llm/client.mjs";
import { generateProgram } from "./pipeline.mjs";
import { boardFromMaster } from "./kb/knowledge.mjs";

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
    onGenerate: (req) => onGenerate(req),
    onUndo: () => onUndo(),
    onSaveConfig: (c) => { for (const k in c) cfg.set(k, c[k]); panel.setStatus("设置已保存", "ok"); },
  });
  panel.loadConfig(cfg.llm());
  const debugRounds = [];
  window.__m3e__ = { focus: () => panel.setHidden(false), panel, caps, debug: debugRounds };

  let data = null;
  let lastSnapshot = null;
  let lastGen = null; // { withIds, ops, anchors } for anchor re-application

  function currentBoard() {
    return boardFromMaster(window.localStorage.masterControl || caps.state().masterControl || "");
  }
  function refreshBoard() {
    const b = currentBoard();
    if (b.supported) {
      panel.setBoard("● " + b.label, "ok");
      panel.setGenerateEnabled(true);
    } else {
      panel.setBoard("⚠ " + b.label + "(不支持)", "err");
      panel.setGenerateEnabled(false);
    }
    return b;
  }
  refreshBoard();

  panel.log("正在加载积木知识库…");
  try {
    data = await loadData();
    panel.log(`已加载 ${data.index.length} 个积木 + 板子知识。`, "ok");
  } catch (e) {
    panel.log("加载知识库失败：" + e.message, "err");
  }

  function handleProgress(ev) {
    const msg = progressMsg(ev);
    if (msg) panel.log(msg, ev.phase === "validate" && !ev.ok ? "warn" : "");
    if (ev.phase === "validate" || ev.phase === "parse_error") {
      const round = {
        attempt: (ev.attempt ?? 0) + 1,
        ok: ev.phase === "validate" ? !!ev.ok : false,
        context: ev.context ?? null,
        raw: ev.raw ?? "",
        ir: ev.ir ?? null,
        errors: ev.report?.errors ?? (ev.detail ? [{ kind: ev.phase, detail: ev.detail }] : []),
      };
      debugRounds.push(round);
      logRound(round);
    }
  }

  async function onGenerate({ request }) {
    const board = refreshBoard();
    if (!board.supported) {
      panel.setStatus("请先把主控切到掌控板", "err");
      panel.log(`当前主控「${board.label}」不受支持。请在 IDE 左上角把主控切换到「掌控板」或「掌控板V3」后再生成。`, "err");
      return;
    }
    if (!request) { panel.setStatus("请先输入需求", "err"); return; }
    if (!data) { panel.setStatus("知识库未就绪", "err"); return; }
    const llm = cfg.llm();
    if (!llm.apiKey) { panel.setStatus("请在 ⚙ 设置里填写 API Key", "err"); return; }

    panel.setBusy(true);
    panel.clearLog();
    panel.clearPlan();
    debugRounds.length = 0;
    lock.lock();
    lastSnapshot = snapshot(caps);
    try {
      const client = makeClient({ ...llm, fetchImpl: window.fetch.bind(window) });
      const current = readWorkspaceIR(caps);
      const res = await generateProgram({
        request, master: board.master,
        index: data.index, catalog: data.catalog, seeds: data.seeds,
        knowledge: data.knowledge, currentProgram: current, client, maxRepairs: 2,
        onProgress: (ev) => handleProgress(ev),
      });
      if (!res.ok) {
        panel.log("生成未通过校验：\n" + (res.report?.errors || []).slice(0, 8).map((e) => "· " + e.detail).join("\n"), "err");
        panel.setStatus("失败，请重试或调整描述", "err");
        return;
      }
      lastGen = { withIds: res.withIds, ops: res.ops, anchors: res.anchors };
      applyAndRender(res.ir, res.ops);
    } catch (e) {
      panel.log("出错：" + e.message, "err");
      panel.setStatus("出错", "err");
    } finally {
      lock.unlock();
      panel.setBusy(false);
    }
  }

  /** Inject a merged program, show its preview, and render the editable plan. */
  function applyAndRender(ir, ops) {
    panel.showPreview(JSON.stringify(ir, null, 1));
    // Surgically patch the PRE-EDIT workspace snapshot with just these ops, so
    // untouched blocks (内置图像 shadows, default math_number shadows, positions…)
    // are preserved byte-for-byte instead of being rebuilt from lossy IR.
    const base = lastSnapshot?.xml ?? "";
    const inj = injectOps(caps, base, ops, { catalog: data.catalog });
    if (inj.ok) {
      panel.setStatus(`已应用：${inj.blockCount ?? "?"} 个积木`, "ok");
      panel.log(`注入成功，工作区现有 ${inj.blockCount ?? "?"} 个积木。`, "ok");
    } else {
      panel.setStatus("注入时算子有误", "err");
      panel.log("算子错误：" + (inj.errors || []).map((e) => e.detail).join("；"), "err");
    }
    panel.setPlan(buildPlan(ops, lastGen.withIds, lastGen.anchors, data.catalog), onAnchorChange);
  }

  /** User changed an insert/move op's落点 in the panel → re-apply that op. */
  function onAnchorChange(opIndex, key) {
    if (!lastGen) return;
    const ops = lastGen.ops.map((o, i) => (i === opIndex ? { ...o, anchor: anchorFromKey(key) } : o));
    const applied = applyOps(lastGen.withIds, ops, data.catalog);
    if (!applied.ok) {
      panel.setStatus("该落点不可用，已忽略", "err");
      panel.log("落点不可用：" + applied.errors.map((e) => e.detail).join("；"), "err");
      return;
    }
    lastGen.ops = ops;
    lock.lock();
    try { applyAndRender(applied.result, ops); }
    finally { lock.unlock(); }
  }

  function onUndo() {
    if (!lastSnapshot) { panel.setStatus("无可撤销内容", ""); return; }
    restore(caps, lastSnapshot);
    lastSnapshot = null;
    lastGen = null;
    panel.clearPlan();
    panel.setStatus("已撤销", "ok");
  }
}

/** Build the human-readable, editable edit plan from the op list. */
function buildPlan(ops, withIds, anchors, catalog) {
  const idType = idTypeMap(withIds);
  const zh = (type) => catalog?.get?.(type)?.zh || type || "?";
  const zhId = (id) => (idType.has(id) ? `「${zh(idType.get(id))}」` : `id ${id}`);
  const anchorOptions = (anchors || []).map((a) => ({ key: a.key, label: a.label }));
  const items = [];
  (ops || []).forEach((op, i) => {
    let text = "";
    let anchor = null;
    switch (op?.op) {
      case "clear": text = "清空工作区"; break;
      case "insert":
        text = `插入 「${zh(firstType(op.blocks))}…」`;
        anchor = { options: anchorOptions, selectedKey: anchorKey(op.anchor) };
        break;
      case "delete": text = `删除 ${zhId(op.id)}`; break;
      case "move":
        text = `移动 ${zhId(op.id)}`;
        anchor = { options: anchorOptions, selectedKey: anchorKey(op.anchor) };
        break;
      case "setField": text = `${zhId(op.id)} 的 ${op.name} → ${op.value}`; break;
      default: text = `未知算子 ${op?.op || "?"}`;
    }
    items.push({ text, opIndex: i, anchor });
  });
  return items;
}

function idTypeMap(withIds) {
  const m = new Map();
  const walk = (n) => {
    if (n.id) m.set(n.id, n.type);
    for (const v of Object.values(n.inputs || {})) walk(v);
    for (const seq of Object.values(n.statements || {})) for (const c of seq) walk(c);
  };
  for (const stack of withIds || []) for (const n of stack) walk(n);
  return m;
}

function firstType(blocks) {
  let b = blocks;
  while (Array.isArray(b)) b = b[0];
  return b?.type || "?";
}

function progressMsg(ev) {
  switch (ev.phase) {
    case "version": return `板型判定: ${ev.version}`;
    case "retrieve": return "检索相关积木…";
    case "context": return `已装配上下文(相关积木 ${ev.retrieved}，板子知识 ${ev.boardDocs})`;
    case "generate": return `调用模型生成(第 ${ev.attempt + 1} 次)…`;
    case "validate": return ev.ok ? "校验通过 ✓" : `校验发现 ${ev.errors} 处问题，自动修复…`;
    case "parse_error": return "输出解析失败，重试…";
    default: return "";
  }
}

/** Dump one generate→validate round to console.debug as a collapsed group so the
 *  assembled context (messages sent to the model), raw JSON output, parsed IR and
 *  validation errors are all queryable & archivable — without cluttering the panel.
 *  Everything is also retained on `window.__m3e__.debug` for ad-hoc inspection. */
function logRound(r) {
  if (typeof console === "undefined") return;
  const ok = r.ok;
  const head = `%c[m3e] 第 ${r.attempt} 轮 · ${ok ? "✓ 通过" : "✗ 未通过"}`;
  const css = `color:${ok ? "#34d399" : "#fbbf24"};font-weight:600`;
  (console.groupCollapsed || console.debug)(head, css);
  if (r.context) {
    console.debug("装配上下文 (messages 数组):", r.context);
    console.debug("上下文文本预览:\n" + contextText(r.context));
  }
  console.debug("原始模型输出:\n" + (r.raw || "(空)"));
  if (r.ir) console.debug("解析出的 IR:", r.ir);
  if (r.errors && r.errors.length) {
    if (console.table) console.table(r.errors);
    else console.debug("校验错误:", r.errors);
  }
  console.groupEnd?.();
}

/** Flatten an OpenAI-style messages array into a readable role/content transcript. */
function contextText(messages) {
  return (messages || [])
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `── [${m.role}] ──\n${c}`;
    })
    .join("\n\n");
}

boot();
