// src/agent/tools/think.mjs — No-op reasoning tool. Lets the model externalize a
// chain of thought for complex trade-offs without taking any action (mirrors
// Claude Code's ThinkTool). Surfaces the thought to the UI as a muted line.

export const thinkTool = {
  name: "think",
  description:
    "记录一段思考/权衡，不产生任何副作用。当你需要在多个改积木方案之间权衡、" +
    "规划复杂多步任务、或在跑码报错后梳理修复思路时使用。它不会修改工作区，" +
    "只把你的思路记录下来，便于你随后做出更好的决定。",
  parameters: {
    type: "object",
    properties: {
      thought: { type: "string", description: "你的思考内容（中文）" },
    },
    required: ["thought"],
  },
  isReadOnly: true,
  needsConfirm: false,
  async run(args, ctx) {
    ctx?.emit?.({ type: "think", thought: String(args?.thought || "") });
    return { content: "已记录思考。" };
  },
};
