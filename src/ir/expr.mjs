// src/ir/expr.mjs — Flat infix expression → IR node tree.
//
// Context-engineering layer: the model is great at writing standard
// arithmetic / Python-style expressions (`20 + 20*cos(angle1)`) and bad at
// hand-emitting their deeply-nested JSON block tree (each such term is 6 levels
// deep / 8 trailing `}` — exactly where it miscounts braces and produces invalid
// JSON). So we let value-input slots carry a flat expression STRING and expand
// it here, deterministically, into the canonical value-block tree.
//
// The accepted grammar is CLOSED: it maps exactly onto existing Blockly value
// blocks (verified against dist/catalog.full.json). Anything outside it (bitwise
// ops, slicing/indexing, f-strings, user functions, unlisted library calls)
// throws ExprError → the repair loop feeds it back so the model uses explicit
// nodes instead. We never fabricate a block or silently degrade.

export class ExprError extends Error {
  constructor(message, src) {
    super(src ? `${message}（表达式: "${src}"）` : message);
    this.name = "ExprError";
    this.kind = "expr_error";
  }
}

// ---- node builders (every output verified present in the catalog) ----------
const num = (n) => ({ type: "math_number", fields: { NUM: String(n) } });
const str = (s) => ({ type: "text", fields: { TEXT: s } });
const bool = (b) => ({ type: "logic_boolean", fields: { BOOL: b ? "TRUE" : "FALSE" } });
const variable = (name) => ({ type: "variables_get", fields: { VAR: name } });
const constant = (c) => ({ type: "math_constant", fields: { CONSTANT: c } });
const arith = (op, a, b) => ({ type: "math_arithmetic", fields: { OP: op }, inputs: { A: a, B: b } });
const modulo = (a, b) => ({ type: "math_modulo", inputs: { DIVIDEND: a, DIVISOR: b } });
const compare = (op, a, b) => ({ type: "logic_compare", fields: { OP: op }, inputs: { A: a, B: b } });
const logicOp = (op, a, b) => ({ type: "logic_operation", fields: { OP: op }, inputs: { A: a, B: b } });
const negate = (x) => ({ type: "logic_negate", inputs: { BOOL: x } });
const single = (op, x) => ({ type: "math_single", fields: { OP: op }, inputs: { NUM: x } });
const trig = (op, x) => ({ type: "math_trig", fields: { OP: op }, inputs: { NUM: x } });
const rnd = (op, x) => ({ type: "math_round", fields: { OP: op }, inputs: { NUM: x } });
const randint = (a, b) => ({ type: "math_random_int", inputs: { FROM: a, TO: b } });
const constrain = (v, lo, hi) => ({ type: "math_constrain", inputs: { VALUE: v, LOW: lo, HIGH: hi } });
const ternary = (c, a, b) => ({ type: "logic_ternary", inputs: { IF: c, THEN: a, ELSE: b } });

// function name → [builder, fixedOp|null, arity]
const FUNCS = {
  sin: [trig, "SIN", 1], cos: [trig, "COS", 1], tan: [trig, "TAN", 1],
  asin: [trig, "ASIN", 1], acos: [trig, "ACOS", 1], atan: [trig, "ATAN", 1],
  sqrt: [single, "ROOT", 1], abs: [single, "ABS", 1], ln: [single, "LN", 1],
  log10: [single, "LOG10", 1], exp: [single, "EXP", 1], pow10: [single, "POW10", 1],
  round: [rnd, "ROUND", 1], ceil: [rnd, "ROUNDUP", 1], floor: [rnd, "ROUNDDOWN", 1],
  random: [(a, b) => randint(a, b), null, 2],
  randint: [(a, b) => randint(a, b), null, 2],
  mod: [(a, b) => modulo(a, b), null, 2],
  constrain: [(v, lo, hi) => constrain(v, lo, hi), null, 3],
  clamp: [(v, lo, hi) => constrain(v, lo, hi), null, 3],
};

