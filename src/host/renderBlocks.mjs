// src/host/renderBlocks.mjs — Anti-corruption layer for the edit-preview shown
// BEFORE the user approves an edit_blocks call. Two concerns, both kept out of
// the panel/agent layers:
//
//   computeEditPreview — offline, NO workspace mutation: reuse planEdit (pure)
//     to get the post-edit IR, patchOps (pure DOM patch) to get the post-edit
//     XML, and build a human-readable zh change summary from the ops. The confirm
//     gate runs before tool.run(), so this must never touch the live workspace.
//
//   renderWorkspaceSvg — high-fidelity path. Two strategies, tried in order:
//     1) Off-screen inject: build a throwaway read-only Blockly workspace and
//        render into it. Clean (no live-workspace mutation) but needs the full
//        authoring API (Blockly.inject / Xml). online.mpython.cn ships a closure
//        build that exposes only `Blockly.Msg`, so this is unavailable there.
//     2) Live capture (intrusive): briefly inject the post-edit XML into the REAL
//        workspace via the loadXMLCode mutation, clone its rendered <svg>, then
//        restore the original XML. The workspace lock's scrim is frozen opaque
//        around this so the swap is invisible. Used on mpython.cn.
//     Both embed the site's Blockly CSS into the cloned SVG so colours/shapes
//     survive the panel's Shadow-DOM style isolation. Best-effort: returns null
//     on any failure so the caller degrades to the blockTree/summary fallbacks.

import { annotateIds } from "./ops.mjs";
import { readWorkspaceIR } from "./read.mjs";
import { snapshot } from "./inject.mjs";
import { patchOps } from "../xml/patch.mjs";
import { planEdit } from "../agent/tools/editBlocks.mjs";

/** Serialize a DOM element to XML text via the host's XMLSerializer/Blockly. */
function serializeEl(caps, el) {
  try {
    if (caps.win && caps.win.XMLSerializer) return new caps.win.XMLSerializer().serializeToString(el);
  } catch { /* ignore */ }
  if (caps.Blockly && caps.Blockly.Xml && caps.Blockly.Xml.domToText) return caps.Blockly.Xml.domToText(el);
  return el.outerHTML;
}

/** Find a block node by its annotated id in an id-annotated program. */
function findById(program, id) {
  const stacks = Array.isArray(program) && program.every((e) => Array.isArray(e)) ? program : [program];
  const walk = (node) => {
    if (!node) return null;
    if (node.id === id) return node;
    for (const v of Object.values(node.inputs || {})) { const h = walk(v); if (h) return h; }
    for (const seq of Object.values(node.statements || {})) for (const n of seq) { const h = walk(n); if (h) return h; }
    return null;
  };
  for (const stack of stacks) for (const n of stack || []) { const h = walk(n); if (h) return h; }
  return null;
}

/** First block with a `type` inside an op's `blocks` (array, nested, or single). */
function firstBlock(blocks) {
  if (Array.isArray(blocks)) {
    for (const b of blocks) { const h = firstBlock(b); if (h) return h; }
    return null;
  }
  return blocks && blocks.type ? blocks : null;
}

function collectNestedTypes(node, out = []) {
  if (!node || !node.type) return out;
  for (const v of Object.values(node.inputs || {})) {
    if (v?.type) { out.push(v.type); collectNestedTypes(v, out); }
  }
  for (const seq of Object.values(node.statements || {})) {
    for (const n of seq || []) {
      if (n?.type) { out.push(n.type); collectNestedTypes(n, out); }
    }
  }
  return out;
}

function rawInsertPreview(ops) {
  const stacks = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.op !== "insert") continue;
    const b = op.blocks;
    if (Array.isArray(b) && b.length && b.every((e) => Array.isArray(e))) stacks.push(...b.filter((s) => s?.length));
    else if (Array.isArray(b)) stacks.push(b.filter((n) => n?.type));
    else if (b?.type) stacks.push([b]);
  }
  return stacks;
}

function insertTitle(blocks, zh) {
  const root = firstBlock(blocks);
  if (!root) return "新增「积木」";
  const nested = collectNestedTypes(root).map(zh).slice(0, 4);
  const more = collectNestedTypes(root).length > nested.length ? "…" : "";
  return `新增「${zh(root.type)}」${nested.length ? `（含 ${nested.join("、")}${more}）` : ""}`;
}

/** Build a short zh change summary from the (expanded) ops + the pre-edit IR. */
function summarize(ops, currentWithIds, catalog) {
  const zh = (type) => catalog?.get?.(type)?.zh?.replace(/\s*%\d+/g, "")?.trim() || type;
  const zhOfId = (id) => { const n = findById(currentWithIds, id); return n ? zh(n.type) : `id ${id}`; };
  const lines = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || !op.op) continue;
    switch (op.op) {
      case "clear":
        lines.push("清空全部积木");
        break;
      case "insert":
        lines.push(insertTitle(op.blocks, zh));
        break;
      case "delete":
        lines.push(`删除「${zhOfId(op.id)}」`);
        break;
      case "move":
        lines.push(`移动「${zhOfId(op.id)}」`);
        break;
      case "setField":
        lines.push(`修改「${zhOfId(op.id)}」的 ${op.name} → ${op.value}`);
        break;
    }
  }
  return lines;
}

