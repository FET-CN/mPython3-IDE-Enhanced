// src/host/inject.mjs — Inject a full IR program into the live workspace via the
// app's own loadXMLCode mutation (confirmed working in e2e/probe.mjs), refresh
// the generated Python, and verify by reading back. The program is always the
// complete post-edit workspace (produced by applyOps); injection is a full
// replace. Snapshot/restore drive undo.

import { compile } from "../xml/compile.mjs";
import { patchOps } from "../xml/patch.mjs";
import { readWorkspaceXml } from "./read.mjs";

/** Collect all block types referenced in an IR program. */
function collectTypes(program, out = new Set()) {
  const stacks = program.every?.((e) => Array.isArray(e)) ? program : [program];
  for (const stack of stacks) {
    for (const node of stack) {
      if (!node || !node.type) continue;
      out.add(node.type);
      for (const v of Object.values(node.inputs || {})) collectTypes([[v]], out);
      for (const seq of Object.values(node.statements || {})) collectTypes([seq], out);
    }
  }
  return out;
}

/** Snapshot current workspace XML for undo. */
export function snapshot(caps) {
  return { xml: readWorkspaceXml(caps), ts: Date.now() };
}

/** Restore a snapshot (undo). */
export function restore(caps, snap) {
  if (!snap) return;
  caps.commit("loadXMLCode", { title: "m3e-undo", xmlCode: snap.xml || emptyXml(), notClear: false });
  refreshPython(caps);
}

const emptyXml = () => '<xml xmlns="https://developers.google.com/blockly/xml"></xml>';

/** Recompute Python from the live workspace and push it into the app. */
export function refreshPython(caps) {
  const B = caps.Blockly;
  const ws = caps.workspace();
  let py = "";
  try {
    if (B && B.Python && ws) py = B.Python.workspaceToCode(ws);
  } catch { /* ignore */ }
  try {
    if (caps.mutations.setTeachPyCode && py) caps.commit("setTeachPyCode", py);
    if (py) caps.win.localStorage.pyCode = py;
  } catch { /* ignore */ }
  return py;
}

/**
 * @param caps HostCaps
 * @param program full post-edit IR program (from applyOps)
 * @param o    { catalog, title='AI 生成' }
 * @returns { ok, xml, blockCount, expected, missing, py }
 */
export function injectProgram(caps, program, o = {}) {
  const catalog = o.catalog;
  const xml = compile(program, { catalog });
  caps.commit("loadXMLCode", { title: o.title || "AI 生成", xmlCode: xml, notClear: false });
  if (caps.mutations.changeXmlCode) {
    try { caps.commit("changeXmlCode", xml); } catch { /* ignore */ }
  }
  const py = refreshPython(caps);

  // read-back verification
  const expected = [...collectTypes(program)];
  let blockCount = null;
  const present = new Set();
  try {
    const ws = caps.workspace();
    if (ws && ws.getAllBlocks) {
      const blocks = ws.getAllBlocks(false);
      blockCount = blocks.length;
      for (const b of blocks) present.add(b.type);
    }
  } catch { /* ignore */ }
  const missing = blockCount == null ? [] : expected.filter((t) => !present.has(t));
  return { ok: missing.length === 0, xml, blockCount, expected, missing, py };
}

/** Serialize a DOM element to XML text via the host's XMLSerializer/Blockly. */
function serializeEl(caps, el) {
  try {
    if (caps.win && caps.win.XMLSerializer) return new caps.win.XMLSerializer().serializeToString(el);
  } catch { /* ignore */ }
  if (caps.Blockly && caps.Blockly.Xml && caps.Blockly.Xml.domToText) return caps.Blockly.Xml.domToText(el);
  return el.outerHTML;
}

/**
 * Surgically apply `ops` to `baseXml` (the pre-edit workspace snapshot) and load
 * the result. Unlike injectProgram, this does NOT rebuild the program from a lossy
 * IR — every block the ops don't touch keeps its exact original XML (shadows,
 * mutations, positions, collapsed state included). `baseXml` is the pre-edit
 * snapshot so re-applying after an anchor change stays idempotent.
 *
 * @param caps    HostCaps
 * @param baseXml workspace XML captured before the edit (snapshot().xml)
 * @param ops     edit-op list (host/ops.mjs language)
 * @param o       { catalog, title='AI 生成' }
 * @returns { ok, xml, errors, blockCount, py }
 */
export function injectOps(caps, baseXml, ops, o = {}) {
  const patched = patchOps(baseXml, ops, {
    catalog: o.catalog,
    DOMParser: caps.win.DOMParser,
    serialize: (el) => serializeEl(caps, el),
  });
  const xml = patched.xml;
  caps.commit("loadXMLCode", { title: o.title || "AI 生成", xmlCode: xml, notClear: false });
  if (caps.mutations.changeXmlCode) {
    try { caps.commit("changeXmlCode", xml); } catch { /* ignore */ }
  }
  const py = refreshPython(caps);

  let blockCount = null;
  try {
    const ws = caps.workspace();
    if (ws && ws.getAllBlocks) blockCount = ws.getAllBlocks(false).length;
  } catch { /* ignore */ }

  return { ok: patched.ok, xml, errors: patched.errors, blockCount, py };
}
