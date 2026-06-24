// src/host/ops.mjs — Unified edit-operation language over the Blockly workspace.
// The model is shown the current workspace as IR with stable ids + an anchor
// menu, and emits { ops: [...] }. We apply the ops deterministically to produce
// the new full program. This single path replaces the old replace/append modes:
//   clear     — wipe the workspace
//   insert    — place a connected sequence of blocks at an anchor
//   delete    — remove a block (+its nested children); the chain below heals
//   move      — detach a block (+children) and reconnect it at an anchor
//   setField  — change a field / dropdown value on an existing block
//
// Anchor: { at:"new"|"after"|"body", id, input, index? }
//   new   → new top-level stack
//   after → into the next-chain right after block `id` (id must accept `next`)
//   body  → into block `id`'s `input` statement body (default end, else `index`)

import { validate } from "../xml/validate.mjs";

// ---- catalog-derived predicates -------------------------------------------

/** Hat/event block — no previous connection, so it can only sit at a stack top. */
export function isHat(node, catalog) {
  const s = catalog && catalog.get?.(node?.type);
  return s ? !s.prev : false;
}

/** Can another block connect after this one (does it expose a `next`)? */
export function acceptsNext(node, catalog) {
  const s = catalog && catalog.get?.(node?.type);
  return s ? s.next !== false : true; // unknown type → assume chainable
}

/** Declared statement-input names for a block type (falls back to live keys). */
function declaredStatements(node, catalog) {
  const s = catalog && catalog.get?.(node?.type);
  if (s?.statements && s.statements.length) return s.statements;
  return Object.keys(node?.statements || {});
}

// ---- helpers ---------------------------------------------------------------

function asStacks(program) {
  if (!Array.isArray(program) || !program.length) return [];
  return program.every((e) => Array.isArray(e)) ? program : [program];
}

function deepClone(program) {
  const node = (n) => {
    const out = { ...(n.id ? { id: n.id } : {}), type: n.type };
    if (n.fields) out.fields = { ...n.fields };
    if (n.inputs) {
      out.inputs = {};
      for (const [k, v] of Object.entries(n.inputs)) out.inputs[k] = node(v);
    }
    if (n.statements) {
      out.statements = {};
      for (const [k, seq] of Object.entries(n.statements)) out.statements[k] = (seq || []).map(node);
    }
    return out;
  };
  return asStacks(program).map((s) => s.map(node));
}

function stripIds(program) {
  const node = (n) => {
    const out = { type: n.type };
    if (n.fields) out.fields = { ...n.fields };
    if (n.inputs) {
      out.inputs = {};
      for (const [k, v] of Object.entries(n.inputs)) out.inputs[k] = node(v);
    }
    if (n.statements) {
      out.statements = {};
      for (const [k, seq] of Object.entries(n.statements)) out.statements[k] = (seq || []).map(node);
    }
    return out;
  };
  return program.map((s) => s.map(node));
}

const err = (path, kind, detail, suggestions = []) => ({ path, kind, detail, suggestions });

// ---- id annotation ---------------------------------------------------------

/**
 * Deep-clone `program`, assigning a deterministic preorder id (b1, b2, …) to
 * every block (including nested input/statement blocks). The same ids are used
 * when rendering the workspace for the model and when applying ops by id.
 */
export function annotateIds(program) {
  let n = 0;
  const clone = (node) => {
    const out = { id: "b" + ++n, type: node.type };
    if (node.fields) out.fields = { ...node.fields };
    if (node.inputs) {
      out.inputs = {};
      for (const [k, v] of Object.entries(node.inputs)) out.inputs[k] = clone(v);
    }
    if (node.statements) {
      out.statements = {};
      for (const [k, seq] of Object.entries(node.statements)) out.statements[k] = (seq || []).map(clone);
    }
    return out;
  };
  return asStacks(program).map((s) => s.map(clone));
}

// ---- locate / structure ----------------------------------------------------

