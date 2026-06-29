// src/ctx/assemble.mjs — Compose the layered context (L0–L7) into chat messages.
// The system message is the cacheable static prefix (L0 spec + L1 core + L2 core
// vocabulary + static few-shot). The user message carries the dynamic layers
// (L3 retrieved cards + L4 board knowledge + current workspace + request + L7
// error feedback). This mirrors Claude Code's static/dynamic prompt boundary.

import { LANGUAGE_SPEC, OPS_SPEC, renderCore, renderAntipatterns } from "./prompts.mjs";
import { renderSeeds, renderCurrentWithAnchors } from "./fewshot.mjs";
import { renderCardSection } from "./cards.mjs";

function cardsFor(types, catalog, limit) {
  const out = [];
  const seen = new Set();
  for (const t of types) {
    if (seen.has(t)) continue;
    seen.add(t);
    const s = catalog.get(t);
    if (s) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * @param o {
 *   request,
 *   catalog: Map<type,schema>,
 *   coreTypes: string[], retrievedTypes: string[],
 *   seeds: [{intent,ir}],
 *   core: object (knowledge core.json), antipatterns: object,
 *   withIds: IR with ids | null,            // current workspace, id-annotated
 *   anchors: [{key,label,...}],             // valid insertion points
 *   boardDocs: [{title,text}],              // L4 resolved version/module docs
 *   version: 'v2'|'v3'|'unknown',
 *   limits: { coreCards=60, retrievedCards=70 }
 * }
 * @returns chat messages array [{role, content}]
 */
export function assembleMessages(o) {
  const limits = o.limits || {};
  const coreCardLimit = limits.coreCards ?? 60;
  const retrievedLimit = limits.retrievedCards ?? 70;

  // ---- STATIC system prefix (cacheable) ----
  const coreVocab = cardsFor(o.coreTypes || [], o.catalog, coreCardLimit);
  const systemParts = [
    LANGUAGE_SPEC,
    OPS_SPEC,
    renderCore(o.core),
    renderAntipatterns(o.antipatterns),
    renderCardSection("核心词汇 (常用积木)", coreVocab),
    renderSeeds(o.seeds),
  ].filter(Boolean);
  const system = systemParts.join("\n\n---\n\n");

  // ---- DYNAMIC user message ----
  const coreSet = new Set((o.coreTypes || []).slice(0, coreCardLimit));
  const retrieved = cardsFor(
    (o.retrievedTypes || []).filter((t) => !coreSet.has(t)),
    o.catalog,
    retrievedLimit,
  );
  const userParts = [];
  const verNote =
    o.version && o.version !== "unknown"
      ? `# 目标板型: ${o.version}`
      : "# 目标板型: 未指定(若答案因 v2/v3 而异，按通用 API 处理或在思路里说明假设)";
  userParts.push(verNote);
  if (retrieved.length) {
    userParts.push(renderCardSection("可用积木 (与本需求相关，按需取用)", retrieved));
  }
  for (const doc of o.boardDocs || []) {
    userParts.push(`# 板子知识: ${doc.title}\n${doc.text}`);
  }
  userParts.push(renderCurrentWithAnchors(o.withIds, o.anchors));
  userParts.push(
    `# 任务\n你在编辑上面的工作区。需求: ${o.request}\n\n` +
      `请只输出一个 \`\`\`json { "ops": [...] } 编辑计划。`,
  );

  return [
    { role: "system", content: system },
    { role: "user", content: userParts.join("\n\n") },
  ];
}

/** Format a ValidationReport as concise repair feedback for the LLM (L7).
 *  `mode:"tool"` is for the agent loop: repair by calling edit_blocks again.
 *  The default keeps the legacy non-tool repair pipeline's JSON-code-block flow. */
export function renderRepairFeedback(report, o = {}) {
  const mode = o.mode || "json";
  const head = mode === "tool"
    ? "上一次 edit_blocks 工具调用未执行：编辑算子有以下问题。请修正后重新调用 edit_blocks，并把完整 ops 放在工具参数里，不要写成聊天正文 JSON："
    : "上一次的编辑算子有以下问题，请修正后重新输出完整的 `{ \"ops\": [...] }`：";
  const lines = [head];
  for (const e of report.errors.slice(0, 20)) {
    let line = `- [${e.kind}] ${e.path}: ${e.detail}`;
    if (e.suggestions?.length) line += `（可选: ${e.suggestions.slice(0, 6).join(", ")}）`;
    lines.push(line);
  }
  return lines.join("\n");
}
