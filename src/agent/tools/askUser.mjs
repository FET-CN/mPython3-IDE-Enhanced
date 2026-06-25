// src/agent/tools/askUser.mjs — Structured clarifying-question tool (mirrors
// Claude Code's AskUserQuestion). Instead of ending the turn with a free-text
// question, the model calls this to render clickable options and BLOCKS until the
// user chooses; the choice comes back as the tool_result so the same turn resumes.
// The UI primitive is provided via ctx.ask (wired in main.mjs); host-free here.

export const askUserTool = {
  name: "ask_user",
  description:
    "向用户提出一个需要其拍板的澄清问题，并给出可点击的选项；工具会阻塞直到用户选择，" +
    "然后把用户的选择作为结果返回给你。**仅用于真正影响后续做法、无法从上下文或合理默认推断的关键决策**" +
    "（例如：用哪种触发方式、v2/v3 行为不一致需用户确认、多个实现取向二选一）。" +
    "不要用它问可自行决定的小事或寒暄；一次只问一个问题。若只是普通追问，直接用正文提问即可。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "要问用户的问题（中文，具体、单一）。" },
      options: {
        type: "array",
        description: "2–4 个互斥选项；建议把推荐项放第一个。每项含 label，可选 description。",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "选项简短标题（1–5 字/词）" },
            description: { type: "string", description: "可选：该选项的含义或取舍说明" },
          },
          required: ["label"],
        },
        minItems: 2,
        maxItems: 4,
      },
      multi_select: { type: "boolean", description: "是否允许多选，默认否。" },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
  // Interactive but does not mutate the workspace; keep it serial (not batched
  // with read-only tools) and never gate it behind the write-confirm dialog.
  isReadOnly: false,
  needsConfirm: false,
  async run(args, ctx) {
    const question = String(args?.question || "").trim();
    const options = Array.isArray(args?.options) ? args.options.filter((o) => o && o.label) : [];
    if (!question || options.length < 2) {
      return { is_error: true, content: "ask_user 需要一个问题和至少两个选项。" };
    }
    if (!ctx?.ask) return { is_error: true, content: "当前环境不支持交互提问，请改用正文向用户提问。" };

    const choice = await ctx.ask({ question, options, multi: !!args?.multi_select });
    if (choice == null || (Array.isArray(choice) && choice.length === 0)) {
      return { content: "用户未选择（关闭了提问）。请改用正文澄清，或按合理默认继续并说明假设。" };
    }
    const picked = Array.isArray(choice) ? choice.join("、") : choice;
    return { content: `用户选择：${picked}` };
  },
};
