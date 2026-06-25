// src/agent/tools/searchBlocks.mjs — Keyword-search the block catalog and return
// the matching block "cards" (type, zh, fields/values, IO kind, input slots) so
// the model can pull just the vocabulary it needs on demand, instead of the whole
// catalog being dumped into the prompt. Reuses the existing retriever + renderer.

import { retrieve } from "../../kb/retriever.mjs";
import { renderCardSection } from "../../ctx/cards.mjs";

export const searchBlocksTool = {
  name: "search_blocks",
  description:
    "按关键词检索可用积木，返回相关积木的卡片（类型、中文名、字段/取值、输入槽）。" +
    "当你不确定某个功能对应哪个积木、或需要某类积木的确切 type 与字段时使用。" +
    "用空格分隔多个关键词，例如「温度 显示 屏幕」。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "中文关键词（空格分隔）" },
      limit: { type: "number", description: "返回卡片数上限，默认 30" },
    },
    required: ["query"],
  },
  isReadOnly: true,
  needsConfirm: false,
  async run(args, ctx) {
    const query = String(args?.query || "").trim();
    if (!query) return { is_error: true, content: "query 不能为空。" };
    const index = ctx?.data?.index;
    const catalog = ctx?.data?.catalog;
    if (!index || !catalog) return { is_error: true, content: "知识库未就绪。" };
    const limit = Math.max(1, Math.min(Number(args?.limit) || 30, 80));
    const { types } = retrieve(query, index, { topN: limit, board: ctx.board?.board, preferGroups: ["mpython3"] });
    const schemas = [];
    for (const t of types) {
      const s = catalog.get(t);
      if (s) schemas.push(s);
      if (schemas.length >= limit) break;
    }
    if (!schemas.length) return { content: `没有检索到与「${query}」相关的积木。` };
    return { content: renderCardSection(`检索结果：${query}`, schemas) };
  },
};
