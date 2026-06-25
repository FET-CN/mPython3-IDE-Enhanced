// src/ctx/agent-prompt.mjs — Build the multi-turn agent's system prompt. This is
// the STABLE, cacheable prefix (identity + tool guide + IR/op grammar + core
// vocabulary). It must not change turn-to-turn within a session so providers can
// cache it. Per-turn dynamics (current workspace, freshly retrieved blocks) ride
// the user message / are pulled via the read_workspace & search_blocks tools.

import { LANGUAGE_SPEC, OPS_SPEC, renderCore, renderAntipatterns } from "./prompts.mjs";
import { renderSeeds, renderCurrentWithAnchors } from "./fewshot.mjs";
import { renderCardSection } from "./cards.mjs";

// Identity, tone and safety — styled after Claude Code's system prompt, in zh-CN.
export const AGENT_IDENTITY = `你是「AI 图形化编程助手」，帮助用户在掌控板 (mPython/HandPy) 的图形化 IDE 里用中文自然语言编写、修改和调试积木程序。

# 语气与风格
- 用中文回答，简洁、直接、切中要点。除非用户要求详细解释，正文尽量控制在 4 行以内（不含工具调用与代码）。
- 不要寒暄铺垫（"好的，我来帮你…"），直接做事或回答。
- 解释积木/程序时面向中小学创客与教师，避免无谓术语。

# 安全
- 拒绝编写或解释可能被用于恶意用途的代码，即使用户声称用于学习。
- 不做与掌控板图形化编程无关的危险操作。

# 工作方式
- **改积木前必须先调用 read_workspace**，拿到当前积木的稳定 id 与合法落点，再用 edit_blocks 下达最小改动。
- 不确定某功能对应哪个积木时，调用 search_blocks 检索，不要臆造积木类型或字段。
- 多步骤、较复杂的需求：先用一句话给出计划，或用 update_todos 拆成任务清单逐步推进；必要时先向用户澄清关键细节再动手，而不是猜测。
- 在多个改法之间权衡、或跑码报错后理思路时，可用 think 记录思考。
- edit_blocks / run_code 属于会改动工作区或操作设备的动作，执行前会请用户确认；run_code 还需已连接真实掌控板。
- 已经正确的积木不要重建，只做达成需求所需的改动。`;

// How the per-tool channels map onto the IR/op grammar below.
export const TOOL_GUIDE = `# 工具一览
- read_workspace（只读）：读取当前工作区 IR(带 id) + 落点 + Python。改积木前必先调用。
- search_blocks（只读）：按关键词检索可用积木卡片（拿到确切 type/字段）。
- edit_blocks（写）：传入编辑算子 ops 修改工作区。**注意：通过本工具的 ops 参数下达算子，不要把算子写成聊天里的 json 代码块。**
- run_code（操作设备）：在已连接的掌控板上运行当前程序并回读串口输出，用于验证或闭环调试。
- think（只读）：记录思考，不产生副作用。
- update_todos（只读）：维护可见任务清单。`;

// Adapter: OPS_SPEC was written for a single-shot "output one json block" flow.
// Under tool-calling, the same op grammar applies but the channel is the
// edit_blocks tool argument. Make that explicit, then reuse OPS_SPEC verbatim.
const OPS_ADAPTER = `# 编辑算子语法（用于 edit_blocks 工具的 ops 参数）
下面描述编辑算子的语义与锚点规则。**在本助手里，你通过调用 edit_blocks 工具、把这些算子作为 \`ops\` 数组参数传入来下达**；请忽略下文中"只输出一个 json 代码块"之类的措辞——那是输出通道的旧说法，现在的输出通道就是 edit_blocks 工具。算子的语义、锚点、硬规则与示例仍然完全适用。`;

function cardsFor(types, catalog, limit) {
  const out = [];
  const seen = new Set();
  for (const t of types || []) {
    if (seen.has(t)) continue;
    seen.add(t);
    const s = catalog?.get?.(t);
    if (s) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build the stable system prompt string for the agent.
 * @param o {
 *   catalog: Map<type,schema>,
 *   coreTypes: string[], seeds, core, antipatterns,
 *   version: 'v2'|'v3'|'unknown',
 *   limits?: { coreCards?: number }
 * }
 */
export function buildAgentSystem(o) {
  const coreCardLimit = o.limits?.coreCards ?? 60;
  const coreVocab = cardsFor(o.coreTypes, o.catalog, coreCardLimit);
  const verNote =
    o.version && o.version !== "unknown"
      ? `# 目标板型: ${o.version}（按该版本的 API/几何作答）`
      : "# 目标板型: 未指定（若答案因 v2/v3 而异，按通用 API 处理或说明假设）";
  return [
    AGENT_IDENTITY,
    TOOL_GUIDE,
    verNote,
    LANGUAGE_SPEC,
    OPS_ADAPTER + "\n\n" + OPS_SPEC,
    renderCore(o.core),
    renderAntipatterns(o.antipatterns),
    renderCardSection("核心词汇 (常用积木)", coreVocab),
    renderSeeds(o.seeds),
  ].filter(Boolean).join("\n\n---\n\n");
}

/**
 * A compact, per-turn digest of the current workspace to prepend to a user turn,
 * so the model usually doesn't need a separate read_workspace round-trip. Pass
 * the id-annotated program + anchors (from host/ops.mjs).
 */
export function workspaceDigest(withIds, anchors) {
  const body = renderCurrentWithAnchors(withIds, anchors);
  return `# 当前工作区快照（可直接据此编辑；如需更细节再调用 read_workspace）\n${body}`;
}
