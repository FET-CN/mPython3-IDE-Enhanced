// src/xml/compile.mjs — Deterministic IR (JSON AST) → Blockly XML.
// Isomorphic (pure string building, no DOM) so it runs identically in the
// browser snippet and in Node tests.
//
// IR model (consistent "a sequence is an array of nodes"):
//   Program        = Stack[]                 // independent top-level stacks
//   Stack          = IRNode[]                // connected sequence (→ <next> chain)
//   IRNode         = { type, fields?, inputs?, statements? }
//     fields       : { [name]: string|number }
//     inputs       : { [name]: IRNode }      // a single value/expression block
//     statements   : { [name]: IRNode[] }    // a nested connected sequence
//
// A top-level Program element that is a plain node (object) is treated as a
// single-node stack for ergonomics.

const NS = "https://developers.google.com/blockly/xml";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Normalize a Program into Stack[] (array of arrays of nodes). */
function normalizeProgram(program) {
  if (!Array.isArray(program)) return [];
  // Detect single-stack form: array of node objects → wrap as one stack.
  const looksLikeNodes = program.every(
    (e) => e && typeof e === "object" && !Array.isArray(e),
  );
  if (looksLikeNodes && program.length) return [program];
  return program.map((stack) =>
    Array.isArray(stack) ? stack : [stack],
  );
}

/** Collect field_variable values across the whole program (needs catalog). */
function collectVariables(program, catalog, out) {
  for (const stack of program) {
    for (const node of stack) {
      if (!node || !node.type) continue;
      const schema = catalog?.get?.(node.type);
      if (schema) {
        for (const f of schema.fields || []) {
          if (f.kind === "field_variable" && node.fields?.[f.name] != null) {
            out.add(String(node.fields[f.name]));
          }
        }
      }
      for (const v of Object.values(node.inputs || {})) {
        collectVariables([[v]], catalog, out);
      }
      for (const seq of Object.values(node.statements || {})) {
        collectVariables([seq], catalog, out);
      }
    }
  }
}

/** Stable variable id from name (deterministic for tests/caching). */
function varId(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return "var_" + (h >>> 0).toString(36);
}

function fieldKind(schema, name) {
  return schema?.fields?.find((f) => f.name === name)?.kind;
}

/** Build a <mutation> element for blocks that need one, or "". */
function mutationXml(node, schema) {
  const mut = schema?.mutator;
  if (mut === "controls_if" || node.type === "controls_if") {
    const stmts = node.statements || {};
    let elseif = 0;
    while (stmts[`DO${elseif + 1}`] || stmts[`IF${elseif + 1}`]) elseif++;
    const hasElse = !!stmts.ELSE;
    if (elseif === 0 && !hasElse) return "";
    return `<mutation${elseif ? ` elseif="${elseif}"` : ""}${hasElse ? ' else="1"' : ""}></mutation>`;
  }
  if (mut === "text_join" || mut === "lists_create_with") {
    let n = 0;
    while (node.inputs?.[`ADD${n}`] !== undefined) n++;
    return `<mutation items="${n}"></mutation>`;
  }
  return "";
}

/**
 * Compile a single node to <block>…</block> (without the trailing <next>,
 * which the caller wraps). `opts` carries catalog + variables.
 */
function compileNode(node, opts) {
  if (!node || !node.type) return "";
  const schema = opts.catalog?.get?.(node.type);
  const parts = [`<block type="${esc(node.type)}">`];

  const mut = mutationXml(node, schema);
  if (mut) parts.push(mut);

  for (const [name, val] of Object.entries(node.fields || {})) {
    if (fieldKind(schema, name) === "field_variable") {
      const vn = String(val);
      parts.push(`<field name="${esc(name)}" id="${varId(vn)}">${esc(vn)}</field>`);
    } else {
      parts.push(`<field name="${esc(name)}">${esc(val)}</field>`);
    }
  }
  for (const [name, child] of Object.entries(node.inputs || {})) {
    parts.push(`<value name="${esc(name)}">${compileNode(child, opts)}</value>`);
  }
  for (const [name, seq] of Object.entries(node.statements || {})) {
    if (Array.isArray(seq) && seq.length) {
      parts.push(`<statement name="${esc(name)}">${compileSequence(seq, opts)}</statement>`);
    }
  }
  parts.push("</block>");
  return parts.join("");
}

/** Compile a connected sequence of nodes into nested <next> chains. */
function compileSequence(seq, opts) {
  if (!Array.isArray(seq) || seq.length === 0) return "";
  const [head, ...rest] = seq;
  const headXml = compileNode(head, opts);
  if (rest.length === 0) return headXml;
  // insert <next>…</next> just before the closing </block> of head
  const nextXml = `<next>${compileSequence(rest, opts)}</next>`;
  return headXml.replace(/<\/block>$/, `${nextXml}</block>`);
}

/**
 * Compile a Program to a full Blockly workspace XML string.
 * @param program IR program (Stack[] or single Stack)
 * @param opts { catalog?: Map<type,schema>, x?, y?, dy? }
 */
export function compile(program, opts = {}) {
  const stacks = normalizeProgram(program);
  const o = { catalog: opts.catalog };
  const x0 = opts.x ?? 20;
  let y = opts.y ?? 20;
  const dy = opts.dy ?? 60;

  const vars = new Set();
  if (opts.catalog) collectVariables(stacks, opts.catalog, vars);

  const body = [];
  if (vars.size) {
    const vlines = [...vars].map(
      (n) => `<variable id="${varId(n)}">${esc(n)}</variable>`,
    );
    body.push(`<variables>${vlines.join("")}</variables>`);
  }
  for (const stack of stacks) {
    if (!stack.length) continue;
    const inner = compileSequence(stack, o);
    // inject x/y onto the top block of the stack
    const positioned = inner.replace(
      /^<block type="([^"]*)">/,
      `<block type="$1" x="${x0}" y="${y}">`,
    );
    body.push(positioned);
    y += dy;
  }
  return `<xml xmlns="${NS}">${body.join("")}</xml>`;
}
