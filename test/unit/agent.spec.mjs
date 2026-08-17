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

  it("normalizes structured arguments before preflight, confirmation and execution", async () => {
    const seen = [];
    const writeTool = {
      name: "w", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: false, needsConfirm: true,
      normalizeArgs: (args) => ({ ok: true, args: { value: args.wire_value } }),
      preflight: (args) => { seen.push(["preflight", args]); return { ok: true }; },
      run: async (args) => { seen.push(["run", args]); return { content: "ok" }; },
    };
    const ctx = {
      session: { approvals: new Set() },
      confirm: async (_tool, args) => { seen.push(["confirm", args]); return "once"; },
    };
    await runAgentTurn({
      messages: [{ role: "user", content: "x" }], tools: [writeTool], ctx,
      client: scriptClient([{ tool_calls: [callOf("w", { wire_value: 7 })] }, { content: "done" }]),
    });
    expect(seen).toEqual([
      ["preflight", { value: 7 }],
      ["confirm", { value: 7 }],
      ["run", { value: 7 }],
    ]);
  });

  it("repairs a small tool-argument bracket imbalance before structural validation", async () => {
    const call = callOf("echo", { v: 42 });
    call.function.arguments += "}";
    const messages = [{ role: "user", content: "x" }];
    await runAgentTurn({
      messages, tools: [echoTool], ctx: {},
      client: scriptClient([{ tool_calls: [call] }, { content: "done" }]),
    });
    expect(messages.find((message) => message.role === "tool")?.content).toBe("echo:42");
    expect(messages.find((message) => message.role === "assistant")?.tool_calls[0].function.arguments)
      .toBe('{"v":42}');
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

  it("fails closed when a confirmed tool has no confirmation channel", async () => {
    let ran = false;
    const writeTool = {
      name: "w", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: false, needsConfirm: true,
      run: async () => { ran = true; return { content: "bad" }; },
    };
    const messages = [{ role: "user", content: "x" }];
    await runAgentTurn({
      messages, tools: [writeTool], ctx: { session: { approvals: new Set() } },
      client: scriptClient([{ tool_calls: [callOf("w", {})] }, { content: "ok" }]),
    });
    expect(ran).toBe(false);
    expect(messages.find((m) => m.role === "tool")?.content).toMatch(/无法向用户请求确认/);
  });

  it("can remove the concurrency cap for selected tool batches", async () => {
    let active = 0, peak = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fanout = {
      name: "fanout", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: true, needsConfirm: false,
      run: async () => { active++; peak = Math.max(peak, active); if (active === 8) release(); await gate; active--; return { content: "ok" }; },
    };
    const calls = Array.from({ length: 8 }, (_, i) => callOf("fanout", {}, "f" + i));
    await runAgentTurn({
      messages: [{ role: "user", content: "x" }], tools: [fanout],
      client: scriptClient([{ tool_calls: calls }, { content: "done" }]), ctx: {},
      unlimitedConcurrencyTools: ["fanout"],
    });
    expect(peak).toBe(8);
  });

  it("starts unbounded tools immediately even beside a stateful call", async () => {
    let active = 0, peak = 0, activeWhenWriteRan = -1;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fanout = {
      name: "fanout", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: true, needsConfirm: false, unboundedConcurrency: true,
      run: async () => { active++; peak = Math.max(peak, active); await gate; active--; return { content: "ok" }; },
    };
    const stateful = {
      name: "stateful", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: false, needsConfirm: false,
      run: async () => { activeWhenWriteRan = active; release(); return { content: "ok" }; },
    };
    const calls = [callOf("stateful", {}, "s"), ...Array.from({ length: 8 }, (_, i) => callOf("fanout", {}, "m" + i))];
    await runAgentTurn({
      messages: [{ role: "user", content: "x" }], tools: [stateful, fanout],
      client: scriptClient([{ tool_calls: calls }, { content: "done" }]), ctx: {},
    });
    expect(activeWhenWriteRan).toBe(8);
    expect(peak).toBe(8);
  });

  it("repairs preflight failures internally before confirmation or tool execution", async () => {
    let confirmed = 0, ran = 0, preflighted = 0;
    const writeTool = {
      name: "w", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: false, needsConfirm: true,
      preflight: async () => {
        preflighted++;
        return preflighted === 1
          ? { ok: false, content: "上一次 w 工具调用未执行：请修正后重新调用 w。" }
          : { ok: true };
      },
      run: async () => { ran++; return { content: "应用了" }; },
    };
    const client = scriptClient([
      { tool_calls: [callOf("w", { bad: true }, "bad")] },
      { tool_calls: [callOf("w", { ok: true }, "good")] },
      { content: "完成" },
    ]);
    const messages = [{ role: "user", content: "x" }];
    const events = [];
    const ctx = { session: { approvals: new Set() }, confirm: async () => { confirmed++; return "once"; } };
    const r = await runAgentTurn({ messages, tools: [writeTool], client, ctx, onEvent: (e) => events.push(e.type) });

    expect(r.final).toBe("完成");
    expect(preflighted).toBe(2);
    expect(confirmed).toBe(1);
    expect(ran).toBe(1);
    expect(events).toContain("assistant_discard");
    expect(events).toContain("tool_repair");
    expect(messages.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === "bad"))).toBe(false);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(messages.find((m) => m.role === "user" && /重新调用 w/.test(m.content))).toBeTruthy();
  });

  it("keeps queued messages when the same response fails preflight", async () => {
    let preflighted = false, injected = false;
    const tool = {
      name: "w", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: true, needsConfirm: false,
      preflight: async () => {
        if (preflighted) return { ok: true };
        preflighted = true;
        return { ok: false, content: "repair" };
      },
      run: async () => ({ content: "ok" }),
    };
    const messages = [{ role: "user", content: "x" }];
    const r = await runAgentTurn({
      messages, tools: [tool], ctx: {},
      client: scriptClient([{ tool_calls: [callOf("w", {})] }, { content: "done" }]),
      beforeAssistantDone: () => {
        if (injected) return [];
        injected = true;
        return ["queued during repair"];
      },
    });
    expect(r.final).toBe("done");
    expect(messages.some((message) => message.role === "user" && message.content === "queued during repair")).toBe(true);
  });

  it("stops cleanly when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runAgentTurn({ messages: [{ role: "user", content: "x" }], tools: [echoTool], client: scriptClient([{ content: "z" }]), ctx: {}, signal: ac.signal });
    expect(r.stopped).toBe("aborted");
  });

  it("injects queued messages between model steps before finishing", async () => {
    let injected = false;
    const client = scriptClient([{ content: "first" }, { content: "after inbox" }]);
    const messages = [{ role: "user", content: "x" }];
    const r = await runAgentTurn({
      messages, tools: [], client, ctx: {},
      beforeAssistantDone: () => {
        if (injected) return [];
        injected = true;
        return ["queued message"];
      },
    });
    expect(r.final).toBe("after inbox");
    expect(messages.some((m) => m.role === "user" && m.content === "queued message")).toBe(true);
  });

  it("injects messages queued during tool execution before the next model request", async () => {
    let releaseTool;
    let toolStarted;
    const started = new Promise((resolve) => { toolStarted = resolve; });
    const gate = new Promise((resolve) => { releaseTool = resolve; });
    const slow = {
      name: "slow", description: "", parameters: { type: "object", properties: {} },
      isReadOnly: true, needsConfirm: false,
      run: async () => { toolStarted(); await gate; return { content: "ok" }; },
    };
    const seen = [];
    let streamIndex = 0;
    const client = {
      stream: async (messages) => {
        seen.push(messages.map((message) => ({ ...message })));
        if (streamIndex++ === 0) return { content: "", tool_calls: [callOf("slow", {})] };
        return { content: "done", tool_calls: [] };
      },
    };
    const inbox = [];
    const turn = runAgentTurn({
      messages: [{ role: "user", content: "x" }], tools: [slow], client, ctx: {},
      beforeStep: () => inbox.splice(0),
    });
    await started;
    inbox.push("queued while tool ran");
    releaseTool();
    await turn;

    expect(seen).toHaveLength(2);
    expect(seen[1].some((message) => message.role === "user" && message.content === "queued while tool ran")).toBe(true);
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
