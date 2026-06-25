import { describe, it, expect } from "vitest";
import { runAgentTurn } from "../../src/agent/loop.mjs";
import { planEdit } from "../../src/agent/tools/editBlocks.mjs";

/** A scripted client: yields queued assistant turns in order. */
function scriptClient(turns) {
  let i = 0;
  return {
    stream: async (_messages, { onDelta } = {}) => {
      const t = turns[i++] || { content: "" };
      if (t.content) onDelta?.(t.content);
      return { role: "assistant", content: t.content || "", tool_calls: t.tool_calls, finish_reason: t.tool_calls ? "tool_calls" : "stop" };
    },
  };
}

const callOf = (name, args, id = name + "-1") => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});

const echoTool = {
  name: "echo", description: "", parameters: { type: "object", properties: {} },
  isReadOnly: true, needsConfirm: false,
  run: async (args) => ({ content: "echo:" + (args?.v ?? "") }),
};

describe("runAgentTurn", () => {
  it("terminates immediately when the model answers with no tool calls", async () => {
    const client = scriptClient([{ content: "你好" }]);
    const messages = [{ role: "user", content: "hi" }];
    const r = await runAgentTurn({ messages, tools: [echoTool], client, ctx: {} });
    expect(r.final).toBe("你好");
    expect(r.stopped).toBe("done");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "你好" });
  });

  it("executes a tool call, feeds the result back, then finishes", async () => {
    const client = scriptClient([
      { tool_calls: [callOf("echo", { v: 42 })] },
      { content: "完成" },
    ]);
    const messages = [{ role: "user", content: "go" }];
    const events = [];
    const r = await runAgentTurn({ messages, tools: [echoTool], client, ctx: {}, onEvent: (e) => events.push(e.type) });
    expect(r.final).toBe("完成");
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ role: "tool", name: "echo", content: "echo:42" });
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_result");
  });

  it("returns an error tool_result for unknown tools instead of throwing", async () => {
    const client = scriptClient([
      { tool_calls: [callOf("nope", {})] },
      { content: "ok" },
    ]);
    const messages = [{ role: "user", content: "x" }];
    await runAgentTurn({ messages, tools: [echoTool], client, ctx: {} });
    expect(messages.find((m) => m.role === "tool").content).toMatch(/未知工具/);
  });

  it("runs read-only tool calls concurrently", async () => {
    let active = 0, peak = 0;
    const slow = {
      name: "slow", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: true, needsConfirm: false,
      run: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; return { content: "ok" }; },
    };
    const client = scriptClient([
      { tool_calls: [callOf("slow", {}, "a"), callOf("slow", {}, "b"), callOf("slow", {}, "c")] },
      { content: "done" },
    ]);
    await runAgentTurn({ messages: [{ role: "user", content: "x" }], tools: [slow], client, ctx: {} });
    expect(peak).toBeGreaterThan(1);
  });

  it("honors the confirmation gate: rejection yields a refusal tool_result", async () => {
    const writeTool = {
      name: "w", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: false, needsConfirm: true,
      run: async () => ({ content: "应用了" }),
    };
    const client = scriptClient([
      { tool_calls: [callOf("w", {})] },
      { content: "好的" },
    ]);
    const messages = [{ role: "user", content: "x" }];
    const ctx = { session: { approvals: new Set() }, confirm: async () => false };
    await runAgentTurn({ messages, tools: [writeTool], client, ctx });
    expect(messages.find((m) => m.role === "tool").content).toMatch(/拒绝/);
  });

  it("stops cleanly when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runAgentTurn({ messages: [{ role: "user", content: "x" }], tools: [echoTool], client: scriptClient([{ content: "z" }]), ctx: {}, signal: ac.signal });
    expect(r.stopped).toBe("aborted");
  });
});

describe("planEdit (pure)", () => {
  const catalog = new Map([
    ["text_print", { type: "text_print", statements: [], values: [{ name: "TEXT", check: null }], fields: [], prev: true, next: true }],
    ["text", { type: "text", fields: [{ name: "TEXT" }], output: "String" }],
  ]);
  it("applies a clear+insert plan and returns post-edit IR", () => {
    const ops = [
      { op: "clear" },
      { op: "insert", anchor: { at: "new" }, blocks: [{ type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "hi" } } } }] },
    ];
    const r = planEdit([], ops, catalog);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.result)).toContain("text_print");
  });
  it("returns repair feedback (not a throw) for an unknown block type", () => {
    const r = planEdit([], [{ op: "insert", anchor: { at: "new" }, blocks: [{ type: "no_such_block" }] }], catalog);
    expect(r.ok).toBe(false);
    expect(typeof r.feedback).toBe("string");
    expect(r.feedback.length).toBeGreaterThan(0);
  });
});

describe("ask_user tool", () => {
  it("blocks on ctx.ask and returns the user's choice as the tool result", async () => {
    const { askUserTool } = await import("../../src/agent/tools/askUser.mjs");
    const options = [{ label: "掌控板V3" }, { label: "掌控板V2" }];
    const ask = async (q) => { expect(q.options).toHaveLength(2); return "掌控板V3"; };
    const out = await askUserTool.run({ question: "目标板型？", options }, { ask });
    expect(out.is_error).toBeFalsy();
    expect(out.content).toContain("掌控板V3");
  });

  it("joins multi-select labels", async () => {
    const { askUserTool } = await import("../../src/agent/tools/askUser.mjs");
    const out = await askUserTool.run(
      { question: "要哪些功能？", options: [{ label: "A" }, { label: "B" }], multi_select: true },
      { ask: async () => ["A", "B"] },
    );
    expect(out.content).toContain("A、B");
  });

  it("degrades gracefully when the user dismisses the question", async () => {
    const { askUserTool } = await import("../../src/agent/tools/askUser.mjs");
    const out = await askUserTool.run(
      { question: "x", options: [{ label: "A" }, { label: "B" }] },
      { ask: async () => null },
    );
    expect(out.is_error).toBeFalsy();
    expect(out.content).toContain("未选择");
  });

  it("errors when fewer than two options are provided", async () => {
    const { askUserTool } = await import("../../src/agent/tools/askUser.mjs");
    const out = await askUserTool.run({ question: "x", options: [{ label: "only" }] }, { ask: async () => "only" });
    expect(out.is_error).toBe(true);
  });

  it("is serial (not read-only) and never gated behind the write-confirm dialog", async () => {
    const { askUserTool } = await import("../../src/agent/tools/askUser.mjs");
    expect(askUserTool.isReadOnly).toBe(false);
    expect(askUserTool.needsConfirm).toBe(false);
  });
});
