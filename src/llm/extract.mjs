// src/llm/extract.mjs — Pull the IR program out of an LLM response. Prefers a
// fenced ```json block; falls back to the last balanced top-level array/object.

import { balancedSlice } from "../../tools/lib/scan.mjs";

/** Find the JSON IR in `text`. Returns parsed value or throws with context. */
export function extractIR(text) {
  const candidates = [];

  // 1. fenced ```json ... ``` (last one wins — models often restate)
  const fenceRe = /```(?:json|jsonc|JSON)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) candidates.push(m[1].trim());

  // 2. no fence → first balanced [ ... ] or { ... }
  if (candidates.length === 0) {
    const startArr = text.indexOf("[");
    const startObj = text.indexOf("{");
    const start =
      startArr === -1 ? startObj : startObj === -1 ? startArr : Math.min(startArr, startObj);
    if (start !== -1) {
      const slice = balancedSlice(text, start);
      if (slice) candidates.push(slice);
    }
  }

  let lastErr;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(stripJsonComments(candidates[i]));
      return normalizeProgram(v);
    } catch (e) {
      lastErr = e;
    }
  }
  // tolerant fallback: recover from a small brace imbalance (see repairJson)
  const looseV = looseParseCandidates(candidates);
  if (looseV) return normalizeProgram(looseV.value);
  throw new Error(
    `无法从 LLM 输出中解析出 IR JSON: ${lastErr?.message || "未找到 JSON"}`,
  );
}

/**
 * Tolerant structural JSON repair. Walks the text honoring strings and:
 *  - DROPS a closing `}`/`]` whose type doesn't match the currently-open
 *    container (a stray `}` while inside an array, or `]` inside an object) —
 *    this is how models over-/mis-close at the tail of moderately nested output;
 *  - APPENDS the closers for any containers still open at EOF (truncation).
 * Returns { out, fixes } where fixes = dropped + appended (0 = nothing changed).
 * Used ONLY as a fallback after strict JSON.parse fails, and the result still
 * flows through validate()/applyOps(), so it cannot smuggle in broken structure.
 */
export function repairJson(s) {
  let out = "";
  const stack = [];
  let inStr = false, esc = false, dropped = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "{" || c === "[") { stack.push(c); out += c; continue; }
    if (c === "}" || c === "]") {
      const want = c === "}" ? "{" : "[";
      if (stack.length && stack[stack.length - 1] === want) { stack.pop(); out += c; }
      else dropped++; // stray closer of the wrong type → drop it
      continue;
    }
    out += c;
  }
  const appended = stack.length;
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  return { out, fixes: dropped + appended };
}

// Bound how much repair we tolerate, so we recover honest off-by-a-few brace
// slips but never "repair" wholesale garbage into a plausible-but-wrong tree.
const MAX_JSON_FIXES = 6;

/** Try repairJson on each candidate (last-first); return {value,fixes} or null. */
function looseParseCandidates(candidates) {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const { out, fixes } = repairJson(stripJsonComments(candidates[i]));
    if (fixes === 0 || fixes > MAX_JSON_FIXES) continue;
    try {
      return { value: JSON.parse(out), fixes };
    } catch { /* repair didn't yield valid JSON → skip */ }
  }
  return null;
}


/** Tolerate accidental // and /* *​/ comments the model may emit. */
function stripJsonComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n\r]*/g, "$1");
}

/** Collect candidate JSON snippets from an LLM response (fenced first, then a
 *  balanced object/array). Shared by extractIR and extractOps. */
function jsonCandidates(text) {
  const candidates = [];
  const fenceRe = /```(?:json|jsonc|JSON)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) candidates.push(m[1].trim());
  if (candidates.length === 0) {
    const startArr = text.indexOf("[");
    const startObj = text.indexOf("{");
    const start =
      startArr === -1 ? startObj : startObj === -1 ? startArr : Math.min(startArr, startObj);
    if (start !== -1) {
      const slice = balancedSlice(text, start);
      if (slice) candidates.push(slice);
    }
  }
  return candidates;
}

/**
 * Pull an edit-op list out of an LLM response. Accepts `{ "ops": [...] }`, a
 * bare op array `[ {op:...}, ... ]`, or a single op object. Returns `{ ops }`.
 */
export function extractOps(text) {
  const candidates = jsonCandidates(text);
  let lastErr;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(stripJsonComments(candidates[i]));
      return { ops: normalizeOps(v), repaired: false, fixes: 0 };
    } catch (e) {
      lastErr = e;
    }
  }
  // tolerant fallback: recover from a small brace imbalance before giving up.
  const loose = looseParseCandidates(candidates);
  if (loose) return { ops: normalizeOps(loose.value), repaired: true, fixes: loose.fixes };
  throw new Error(`无法从 LLM 输出中解析出编辑算子 JSON: ${lastErr?.message || "未找到 JSON"}`);
}

/** Normalize various op-list shapes into an op array. */
export function normalizeOps(v) {
  if (v && !Array.isArray(v) && typeof v === "object") {
    if (Array.isArray(v.ops)) return v.ops;
    if (v.op) return [v]; // a single op object
    throw new Error("编辑算子对象需含 ops 数组");
  }
  if (!Array.isArray(v)) throw new Error("编辑算子顶层必须是 { ops:[...] } 或算子数组");
  return v;
}

/**
 * Accept either a Program (Stack[]), a single Stack (Node[]), a single Node, or
 * { program: ... } / { ir: ... } wrappers, and normalize to Program (Stack[]).
 */
export function normalizeProgram(v) {
  if (v && !Array.isArray(v) && typeof v === "object") {
    if (v.program) return normalizeProgram(v.program);
    if (v.ir) return normalizeProgram(v.ir);
    if (v.type) return [[v]]; // a bare node
  }
  if (!Array.isArray(v)) throw new Error("IR 顶层必须是数组(栈数组)");
  if (v.length === 0) return [];
  const allNodes = v.every((e) => e && typeof e === "object" && !Array.isArray(e));
  if (allNodes) return [v]; // single stack
  return v.map((s) => (Array.isArray(s) ? s : [s]));
}
