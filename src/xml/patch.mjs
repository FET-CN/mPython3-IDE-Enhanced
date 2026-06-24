// src/xml/patch.mjs — Apply edit-ops as LOCAL edits on the live workspace XML.
//
// This is the surgical alternative to "decompile → applyOps → compile → full
// replace". That round-trip is lossy: decompile only models <block>/field/value/
// statement/next and silently drops <shadow>, <mutation>, <data>, positions and
// collapsed state. So rebuilding the whole program from IR wipes content on blocks
// the user never touched (e.g. the 内置图像 `mpython_pbm_image` shadow, math_number
// default shadows in coordinate slots).
//
// Instead we parse the ORIGINAL workspace XML and mutate only the nodes an op
// addresses. Every untouched block stays byte-identical, shadows included.
//
// Block ids (b1, b2, …) map to <block> elements in the EXACT same preorder as
// annotateIds(decompile(xml)) — only <block> elements get ids (shadows are
// skipped), inputs before statements, next-chain siblings after the full subtree
// of the prior node. patch.spec.mjs pins this equivalence.

import { directChildren, firstBlockChild } from "./decompile.mjs";
import { compile } from "./compile.mjs";
import { validate } from "./validate.mjs";

const NS = "https://developers.google.com/blockly/xml";

const err = (path, kind, detail, suggestions = []) => ({ path, kind, detail, suggestions });

// ---- DOM helpers -----------------------------------------------------------

const typeOf = (el) => el.getAttribute("type");
const mkEl = (doc, tag) => doc.createElementNS(NS, tag);

/** The <block> nested directly in this block's <next> (skips shadows), or null. */
function nextBlockOf(blockEl) {
  const nx = directChildren(blockEl, "next")[0];
  return nx ? firstBlockChild(nx) : null;
}

/** Last block in a next-chain starting at `block`. */
function seqTail(block) {
  let cur = block, nx;
  while ((nx = nextBlockOf(cur))) cur = nx;
  return cur;
}

function stripNext(el) {
  const nx = directChildren(el, "next")[0];
  if (nx) el.removeChild(nx);
}

function stripPos(el) {
  el.removeAttribute("x");
  el.removeAttribute("y");
}

function isAncestor(anc, node) {
  let p = node;
  while (p) { if (p === anc) return true; p = p.parentNode; }
  return false;
}

// ---- catalog-derived predicates (on DOM elements) --------------------------

function isHatEl(el, catalog) {
  const s = catalog?.get?.(typeOf(el));
  return s ? !s.prev : false;
}
function acceptsNextEl(el, catalog) {
  const s = catalog?.get?.(typeOf(el));
  return s ? s.next !== false : true; // unknown type → assume chainable
}
function declaredStatementsEl(el, catalog) {
  const s = catalog?.get?.(typeOf(el));
  if (s?.statements && s.statements.length) return s.statements;
  return directChildren(el, "statement").map((st) => st.getAttribute("name"));
}

// ---- id map (mirrors annotateIds(decompile(xml)) preorder) -----------------

export function buildIdMap(root) {
  const map = new Map();
  let n = 0;
  const walkBlock = (block) => {
    map.set("b" + ++n, block);
    for (const v of directChildren(block, "value")) {
      const inner = firstBlockChild(v);
      if (inner) walkBlock(inner);
    }
    for (const s of directChildren(block, "statement")) {
      const inner = firstBlockChild(s);
      if (inner) walkSeq(inner);
    }
  };
  const walkSeq = (head) => {
    const chain = [];
    let cur = head;
    while (cur) { chain.push(cur); cur = nextBlockOf(cur); }
    for (const b of chain) walkBlock(b);
  };
  for (const top of directChildren(root, "block")) walkSeq(top);
  return map;
}

// ---- detach / heal ---------------------------------------------------------

/**
 * Remove `el` from the tree and heal the hole by lifting el's next-chain
 * continuation into el's old slot. Returns `el`, orphaned and ALONE (its own
 * <next> stripped) so it can be re-placed as a single node — matching the IR
 * `detach` semantics (a node carries its inputs/statements but not the blocks
 * visually below it).
 */
function detach(el) {
  const parent = el.parentNode;
  const pname = parent.nodeName.toLowerCase();
  if (pname === "value") {
    // value blocks have no next-chain; drop the whole (now empty) value input
    parent.removeChild(el);
    parent.parentNode.removeChild(parent);
    return el;
  }
  const cont = nextBlockOf(el);
  if (pname === "next" || pname === "statement") {
    if (cont) parent.appendChild(cont);          // move continuation out of el
    parent.removeChild(el);
    if (!cont) parent.parentNode.removeChild(parent); // drop empty <next>/<statement>
  } else {
    // top-level stack (parent is <xml>)
    if (cont) parent.insertBefore(cont, el);
    parent.removeChild(el);
  }
  stripNext(el);
  return el;
}

// ---- placement (shared by insert + move) -----------------------------------

