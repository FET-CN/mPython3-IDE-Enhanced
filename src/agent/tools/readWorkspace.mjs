// src/agent/tools/readWorkspace.mjs — Read the current Blockly workspace as
// id-annotated IR + valid insertion anchors + generated Python. This is what the
// model calls before editing, so edit_blocks ops can target stable ids (b1, b2…).
// All host access goes through caps (anti-corruption layer in src/host/).

import { readWorkspaceIR, readPyCode } from "../../host/read.mjs";
import { annotateIds, enumerateAnchors } from "../../host/ops.mjs";
import { renderCurrentWithAnchors } from "../../ctx/fewshot.mjs";

export const readWorkspaceTool = {
  name: "read_workspace",
  description:
    "读取当前图形化工作区：返回带稳定 id 的积木结构（IR）、所有合法落点（anchors）" +
    "以及生成的 Python 代码。**在调用 edit_blocks 修改积木之前，必须先调用本工具**，" +
    "这样你才能用正确的 id 和落点来定位编辑位置。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  isReadOnly: true,
  needsConfirm: false,
  async run(_args, ctx) {
    const caps = ctx?.caps;
    if (!caps) return { is_error: true, content: "无法访问宿主工作区。" };
    const program = readWorkspaceIR(caps);
    const withIds = annotateIds(program || []);
    const anchors = enumerateAnchors(withIds, ctx.data?.catalog);
    const py = readPyCode(caps);
    if (ctx.session) { ctx.session.withIds = withIds; ctx.session.anchors = anchors; }
    const parts = [renderCurrentWithAnchors(withIds, anchors)];
    if (py && py.trim()) parts.push("# 当前生成的 Python\n```python\n" + py.trim() + "\n```");
    return { content: parts.join("\n\n"), display: { blocks: countNodes(withIds) } };
  },
};

function countNodes(withIds) {
  let n = 0;
  const walk = (node) => {
    n++;
    for (const v of Object.values(node.inputs || {})) walk(v);
    for (const seq of Object.values(node.statements || {})) for (const c of seq) walk(c);
  };
  for (const stack of withIds || []) for (const node of stack) walk(node);
  return n;
}
