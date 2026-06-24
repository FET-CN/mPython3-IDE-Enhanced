// src/xml/decompile.mjs — Blockly XML → IR (JSON AST). Inverse of compile.mjs.
// Used for: showing the current workspace to the LLM as IR (few-shot dynamic
// seed / current state), append-merge, and round-trip verification.
//
// Reads only DIRECT children of each <block> (field/value/statement/next),
// ignoring id/x/y attributes and <mutation> (compile reconstructs mutations
// from structure). Canonical IR field values are strings.

function getDOMParser(opts) {
  const P = opts.DOMParser || globalThis.DOMParser;
  if (!P) {
    throw new Error(
      "decompile: no DOMParser available — pass opts.DOMParser (e.g. linkedom in Node)",
    );
  }
  return new P();
}

export function directChildren(el, tagName) {
  const out = [];
  for (const c of el.childNodes || []) {
    if (c.nodeType === 1 && c.nodeName.toLowerCase() === tagName) out.push(c);
  }
  return out;
}

export function firstBlockChild(el) {
  for (const c of el.childNodes || []) {
    if (c.nodeType === 1 && c.nodeName.toLowerCase() === "block") return c;
  }
  return null;
}

/** Convert a <block> element to a single IRNode (excludes its <next> sibling). */
function blockToNode(block) {
  const node = { type: block.getAttribute("type") };
  const fields = {};
  for (const f of directChildren(block, "field")) {
    fields[f.getAttribute("name")] = f.textContent ?? "";
  }
  const inputs = {};
  for (const v of directChildren(block, "value")) {
    const inner = firstBlockChild(v);
    if (inner) inputs[v.getAttribute("name")] = blockToNode(inner);
  }
  const statements = {};
  for (const s of directChildren(block, "statement")) {
    const inner = firstBlockChild(s);
    if (inner) statements[s.getAttribute("name")] = sequenceFromBlock(inner);
  }
  if (Object.keys(fields).length) node.fields = fields;
  if (Object.keys(inputs).length) node.inputs = inputs;
  if (Object.keys(statements).length) node.statements = statements;
  return node;
}

/** Walk a connected sequence starting at `block`, following <next> chains. */
function sequenceFromBlock(block) {
  const seq = [];
  let cur = block;
  while (cur) {
    seq.push(blockToNode(cur));
    const nextEl = directChildren(cur, "next")[0];
    cur = nextEl ? firstBlockChild(nextEl) : null;
  }
  return seq;
}

/**
 * Decompile a Blockly workspace XML string into a Program (Stack[]).
 * @param xml string
 * @param opts { DOMParser?, singleStack? } — if singleStack and exactly one
 *   top-level stack exists, returns that Stack (IRNode[]) instead of Stack[].
 */
export function decompile(xml, opts = {}) {
  const parser = getDOMParser(opts);
  const doc = parser.parseFromString(xml, "text/xml");
  const root =
    doc.documentElement && doc.documentElement.nodeName.toLowerCase() === "xml"
      ? doc.documentElement
      : doc.getElementsByTagName("xml")[0];
  if (!root) return [];
  const stacks = [];
  for (const b of directChildren(root, "block")) {
    stacks.push(sequenceFromBlock(b));
  }
  if (opts.singleStack && stacks.length === 1) return stacks[0];
  return stacks;
}

/** Strip empty containers and stringify field values → canonical IR. */
export function canonicalize(program) {
  const canonNode = (n) => {
    const out = { type: n.type };
    if (n.fields && Object.keys(n.fields).length) {
      out.fields = {};
      for (const [k, v] of Object.entries(n.fields)) out.fields[k] = String(v);
    }
    if (n.inputs && Object.keys(n.inputs).length) {
      out.inputs = {};
      for (const [k, v] of Object.entries(n.inputs)) out.inputs[k] = canonNode(v);
    }
    if (n.statements) {
      const st = {};
      for (const [k, seq] of Object.entries(n.statements)) {
        if (Array.isArray(seq) && seq.length) st[k] = seq.map(canonNode);
      }
      if (Object.keys(st).length) out.statements = st;
    }
    return out;
  };
  const stacks = Array.isArray(program) && program.every((e) => Array.isArray(e))
    ? program
    : [program];
  return stacks.map((stack) => stack.map(canonNode));
}