/**
 * Offline preview of an edit_blocks op list. NO workspace mutation. Always
 * returns a zh `summary` (computed from the raw ops, so it survives even when
 * validation fails). `ok` reflects whether planEdit validated: on ok we also
 * return postIR + afterXml for the visual preview; on failure those are empty,
 * but rawIR + summary + feedback still let the caller show what the model asked
 * to insert (useful when bad dropdown values make validation fail).
 * @returns { ok, postIR, rawIR, afterXml, summary, feedback? }
 */
export function computeEditPreview(caps, ops, catalog) {
  if (!caps || !catalog) return { ok: false, postIR: [], rawIR: [], afterXml: "", summary: [], feedback: "无法访问宿主工作区或知识库。" };
  const current = annotateIds(readWorkspaceIR(caps) || []);
  const summary = summarize(ops, current, catalog);
  const rawIR = rawInsertPreview(ops);

  const plan = planEdit(current, ops, catalog);
  if (!plan.ok) return { ok: false, postIR: [], rawIR, afterXml: "", summary, feedback: plan.feedback };

  let afterXml = "";
  try {
    const baseXml = snapshot(caps).xml;
    const patched = patchOps(baseXml, plan.ops, {
      catalog,
      DOMParser: caps.win.DOMParser,
      serialize: (el) => serializeEl(caps, el),
    });
    if (patched.ok) afterXml = patched.xml;
  } catch { /* afterXml stays empty → caller uses blockTree(postIR) */ }

  return { ok: true, postIR: plan.result, rawIR, afterXml, summary };
}

/**
 * Render workspace XML to a cloned, Shadow-DOM-safe <svg>. Tries the clean
 * off-screen inject first, then the intrusive live capture. Returns the cloned
 * SVG element, or null on any failure (caller degrades to blockTree/summary).
 *
 * @param caps HostCaps
 * @param xml  post-edit workspace XML
 * @param o    { lock? } — when the intrusive path runs, lock.freeze()/unfreeze()
 *             wrap the swap so the workspace flash is hidden behind the scrim.
 */
export function renderWorkspaceSvg(caps, xml, o = {}) {
  if (!xml || !/<block/i.test(xml)) return null; // empty workspace → nothing to draw
  return renderViaOffscreen(caps, xml) || captureFromLiveWorkspace(caps, xml, o.lock);
}

/** Strategy 1: throwaway off-screen read-only workspace (needs full Blockly API). */
function renderViaOffscreen(caps, xml) {
  const B = caps?.Blockly;
  const doc = caps?.doc;
  if (!B || !doc || typeof B.inject !== "function" || !B.Xml || !B.Xml.textToDom || !B.Xml.domToWorkspace) return null;

  // Off-screen, NOT display:none — a hidden subtree has zero-size SVG bboxes,
  // which breaks viewBox computation. Park it far off the left edge instead.
  const holder = doc.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:fixed;left:-99999px;top:0;width:1200px;height:800px;overflow:hidden;pointer-events:none;opacity:0;";
  doc.body.appendChild(holder);

  // Blockly.inject sets the new workspace as the global main — save & restore so
  // the site's own code (which reads getMainWorkspace) is never disturbed.
  let prevMain = null;
  try { prevMain = typeof B.getMainWorkspace === "function" ? B.getMainWorkspace() : null; } catch { /* ignore */ }

  let ws = null;
  try {
    ws = B.inject(holder, {
      readOnly: true, toolbox: undefined, trashcan: false,
      zoom: { controls: false, wheel: false }, scrollbars: false, sounds: false,
    });
    B.Xml.domToWorkspace(B.Xml.textToDom(xml), ws);
    try { ws.render?.(); } catch { /* ignore */ }
    const svg = holder.querySelector("svg.blocklySvg") || holder.querySelector("svg");
    return svg ? finalizeSvg(caps, svg, svg.querySelector(".blocklyBlockCanvas")) : null;
  } catch {
    return null;
  } finally {
    try { ws?.dispose?.(); } catch { /* ignore */ }
    try { holder.remove(); } catch { /* ignore */ }
    try { if (prevMain && B.setMainWorkspace) B.setMainWorkspace(prevMain); } catch { /* ignore */ }
  }
}

/** Strategy 2: briefly load the post-edit XML into the REAL workspace, clone its
 *  rendered SVG, then restore the original XML. The lock's scrim is frozen opaque
 *  around the swap so the flash is invisible. Synchronous: inject → measure →
 *  clone → restore all run before yielding to the event loop / repaint. */
