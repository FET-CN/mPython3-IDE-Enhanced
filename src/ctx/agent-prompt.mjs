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
- **优先使用当前板型侧边栏真实可见的积木**：search_blocks 默认只返回用户能在当前侧边栏拖到的 block。不要因为 type 看起来“更新”就使用隐藏块；只有维护已有旧工程时，才可显式 includeHidden 搜索隐藏/兼容块。
- **mpython3_ 事件帽子块只有在侧边栏可见或 search_blocks 返回时才使用**。这类「当…时」帽子积木（如 mpython3_radio_recv、mpython3_button_event）没有 DO 语句插槽，事件体用锚点 at:"after" 顺接在帽子积木之后；只有检索卡片明确标出 statement 插槽的块才用 at:"body"。
- **mpython_main 是侧边栏可见的主程序标记**：它没有语句体，不能用 at:"body"；但它有 next 连接口，若当前工作区只有空的 mpython_main，应保留它，并把用户需求对应的可见执行积木用 anchor at:"after" 接到 mpython_main 后面。不要重建成侧边栏不可见的 mpython3_main。
- 多步骤、较复杂的需求：先用一句话给出计划，或用 update_todos 拆成任务清单逐步推进；遇到真正影响做法、又无法从上下文/合理默认推断的关键选择时，用 ask_user 给出选项让用户拍板，而不是猜测或长篇追问。
- 在多个改法之间权衡、或跑码报错后理思路时，可用 think 记录思考。
- edit_blocks / run_code 属于会改动工作区或操作设备的动作，执行前会请用户确认；run_code 还需已连接真实掌控板。
- **收尾前自检**：edit_blocks 成功后会回传"转换后的 Python"。给出最终回复前，先据此复审生成的代码——检查逻辑是否符合需求、缩进/嵌套是否正确、API 与目标板型是否匹配；若发现问题，再次调用 edit_blocks 修正，不要把有问题的结果直接交付。
- 已经正确的积木不要重建，只做达成需求所需的改动。`;

// How the per-tool channels map onto the IR/op grammar below.
export const TOOL_GUIDE = `# 工具一览
- read_workspace（只读）：读取当前工作区 IR(带 id) + 落点 + Python。改积木前必先调用。
- search_blocks（只读）：按关键词检索可用积木卡片（拿到确切 type/字段）。
- edit_blocks（写）：传入编辑算子 ops 修改工作区。**注意：通过本工具的 ops 参数下达算子，不要把算子写成聊天里的 json 代码块。**
- run_code（操作设备）：在已连接的掌控板上运行当前程序并回读串口输出，用于验证或闭环调试。
- ask_user（交互）：向用户提出带可点击选项的单一澄清问题并阻塞等待其选择；仅用于影响后续做法的关键决策。
- think（只读）：记录思考，不产生副作用。
- update_todos（只读）：维护可见任务清单。`;

// Old→new rename map: blocks retired from the live side palette and their
// current replacements (verified against the per-board toolbox snapshot). Stable,
// cacheable. Keeps the model off deprecated blocks it may know from training.
export const RETIRED_BLOCKS = `# 已下架的旧积木（改用新版）
下列旧积木已从积木栏移除，**不要使用**，请改用对应的新版积木：
- 显示 mpython_display_circle / fill_circle → mpython_display_shape_circle；mpython_display_rect / fill_rect → mpython_display_shape_rect；mpython_display_triangle / fill_triangle → mpython_display_shape_triangle
- RGB 灯 mpython_set_RGB(_all/_color) → mpython_set_rgb_list_color；按 RGB 值设 → mpython_set_rgb_list_number；mpython_off_RGB / rgb_clear → mpython_off_rgb_list
- 按键 mpython_button_is_pressed / both_pressed / Interrupt_AB → mpython_button_pressed，或事件写法 mpython3_button_event
- 逻辑 logic_operation → logic_operation_2；随机数 math_random_int → math_random_int_time
（不确定新名时用 search_blocks 检索确认；优先选积木栏里实际存在的积木。）`;


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
 *   coreTypes: string[], preferredTypes?: string[], seeds, core, antipatterns,
 *   version: 'v2'|'v3'|'unknown',
 *   limits?: { coreCards?: number, preferredCards?: number }
 * }
 */
export function buildAgentSystem(o) {
  const coreCardLimit = o.limits?.coreCards ?? 60;
  const preferredCardLimit = o.limits?.preferredCards ?? 40;
  const coreVocab = cardsFor(o.coreTypes, o.catalog, coreCardLimit);
  const preferredVocab = cardsFor(o.preferredTypes, o.catalog, preferredCardLimit);
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
    renderCardSection("侧边栏可见积木 (当前板型 · 优先使用)", preferredVocab),
    RETIRED_BLOCKS,
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