function setTopPosition(root, head) {
  let maxY = 0;
  for (const b of directChildren(root, "block")) {
    const y = parseFloat(b.getAttribute("y") || "0");
    if (y > maxY) maxY = y;
  }
  head.setAttribute("x", "20");
  head.setAttribute("y", String((maxY || 0) + 60));
}

/** Place `head` (a <block>, possibly with a next-chain) at `anchor`. */
function placeAt(root, map, anchor, head, catalog, doc, errors, path) {
  const at = anchor?.at || "new";
  if (at !== "new" && isHatEl(head, catalog)) {
    errors.push(err(`${path}.anchor`, "hat_not_new", `事件积木 "${typeOf(head)}" 只能放到新栈(at:"new")`));
    return false;
  }
  if (at === "new") {
    setTopPosition(root, head);
    root.appendChild(head);
    return true;
  }
  const target = map.get(anchor.id);
  if (!target) {
    errors.push(err(`${path}.anchor`, "bad_anchor_id", `找不到 id "${anchor.id}"`));
    return false;
  }
  stripPos(head);
  if (at === "after") {
    if (target.parentNode.nodeName.toLowerCase() === "value") {
      errors.push(err(`${path}.anchor`, "bad_anchor", `"after" 只能用于语句序列中的积木`));
      return false;
    }
    if (!acceptsNextEl(target, catalog)) {
      errors.push(err(`${path}.anchor`, "no_next", `"${typeOf(target)}" 之后不能再连接积木(请用 body 或 new)`));
      return false;
    }
    const oldNext = directChildren(target, "next")[0]; // existing continuation wrapper
    if (oldNext) target.removeChild(oldNext);
    const nx = mkEl(doc, "next");
    nx.appendChild(head);
    target.appendChild(nx);
    if (oldNext) seqTail(head).appendChild(oldNext); // continuation now after inserted tail
    return true;
  }
  if (at === "body") {
    const decl = declaredStatementsEl(target, catalog);
    if (!decl.includes(anchor.input)) {
      errors.push(err(`${path}.anchor`, "bad_input", `"${typeOf(target)}" 没有语句体 "${anchor.input}"`, decl));
      return false;
    }
    let stmt = directChildren(target, "statement").find((s) => s.getAttribute("name") === anchor.input);
    if (!stmt) {
      stmt = mkEl(doc, "statement");
      stmt.setAttribute("name", anchor.input);
      target.appendChild(stmt);
    }
    const existingHead = firstBlockChild(stmt);
    if (!existingHead) {
      stmt.appendChild(head);
    } else if (anchor.index === 0) {
      const nx = mkEl(doc, "next");
      nx.appendChild(existingHead);   // detaches existingHead from stmt
      seqTail(head).appendChild(nx);
      stmt.appendChild(head);
    } else {
      const nx = mkEl(doc, "next");
      nx.appendChild(head);
      seqTail(existingHead).appendChild(nx); // append at end of body
    }
    return true;
  }
  errors.push(err(`${path}.anchor`, "bad_at", `未知锚点 at "${at}"`, ["new", "after", "body"]));
  return false;
}

// ---- variables merge -------------------------------------------------------

function mergeVariables(root, fragRoot, doc) {
  const fvars = directChildren(fragRoot, "variables")[0];
  if (!fvars) return;
  let rvars = directChildren(root, "variables")[0];
  if (!rvars) {
    rvars = mkEl(doc, "variables");
    root.insertBefore(rvars, root.firstChild);
  }
  const ids = new Set(directChildren(rvars, "variable").map((v) => v.getAttribute("id")));
  const names = new Set(directChildren(rvars, "variable").map((v) => v.textContent));
  for (const v of directChildren(fvars, "variable")) {
    if (ids.has(v.getAttribute("id")) || names.has(v.textContent)) continue;
    rvars.appendChild(doc.importNode(v, true));
  }
}

// ---- individual ops --------------------------------------------------------

function normalizeBlocks(b) {
  if (!Array.isArray(b)) return b && b.type ? [b] : [];
  if (b.length && b.every((e) => Array.isArray(e))) return b.flat();
  return b.filter((e) => e && typeof e === "object" && !Array.isArray(e));
}

function opInsert(root, map, op, catalog, doc, parser, errors, path) {
  const blocks = normalizeBlocks(op.blocks);
  if (!blocks.length) { errors.push(err(path, "empty_blocks", "insert 的 blocks 为空")); return; }
  const vr = validate(blocks, catalog);
  for (const e of vr.errors) errors.push({ ...e, path: `${path}.blocks ${e.path}` });

  const fragXml = compile(blocks, { catalog });
  const fdoc = parser.parseFromString(fragXml, "text/xml");
  const froot = fdoc.documentElement;
  mergeVariables(root, froot, doc);
  const fragHead = directChildren(froot, "block")[0];
  if (!fragHead) { errors.push(err(path, "compile_empty", "insert 的 blocks 无法编译出积木")); return; }
  const head = doc.importNode(fragHead, true);
  placeAt(root, map, op.anchor || { at: "new" }, head, catalog, doc, errors, path);
}

