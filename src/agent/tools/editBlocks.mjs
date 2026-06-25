// src/agent/tools/editBlocks.mjs — The core write tool. The model emits an
// edit-op plan as the tool argument; we expand expression strings, apply the ops
// to the current id-annotated workspace, and validate. On failure we return the
// precise errors as a tool_result so the SAME agent self-corrects and recalls —
// the main loop IS the repair loop (no nested LLM). On success we surgically
// patch the pre-edit workspace XML (preserving untouched blocks) and inject.

import { expandOps } from "../../ir/expr.mjs";
import { annotateIds, applyOps } from "../../host/ops.mjs";
import { readWorkspaceIR } from "../../host/read.mjs";
import { snapshot, injectOps } from "../../host/inject.mjs";
import { renderRepairFeedback } from "../../ctx/assemble.mjs";

/**
 * Pure plan step: expand + apply + validate ops against an id-annotated program.
 * Host-free, so it is unit-testable. Returns:
 *   { ok:true, ops: expandedOps, result }  — validated post-edit IR
 *   { ok:false, feedback }                 — repair feedback string for the model
 */
export function planEdit(currentWithIds, ops, catalog) {
  if (!Array.isArray(ops)) return { ok: false, feedback: "ops 必须是一个数组。" };
  const expanded = expandOps(ops);
  if (expanded.errors.length) {
    return { ok: false, feedback: renderRepairFeedback({ errors: expanded.errors }) };
  }
  const applied = applyOps(currentWithIds, expanded.ops, catalog);
  if (!applied.ok) {
    return { ok: false, feedback: renderRepairFeedback({ errors: applied.errors }) };
  }
  return { ok: true, ops: expanded.ops, result: applied.result };
}

export const editBlocksTool = {
  name: "edit_blocks",
  description:
    "修改图形化工作区：传入一组编辑算子（ops），对当前积木进行插入/删除/移动/改字段/清空。" +
    "调用前**必须先 read_workspace** 以获得正确的 id 与落点。算子语法见系统说明；" +
    "数学/逻辑表达式请用表达式字符串简写（如 \"x\":\"20 + 20*cos(angle)\"）避免深层嵌套。" +
    "若校验失败，本工具会返回精确错误，请据此修正后重试。",
  parameters: {
    type: "object",
    properties: {
      ops: {
        type: "array",
        description:
          '编辑算子数组。每项形如 {op:"insert"|"delete"|"move"|"setField"|"clear", ...}。' +
          "insert/move 需带 anchor 落点 {at,id?,input?,index?}。",
        items: { type: "object" },
      },
    },
    required: ["ops"],
  },
  isReadOnly: false,
  needsConfirm: true,
  async run(args, ctx) {
    const caps = ctx?.caps;
    const catalog = ctx?.data?.catalog;
    if (!caps || !catalog) return { is_error: true, content: "无法访问宿主工作区或知识库。" };

    const current = annotateIds(readWorkspaceIR(caps) || []);
    const plan = planEdit(current, args?.ops, catalog);
    if (!plan.ok) return { is_error: true, content: plan.feedback };

    // Surgically patch the pre-edit snapshot so untouched blocks keep their exact
    // XML (shadows/positions/mutations). Snapshot also drives /undo.
    const snap = snapshot(caps);
    const inj = injectOps(caps, snap.xml, plan.ops, { catalog });
    if (ctx.session) ctx.session.lastSnapshot = snap;
    if (!inj.ok) {
      return { is_error: true, content: "注入算子有误：" + (inj.errors || []).map((e) => e.detail).join("；") };
    }
    ctx?.emit?.({ type: "applied", ops: plan.ops, blockCount: inj.blockCount, ir: plan.result });
    return { content: `已应用编辑，工作区现有 ${inj.blockCount ?? "?"} 个积木。`, display: { blockCount: inj.blockCount } };
  },
};