// bare identifiers that resolve to a math_constant instead of a variable.
// Kept deliberately tiny (only `pi`) so we don't clobber user variables like `e`.
const CONSTS = { pi: "PI" };

// ---- tokenizer -------------------------------------------------------------
const PUNCT = ["**", "==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "^", "(", ")", ","];

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    // string literal
    if (c === '"' || c === "'") {
      let j = i + 1, out = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < n) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      if (j >= n) throw new ExprError("字符串字面量未闭合", src);
      toks.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if ((text.match(/\./g) || []).length > 1) throw new ExprError(`非法数字 "${text}"`, src);
      toks.push({ t: "num", v: text });
      i = j;
      continue;
    }
    // identifier / keyword
    if (/[A-Za-z_$一-龥]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$一-龥]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    // punctuation (longest match first)
    const p = PUNCT.find((op) => src.startsWith(op, i));
    if (p) { toks.push({ t: "op", v: p }); i += p.length; continue; }
    throw new ExprError(`无法识别的字符 "${c}"`, src);
  }
  return toks;
}

// ---- parser (precedence-climbing) ------------------------------------------
const CMP = { "==": "EQ", "!=": "NEQ", "<": "LT", "<=": "LTE", ">": "GT", ">=": "GTE" };

function parse(toks, src) {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const eat = (v) => {
    const tk = toks[pos];
    if (!tk || tk.v !== v) throw new ExprError(`期望 "${v}"`, src);
    pos++;
  };
  const isOp = (v) => peek() && peek().t === "op" && peek().v === v;
  const isKw = (v) => peek() && peek().t === "id" && peek().v === v;

  // ternary (lowest):  <or> [ "if" <or> "else" <ternary> ]
  function parseExprTop() {
    const thenVal = parseOr();
    if (isKw("if")) {
      next();
      const cond = parseOr();
      if (!isKw("else")) throw new ExprError('三元表达式缺少 "else"', src);
      next();
      const elseVal = parseExprTop();
      return ternary(cond, thenVal, elseVal);
    }
    return thenVal;
  }
  function parseOr() {
    let left = parseAnd();
    while (isKw("or") || isOp("||")) { next(); left = logicOp("OR", left, parseAnd()); }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isKw("and") || isOp("&&")) { next(); left = logicOp("AND", left, parseNot()); }
    return left;
  }
  function parseNot() {
    if (isKw("not")) { next(); return negate(parseNot()); }
    return parseCmp();
  }
  function parseCmp() {
    let left = parseAdd();
    while (peek() && peek().t === "op" && CMP[peek().v]) {
      const op = next().v;
      left = compare(CMP[op], left, parseAdd());
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (isOp("+") || isOp("-")) {
      const op = next().v;
      left = arith(op === "+" ? "ADD" : "MINUS", left, parseMul());
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = next().v;
      const right = parseUnary();
      left = op === "%" ? modulo(left, right) : arith(op === "*" ? "MULTIPLY" : "DIVIDE", left, right);
    }
    return left;
  }
  function parseUnary() {
    if (isOp("-")) {
      next();
      const operand = parseUnary();
      if (operand.type === "math_number") {
        const v = operand.fields.NUM;
        return num(v.startsWith("-") ? v.slice(1) : "-" + v);
      }
      return single("NEG", operand);
    }
    if (isOp("+")) { next(); return parseUnary(); }
    return parsePow();
  }
  function parsePow() {
    const base = parseAtom();
    if (isOp("**") || isOp("^")) { next(); return arith("POWER", base, parseUnary()); }
    return base;
  }
  function parseAtom() {
    const tk = peek();
    if (!tk) throw new ExprError("表达式不完整", src);
    if (tk.t === "num") { next(); return num(tk.v); }
    if (tk.t === "str") { next(); return str(tk.v); }
    if (isOp("(")) {
      next();
      const e = parseExprTop();
      eat(")");
      return e;
    }
    if (tk.t === "id") {
      next();
      const name = tk.v;
      // function call?
      if (isOp("(")) {
        next();
        const args = [];
        if (!isOp(")")) {
          args.push(parseExprTop());
          while (isOp(",")) { next(); args.push(parseExprTop()); }
        }
        eat(")");
        const fn = FUNCS[name.toLowerCase()];
        if (!fn) throw new ExprError(`未知函数 "${name}"（可用: ${Object.keys(FUNCS).join(", ")}），请改用显式节点`, src);
        const [builder, fixedOp, arity] = fn;
        if (args.length !== arity) throw new ExprError(`函数 "${name}" 需要 ${arity} 个参数，收到 ${args.length}`, src);
        return fixedOp ? builder(fixedOp, ...args) : builder(...args);
      }
      // bare identifier: keyword literal, constant, or variable
      if (name === "true" || name === "True") return bool(true);
      if (name === "false" || name === "False") return bool(false);
      const lc = name.toLowerCase();
      if (CONSTS[lc]) return constant(CONSTS[lc]);
      return variable(name);
    }
    throw new ExprError(`非法记号 "${tk.v}"`, src);
  }

  const node = parseExprTop();
  if (pos < toks.length) throw new ExprError(`多余的记号 "${peek().v}"`, src);
  return node;
}

