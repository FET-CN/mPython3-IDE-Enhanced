// src/agent/tools/updateTodos.mjs — Maintain a visible task checklist for
// multi-step requests (mirrors Claude Code's TodoWrite). State lives in the
// in-memory session; the UI renders it. Pure bookkeeping, no workspace effect.

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export const updateTodosTool = {
  name: "update_todos",
  description:
    "维护一个可见的任务清单，用于多步骤需求。把任务拆成若干条，并随进度更新每条状态" +
    "（pending/in_progress/completed）。每次调用都用完整清单覆盖旧清单。" +
    "建议同一时刻只有一条 in_progress。简单的一两步任务无需使用。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "完整任务清单（覆盖式）",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "任务标题（中文，祈使句）" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["title", "status"],
        },
      },
    },
    required: ["todos"],
  },
  isReadOnly: true,
  needsConfirm: false,
  async run(args, ctx) {
    const list = Array.isArray(args?.todos) ? args.todos : [];
    const todos = list
      .map((t) => ({
        title: String(t?.title || "").trim(),
        status: STATUSES.has(t?.status) ? t.status : "pending",
      }))
      .filter((t) => t.title);
    if (ctx?.session) ctx.session.todos = todos;
    ctx?.emit?.({ type: "todos", todos });
    const done = todos.filter((t) => t.status === "completed").length;
    return { content: `任务清单已更新（${done}/${todos.length} 完成）。` };
  },
};