function opDelete(root, map, op, errors, path) {
  if (!op.id) { errors.push(err(path, "missing_id", "delete 缺少 id")); return; }
  const el = map.get(op.id);
  if (!el) { errors.push(err(path, "bad_id", `找不到 id "${op.id}"`)); return; }
  detach(el);
}

function opMove(root, map, op, catalog, doc, errors, path) {
  if (!op.id) { errors.push(err(path, "missing_id", "move 缺少 id")); return; }
  const el = map.get(op.id);
  if (!el) { errors.push(err(path, "bad_id", `找不到 id "${op.id}"`)); return; }
  const anchor = op.anchor || { at: "new" };
  if (anchor.id) {
    const target = map.get(anchor.id);
    if (target && isAncestor(el, target)) {
      errors.push(err(`${path}.anchor`, "cycle", `不能把 "${op.id}" 移进它自己的子树`));
      return;
    }
  }
  const node = detach(el);
  placeAt(root, map, anchor, node, catalog, doc, errors, path);
}

function opSetField(map, op, catalog, doc, errors, path) {
  if (!op.id) { errors.push(err(path, "missing_id", "setField 缺少 id")); return; }
  const el = map.get(op.id);
  if (!el) { errors.push(err(path, "bad_id", `找不到 id "${op.id}"`)); return; }
  const schema = catalog?.get?.(typeOf(el));
  const f = schema?.fields?.find((x) => x.name === op.name);
  if (schema && !f) {
    errors.push(err(path, "unknown_field", `"${typeOf(el)}" 没有字段 "${op.name}"`, (schema.fields || []).map((x) => x.name)));
    return;
  }
  if (f && f.kind === "field_dropdown" && f.enum) {
    const allowed = f.enum.map((e) => e.value);
    if (!allowed.includes(String(op.value))) {
      errors.push(err(path, "bad_enum_value", `字段 "${op.name}" 的值 "${op.value}" 不在可选项中`, allowed));
      return;
    }
  }
  let field = directChildren(el, "field").find((fe) => fe.getAttribute("name") === op.name);
  if (!field) {
    field = mkEl(doc, "field");
    field.setAttribute("name", op.name);
    const ref = [...el.childNodes].find(
      (c) => c.nodeType === 1 && ["value", "statement", "next"].includes(c.nodeName.toLowerCase()),
    );
    el.insertBefore(field, ref || null);
  }
  field.textContent = String(op.value);
}

// ---- entry point -----------------------------------------------------------

/**
 * Apply `ops` to `baseXml` as local DOM edits, preserving everything not touched.
 * @param baseXml workspace XML (the pre-edit snapshot)
 * @param ops     edit-op list (same language as host/ops.mjs)
 * @param o { catalog, DOMParser, serialize? }
 *   DOMParser : a DOMParser constructor (caps.win.DOMParser in browser, linkedom in Node)
 *   serialize : (rootElement) => string (default: rootElement.outerHTML)
 * @returns { ok, xml, errors }
 */
export function patchOps(baseXml, ops, o = {}) {
  const errors = [];
  const P = o.DOMParser || globalThis.DOMParser;
  if (!P) throw new Error("patchOps: no DOMParser available — pass o.DOMParser");
  const parser = new P();
  const serialize = o.serialize || ((r) => r.outerHTML);
  const catalog = o.catalog;

  const src = baseXml && /<xml/i.test(baseXml) ? baseXml : `<xml xmlns="${NS}"></xml>`;
  const doc = parser.parseFromString(src, "text/xml");
  const root =
    doc.documentElement && doc.documentElement.nodeName.toLowerCase() === "xml"
      ? doc.documentElement
      : doc.getElementsByTagName("xml")[0];
  if (!root) throw new Error("patchOps: base XML has no <xml> root");

  // Element references stay valid across moves, so one map covers the whole batch
  // (inserted blocks get no ids; deleted ids simply won't be addressed again).
  const map = buildIdMap(root);

  const list = Array.isArray(ops) ? ops : [];
  list.forEach((op, i) => {
    const path = `ops[${i}]`;
    if (!op || typeof op !== "object" || !op.op) {
      errors.push(err(path, "bad_op", "算子缺少 op 字段"));
      return;
    }
    switch (op.op) {
      case "clear":
        for (const c of [...root.childNodes]) if (c.nodeType === 1) root.removeChild(c);
        break;
      case "insert": opInsert(root, map, op, catalog, doc, parser, errors, path); break;
      case "delete": opDelete(root, map, op, errors, path); break;
      case "move": opMove(root, map, op, catalog, doc, errors, path); break;
      case "setField": opSetField(map, op, catalog, doc, errors, path); break;
      default:
        errors.push(err(path, "unknown_op", `未知算子 "${op.op}"`, ["insert", "delete", "move", "setField", "clear"]));
    }
  });

  return { ok: errors.length === 0, xml: serialize(root), errors };
}