/** Find a block by id, returning its node + how it's attached (for detach). */
function locate(program, id) {
  for (const stack of program) {
    const hit = locateInSeq(stack, id);
    if (hit) return hit;
  }
  return null;
}
function locateInSeq(seq, id) {
  for (let i = 0; i < seq.length; i++) {
    const node = seq[i];
    if (node.id === id) return { node, container: { type: "seq", seq, index: i } };
    const inner = locateInNode(node, id);
    if (inner) return inner;
  }
  return null;
}
function locateInNode(node, id) {
  for (const [name, child] of Object.entries(node.inputs || {})) {
    if (child.id === id) return { node: child, container: { type: "input", parent: node, name } };
    const inner = locateInNode(child, id);
    if (inner) return inner;
  }
  for (const seq of Object.values(node.statements || {})) {
    const inner = locateInSeq(seq, id);
    if (inner) return inner;
  }
  return null;
}
function subtreeHasId(node, id) {
  if (node.id === id) return true;
  for (const child of Object.values(node.inputs || {})) if (subtreeHasId(child, id)) return true;
  for (const seq of Object.values(node.statements || {})) for (const n of seq) if (subtreeHasId(n, id)) return true;
  return false;
}
function detach(hit) {
  if (hit.container.type === "seq") hit.container.seq.splice(hit.container.index, 1);
  else delete hit.container.parent.inputs[hit.container.name];
  return hit.node;
}

// ---- anchors ---------------------------------------------------------------

export function anchorKey(a) {
  if (!a || a.at === "new") return "new";
  if (a.at === "after") return `after:${a.id}`;
  if (a.at === "body") return `body:${a.id}/${a.input}`;
  return "new";
}
export function anchorFromKey(key) {
  if (!key || key === "new") return { at: "new" };
  if (key.startsWith("after:")) return { at: "after", id: key.slice(6) };
  if (key.startsWith("body:")) {
    const [id, input] = key.slice(5).split("/");
    return { at: "body", id, input };
  }
  return { at: "new" };
}

/** Enumerate the valid insertion points in the current (id-annotated) program,
 *  for the model's anchor menu and the panel's per-insert dropdown. */
export function enumerateAnchors(program, catalog) {
  const out = [{ key: "new", at: "new", label: "新建独立栈" }];
  const zh = (node) => catalog?.get?.(node.type)?.zh || node.type;
  const walkSeq = (seq) => {
    seq.forEach((node, i) => {
      if (i === seq.length - 1 && node.id && acceptsNext(node, catalog)) {
        out.push({ key: `after:${node.id}`, at: "after", id: node.id, label: `接到「${zh(node)}」之后` });
      }
      for (const inp of declaredStatements(node, catalog)) {
        out.push({ key: `body:${node.id}/${inp}`, at: "body", id: node.id, input: inp, label: `放进「${zh(node)}」的 ${inp} 体末尾` });
      }
      for (const s of Object.values(node.statements || {})) walkSeq(s);
    });
  };
  for (const stack of program) walkSeq(stack);
  return out.slice(0, 40);
}

// ---- op application --------------------------------------------------------

function normalizeBlocks(b) {
  if (!Array.isArray(b)) return b && b.type ? [b] : [];
  if (b.length && b.every((e) => Array.isArray(e))) return b.flat();
  return b.filter((e) => e && typeof e === "object" && !Array.isArray(e));
}

function insertAtAnchor(program, anchor, blocks, catalog, errors, path) {
  const at = anchor?.at || "new";
  if (at !== "new" && isHat(blocks[0], catalog)) {
    errors.push(err(`${path}.anchor`, "hat_not_new", `事件积木 "${blocks[0]?.type}" 只能放到新栈(at:"new")`));
    return;
  }
  if (at === "new") { program.push(blocks); return; }
  const hit = locate(program, anchor.id);
  if (!hit) { errors.push(err(`${path}.anchor`, "bad_anchor_id", `找不到 id "${anchor.id}"`)); return; }
  if (at === "after") {
    if (hit.container.type !== "seq") {
      errors.push(err(`${path}.anchor`, "bad_anchor", `"after" 只能用于语句序列中的积木`));
      return;
    }
    if (!acceptsNext(hit.node, catalog)) {
      errors.push(err(`${path}.anchor`, "no_next", `"${hit.node.type}" 之后不能再连接积木(请用 body 或 new)`));
      return;
    }
    hit.container.seq.splice(hit.container.index + 1, 0, ...blocks);
    return;
  }
  if (at === "body") {
    const decl = declaredStatements(hit.node, catalog);
    if (!decl.includes(anchor.input)) {
      errors.push(err(`${path}.anchor`, "bad_input", `"${hit.node.type}" 没有语句体 "${anchor.input}"`, decl));
      return;
    }
    hit.node.statements = hit.node.statements || {};
    const seq = (hit.node.statements[anchor.input] = hit.node.statements[anchor.input] || []);
    const idx = Number.isInteger(anchor.index) ? Math.max(0, Math.min(anchor.index, seq.length)) : seq.length;
    seq.splice(idx, 0, ...blocks);
    return;
  }
  errors.push(err(`${path}.anchor`, "bad_at", `未知锚点 at "${at}"`, ["new", "after", "body"]));
}