function captureFromLiveWorkspace(caps, xml, lock) {
  if (!caps?.commit || !caps.mutations?.loadXMLCode) return null;
  const ws = caps.workspace?.();
  const svg = ws?.getParentSvg?.();
  if (!svg) return null;

  const froze = lock?.freeze?.() || false;
  let original = null;
  try { original = snapshot(caps).xml; } catch { /* ignore */ }

  try {
    caps.commit("loadXMLCode", { title: "m3e-preview", xmlCode: xml, notClear: false });
    if (caps.mutations.changeXmlCode) { try { caps.commit("changeXmlCode", xml); } catch { /* ignore */ } }
    const canvas = ws.getBlockCanvas?.() || ws.getCanvas?.() || svg.querySelector(".blocklyBlockCanvas");
    return finalizeSvg(caps, svg, canvas);
  } catch {
    return null;
  } finally {
    // Restore the user's real workspace before anything repaints.
    try {
      if (original != null) {
        caps.commit("loadXMLCode", { title: "m3e-preview-restore", xmlCode: original, notClear: false });
        if (caps.mutations.changeXmlCode) { try { caps.commit("changeXmlCode", original); } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
    if (froze) lock.unfreeze();
  }
}

/** Clone a live/scratch Blockly <svg>, crop its viewBox to the block canvas, and
 *  embed the site's Blockly CSS so it survives the panel's Shadow-DOM isolation. */
function finalizeSvg(caps, svg, canvas) {
  let box = null;
  try {
    const bb = canvas?.getBBox?.();
    if (bb && bb.width && bb.height) box = bb;
  } catch { /* no bbox → keep source viewBox */ }

  const clone = svg.cloneNode(true);

  // Blockly paints blocks via document-level CSS classes (.blocklyPath fills,
  // .blocklyText fonts, .blocklyFieldRect field backgrounds …). The Shadow DOM
  // strips those rules → black paths / black empty slots. Re-embed the site's
  // Blockly rules as an SVG-internal <style>: it keeps the class names and styles
  // the clone's own subtree regardless of the shadow boundary.
  embedBlocklyCss(caps, clone);

  // Reset transient transforms (pan/zoom translate) on the cloned canvas so the
  // cropped viewBox lines up with the block geometry.
  const cloneCanvas = clone.querySelector(".blocklyBlockCanvas, .blocklyBubbleCanvas");
  if (cloneCanvas) cloneCanvas.removeAttribute("transform");
  for (const el of clone.querySelectorAll(".blocklyMainBackground")) el.remove();

  if (box) {
    const pad = 8;
    // box is in canvas coords; with the canvas transform stripped on the clone,
    // viewBox origin is the bbox origin directly.
    clone.setAttribute("viewBox", `${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`);
    clone.setAttribute("width", String(Math.ceil(box.width + pad * 2)));
    clone.setAttribute("height", String(Math.ceil(box.height + pad * 2)));
  }
  clone.removeAttribute("class");
  clone.style.cssText = "max-width:100%;height:auto;display:block;";
  return clone;
}

/** Collect the site's Blockly CSS and prepend it as a <style> inside the cloned
 *  SVG. Two sources, because Blockly injects its core rules (.blocklyText fill,
 *  .blocklyFieldRect …) at runtime as a raw <style> in <head> — those are NOT
 *  reliably reachable via sheet.cssRules, so we also scrape <style> textContent.
 *  A small hard-coded baseline guarantees the essentials even if both miss. */
function embedBlocklyCss(caps, clone) {
  const doc = caps?.doc;
  const ns = "http://www.w3.org/2000/svg";
  let css = BASELINE_BLOCKLY_CSS;

  // 1) Raw <style> tags whose text mentions blockly (catches runtime-injected
  //    Blockly.Css rules that cssRules enumeration can miss).
  try {
    for (const tag of doc.querySelectorAll("style")) {
      const t = tag.textContent || "";
      if (/blockly/i.test(t)) css += "\n" + t;
    }
  } catch { /* ignore */ }

  // 2) Per-selector rules from external/linked sheets (skin overrides, themes).
  try {
    for (const sheet of doc.styleSheets || []) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin
      if (!rules) continue;
      for (const rule of rules) {
        const sel = rule.selectorText;
        if (sel && /blockly/i.test(sel)) css += "\n" + rule.cssText;
      }
    }
  } catch { /* ignore */ }

  const style = doc.createElementNS(ns, "style");
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);
}

// Minimal Blockly paint/text baseline (standard defaults + the site's measured
// values) so blocks read correctly even when CSS scraping comes up empty.
const BASELINE_BLOCKLY_CSS = `
.blocklyText{fill:#fff;font-family:sans-serif;font-size:14.6667px;font-weight:400;}
.blocklyNonEditableText>text,.blocklyEditableText>text{fill:#000;}
.blocklyEditableText>.blocklyDropdownText{fill:#000;}
.blocklyFieldRect{fill:#fff;fill-opacity:1;stroke:#bbb;stroke-width:.5px;}
.blocklyEditableText>rect.blocklyFieldRect{fill:#fff;}
.blocklyPath{stroke-width:1px;}
.blocklyMainBackground{stroke:none;fill:none;}
.blocklyScrollbarBackground,.blocklyScrollbarHandle{display:none;}
.blocklyFlyout,.blocklyTrash,.blocklyZoom{display:none;}
`;
