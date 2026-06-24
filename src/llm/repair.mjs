// src/llm/repair.mjs — Generate → apply-ops → repair loop. The model emits an
// edit-op plan; we apply+validate it against the current workspace and feed
// precise errors back (Claude-Code style tool_result feedback) up to maxRepairs
// times. Parse failures are fed back too.

import { extractOps } from "./extract.mjs";
import { expandOps } from "../ir/expr.mjs";
import { applyOps } from "../host/ops.mjs";
import { renderRepairFeedback } from "../ctx/assemble.mjs";

/** Net brace/bracket imbalance of a JSON string (ignores string contents). */
function braceImbalance(text) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return depth; // <0 = too many closers, >0 = too many openers
}

/** Turn a JSON.parse failure into actionable, brace-aware repair feedback. */
function renderParseFeedback(detail, raw) {
  const bal = braceImbalance(raw);
  let hint = "";
  if (bal < 0) hint = `\nJSON 括号不平衡：右括号比左括号多 ${-bal} 个。这通常是深层嵌套表达式收尾 \`}\` 数错——把数学/逻辑表达式改写成 inputs 的**表达式字符串简写**（如 "x":"20 + 20*cos(angle1)"）即可避免深嵌套。`;
  else if (bal > 0) hint = `\nJSON 括号不平衡：左括号比右括号多 ${bal} 个（有未闭合的 { 或 [）。同样建议用表达式字符串简写减少嵌套。`;
  return `输出无法解析为 JSON：${detail}${hint}\n请重新只输出一个 \`\`\`json { "ops": [...] } 编辑计划。`;
}


/**
 * @param o {
 *   baseMessages: [{role,content}],
 *   current: IR program WITH ids (annotateIds output),
 *   catalog: Map, client: (messages,opts)=>Promise<string>,
 *   maxRepairs=2, onProgress?: (ev)=>void, signal?
 * }
 * @returns { ok, ops, result, report, attempts, raw }
 */
export async function generateWithRepair(o) {
  const { baseMessages, current, catalog, client, maxRepairs = 2, onProgress, signal } = o;
  const messages = [...baseMessages];
  let lastOps = null;
  let lastReport = null;
  let lastResult = null;
  let raw = "";

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    onProgress?.({ phase: "generate", attempt });
    const sent = messages.slice(); // exact context assembled for this round
    raw = await client(messages, { signal });

    let ops;
    try {
      const parsed = extractOps(raw);
      ops = parsed.ops;
      if (parsed.repaired) {
        // The model emitted a small brace imbalance that we structurally
        // recovered. Surface it (debug + progress) so it's never silent.
        try { console.debug?.(`[m3e] JSON 括号自动修复：补正 ${parsed.fixes} 处后解析成功`); } catch {}
        onProgress?.({ phase: "json_repaired", attempt, fixes: parsed.fixes, raw, context: sent });
      }
    } catch (e) {
      onProgress?.({ phase: "parse_error", attempt, detail: e.message, raw, context: sent });
      if (attempt === maxRepairs) {
        return {
          ok: false, ops: null, result: null,
          report: { ok: false, errors: [{ path: "$", kind: "parse_error", detail: e.message }] },
          attempts: attempt + 1, raw,
        };
      }
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: renderParseFeedback(e.message, raw) });
      continue;
    }

    // Expand flat expression strings in insert.blocks into real value-block
    // nodes BEFORE validation/apply. Out-of-grammar strings surface as
    // expr_error and are fed back like any other repairable problem.
    const expanded = expandOps(ops);
    ops = expanded.ops;
    if (expanded.errors.length) {
      onProgress?.({ phase: "expr_error", attempt, errors: expanded.errors.length, raw, context: sent });
      if (attempt === maxRepairs) {
        return {
          ok: false, ops, result: null,
          report: { ok: false, errors: expanded.errors }, attempts: attempt + 1, raw,
        };
      }
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: renderRepairFeedback({ errors: expanded.errors }) });
      continue;
    }

    const applied = applyOps(current, ops, catalog);
    lastOps = ops;
    lastResult = applied.result;
    lastReport = { ok: applied.ok, errors: applied.errors };
    onProgress?.({ phase: "validate", attempt, ok: applied.ok, errors: applied.errors.length, raw, ir: applied.result, ops, report: lastReport, context: sent });
    if (applied.ok) {
      return { ok: true, ops, result: applied.result, report: lastReport, attempts: attempt + 1, raw };
    }
    if (attempt === maxRepairs) break;
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: renderRepairFeedback(lastReport) });
  }
  return { ok: false, ops: lastOps, result: lastResult, report: lastReport, attempts: maxRepairs + 1, raw };
}