function applyInsert(program, op, catalog, errors, path) {
  const blocks = normalizeBlocks(op.blocks);
  if (!blocks.length) { errors.push(err(path, "empty_blocks", "insert 的 blocks 为空")); return; }
  const vr = validate(blocks, catalog);
  for (const e of vr.errors) errors.push({ ...e, path: `${path}.blocks ${e.path}` });
  insertAtAnchor(program, op.anchor || { at: "new" }, blocks, catalog, errors, path);
}

function applyDelete(program, op, errors, path) {
  if (!op.id) { errors.push(err(path, "missing_id", "delete 缺少 id")); return; }
  const hit = locate(program, op.id);
  if (!hit) { errors.push(err(path, "bad_id", `找不到 id "${op.id}"`)); return; }
  detach(hit);
}

function applyMove(program, op, catalog, errors, path) {
  if (!op.id) { errors.push(err(path, "missing_id", "move 缺少 id")); return; }
  const hit = locate(program, op.id);
  if (!hit) { errors.push(err(path, "bad_id", `找不到 id "${op.id}"`)); return; }
  const anchor = op.anchor || { at: "new" };
  if (anchor.id && subtreeHasId(hit.node, anchor.id)) {
    errors.push(err(`${path}.anchor`, "cycle", `不能把 "${op.id}" 移进它自己的子树`));
    return;
  }
  const node = detach(hit);
  insertAtAnchor(program, anchor, [node], catalog, errors, path);
}

function applySetField(program, op, catalog, errors, path) {
  if (!op.id) { errors.push(err(path, "missing_id", "setField 缺少 id")); return; }
  const hit = locate(program, op.id);
  if (!hit) { errors.push(err(path, "bad_id", `找不到 id "${op.id}"`)); return; }
  const schema = catalog?.get?.(hit.node.type);
  const f = schema?.fields?.find((x) => x.name === op.name);
  if (!f) {
    errors.push(err(path, "unknown_field", `"${hit.node.type}" 没有字段 "${op.name}"`, (schema?.fields || []).map((x) => x.name)));
    return;
  }
  if (f.kind === "field_dropdown" && f.enum) {
    const allowed = f.enum.map((e) => e.value);
    if (!allowed.includes(String(op.value))) {
      errors.push(err(path, "bad_enum_value", `字段 "${op.name}" 的值 "${op.value}" 不在可选项中`, allowed));
      return;
    }
  }
  hit.node.fields = hit.node.fields || {};
  hit.node.fields[op.name] = String(op.value);
}

/**
 * Apply an op list to an id-annotated program. Validates each op against the
 * working tree (collecting errors tagged with `ops[i]`) and returns the merged
 * program with ids stripped.
 * @returns { ok, result, errors }
 */
export function applyOps(programWithIds, ops, catalog) {
  const errors = [];
  let program = deepClone(programWithIds);
  const list = Array.isArray(ops) ? ops : [];
  list.forEach((op, i) => {
    const path = `ops[${i}]`;
    if (!op || typeof op !== "object" || !op.op) {
      errors.push(err(path, "bad_op", "算子缺少 op 字段"));
      return;
    }
    switch (op.op) {
      case "clear": program = []; break;
      case "insert": applyInsert(program, op, catalog, errors, path); break;
      case "delete": applyDelete(program, op, errors, path); break;
      case "move": applyMove(program, op, catalog, errors, path); break;
      case "setField": applySetField(program, op, catalog, errors, path); break;
      default:
        errors.push(err(path, "unknown_op", `未知算子 "${op.op}"`, ["insert", "delete", "move", "setField", "clear"]));
    }
  });
  return { ok: errors.length === 0, result: stripIds(program), errors };
}