/**
 * Parse a flat infix expression string into an IR value-block node.
 * Throws ExprError on any out-of-grammar / malformed input.
 */
export function parseExpr(src) {
  if (typeof src !== "string") throw new ExprError("表达式必须是字符串");
  const trimmed = src.trim();
  if (!trimmed) throw new ExprError("空表达式", src);
  const toks = tokenize(trimmed);
  if (!toks.length) throw new ExprError("空表达式", src);
  return parse(toks, trimmed);
}

// ---- expansion pass over ops ----------------------------------------------

function expandNode(node, errors, path) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const out = { ...node };
  if (node.inputs && typeof node.inputs === "object") {
    out.inputs = {};
    for (const [name, val] of Object.entries(node.inputs)) {
      if (typeof val === "string") {
        try {
          out.inputs[name] = parseExpr(val);
        } catch (e) {
          errors.push({ path: `${path}.inputs.${name}`, kind: "expr_error", detail: e.message, suggestions: [] });
          out.inputs[name] = val; // leave as-is; downstream validate will also flag
        }
      } else {
        out.inputs[name] = expandNode(val, errors, `${path}.inputs.${name}`);
      }
    }
  }
  if (node.statements && typeof node.statements === "object") {
    out.statements = {};
    for (const [name, seq] of Object.entries(node.statements)) {
      out.statements[name] = Array.isArray(seq)
        ? seq.map((n, i) => expandNode(n, errors, `${path}.statements.${name}[${i}]`))
        : seq;
    }
  }
  return out;
}

function expandBlocks(blocks, errors, path) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b, i) =>
    Array.isArray(b)
      ? expandBlocks(b, errors, `${path}[${i}]`)
      : expandNode(b, errors, `${path}[${i}]`),
  );
}

/**
 * Walk an op list and expand every string-valued `inputs` slot inside
 * `insert.blocks` into a real value-block node. Returns `{ ops, errors }`;
 * `errors` carry `kind:"expr_error"` with an `ops[i]...` path for repair feedback.
 * Non-insert ops (delete/move/setField/clear) are passed through untouched.
 */
export function expandOps(ops) {
  const errors = [];
  if (!Array.isArray(ops)) return { ops, errors };
  const out = ops.map((op, i) => {
    if (!op || typeof op !== "object" || op.op !== "insert" || !Array.isArray(op.blocks)) return op;
    return { ...op, blocks: expandBlocks(op.blocks, errors, `ops[${i}].blocks`) };
  });
  return { ops: out, errors };
}
