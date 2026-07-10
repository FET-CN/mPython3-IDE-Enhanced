import { describe, expect, it } from "vitest";
import {
  SUBAGENT_TOOLS,
  createSubagentManager,
} from "../../src/agent/subagents.mjs";
import {
  sendAgentMessageTool,
  spawnAgentTool,
  stopAgentTool,
} from "../../src/agent/tools/subagents.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, message = "condition was not met", timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

function done(final = "完成", steps = 1) {
  return { stopped: "done", final, steps };
}

function taskArgs(overrides = {}) {
  return {
    description: "检查工作区",
    prompt: "读取当前积木并报告结论",
    ...overrides,
  };
}

function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}

describe("createSubagentManager", () => {
  it("builds isolated context and exposes only the three read-only child tools", async () => {
    let invocation;
    const subagentsMarker = {};
    const manager = createSubagentManager({
      client: { model: "parent-model" },
      runner: async (args) => {
        invocation = {
          messages: cloneMessages(args.messages),
          toolNames: args.tools.map((tool) => tool.name),
          toolModes: args.tools.map((tool) => tool.isReadOnly),
          ctx: args.ctx,
        };
        args.messages.push({ role: "assistant", content: "只读检查完成" });
        return done("只读检查完成");
      },
    });

    const task = await manager.spawn(taskArgs({ agent_type: "explore" }), {
      parentMessages: [
        { role: "system", content: "父系统知识" },
        { role: "user", content: "父对话秘密" },
        { role: "assistant", content: "父回复" },
      ],
      ctx: {
        board: { id: "mPython" },
        subagents: subagentsMarker,
        confirm: async () => true,
        ask: async () => "answer",
        runAgentTurn: () => {},
      },
    });

    expect(task).toMatchObject({
      status: "completed",
      agent_type: "explore",
      context_mode: "isolated",
      result: "只读检查完成",
    });
    expect(invocation.messages).toHaveLength(2);
    expect(invocation.messages[0]).toMatchObject({ role: "system" });
    expect(invocation.messages[0].content).toContain("父系统知识");
    expect(invocation.messages[0].content).toContain("只读 SubAgent");
    expect(invocation.messages[0].content).toContain("专注探索和查证");
    expect(invocation.messages[1].content).toContain("读取当前积木并报告结论");
    expect(JSON.stringify(invocation.messages)).not.toContain("父对话秘密");
    expect(invocation.toolNames).toEqual(["read_workspace", "search_blocks", "think"]);
    expect(invocation.toolModes).toEqual([true, true, true]);
    expect(invocation.ctx.board).toEqual({ id: "mPython" });
    expect(invocation.ctx.parentAgentId).toBe(task.id);
    expect(invocation.ctx.session).toBeTruthy();
    expect(invocation.ctx).not.toHaveProperty("subagents");
    expect(invocation.ctx).not.toHaveProperty("confirm");
    expect(invocation.ctx).not.toHaveProperty("ask");
    expect(invocation.ctx).not.toHaveProperty("runAgentTurn");
    expect(invocation.ctx).not.toHaveProperty("subagentRunner");
    expect(invocation.ctx).not.toHaveProperty("toolCallId");
  });

  it("forks valid parent history but drops an incomplete tool-call tail", async () => {
    const seen = [];
    const manager = createSubagentManager({
      client: {},
      runner: async ({ messages }) => {
        seen.push(cloneMessages(messages));
        return done("计划完成");
      },
    });
    const parentMessages = [
      { role: "system", content: "父系统" },
      { role: "user", content: "第一轮用户消息" },
      { role: "assistant", content: "第一轮回复" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "pending", type: "function", function: { name: "read_workspace", arguments: "{}" } }],
      },
      { role: "user", content: "不应复制的损坏尾部" },
    ];

    const task = await manager.spawn(taskArgs({ agent_type: "plan", context_mode: "fork" }), { parentMessages });
    const fork = seen[0];

    expect(task.context_mode).toBe("fork");
    expect(fork.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(fork[1].content).toBe("第一轮用户消息");
    expect(fork[2].content).toBe("第一轮回复");
    expect(fork.at(-1).content).toContain("# SubAgent 任务");
    expect(JSON.stringify(fork)).not.toContain("pending");
    expect(JSON.stringify(fork)).not.toContain("损坏尾部");
  });

  it("waits for foreground work and returns immediately for background work", async () => {
    const foregroundGate = deferred();
    const foregroundStarted = deferred();
    const foregroundManager = createSubagentManager({
      client: {},
      runner: async () => {
        foregroundStarted.resolve();
        await foregroundGate.promise;
        return done("前台完成");
      },
    });

    let foregroundSettled = false;
    const foregroundPromise = foregroundManager.spawn(taskArgs()).then((value) => {
      foregroundSettled = true;
      return value;
    });
    await foregroundStarted.promise;
    expect(foregroundSettled).toBe(false);
    foregroundGate.resolve();
    await expect(foregroundPromise).resolves.toMatchObject({ status: "completed", background: false, result: "前台完成" });

    const backgroundGate = deferred();
    const backgroundStarted = deferred();
    const backgroundManager = createSubagentManager({
      client: {},
      runner: async () => {
        backgroundStarted.resolve();
        await backgroundGate.promise;
        return done("后台完成");
      },
    });
    const background = await backgroundManager.spawn(taskArgs({ run_in_background: true }));
    expect(background).toMatchObject({ status: "running", background: true });
    await backgroundStarted.promise;
    backgroundGate.resolve();
    await waitUntil(() => backgroundManager.get(background.id).status === "completed", "background task did not finish");
    expect(backgroundManager.get(background.id).result).toBe("后台完成");
  });

  it("cancels foreground work with its parent signal while background work survives", async () => {
    const started = [];
    let releaseBackground;
    const backgroundDone = new Promise((resolve) => { releaseBackground = resolve; });
    const runner = async ({ messages, signal }) => {
      const isBackground = messages.at(-1)?.content.includes("后台任务");
      started.push(isBackground ? "background" : "foreground");
      if (isBackground) {
        await backgroundDone;
        return done("后台独立完成");
      }
      return new Promise((resolve) => {
        const abort = () => resolve({ stopped: "aborted", final: "", steps: 0 });
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    };
    const manager = createSubagentManager({ client: {}, runner });
    const parent = new AbortController();
    const foregroundPromise = manager.spawn(taskArgs({ prompt: "前台任务" }), { signal: parent.signal });
    const background = await manager.spawn(taskArgs({ prompt: "后台任务", run_in_background: true }), { signal: parent.signal });
    await waitUntil(() => started.length === 2, "child tasks did not start");

    parent.abort();
    await expect(foregroundPromise).resolves.toMatchObject({ status: "killed", background: false });
    expect(manager.get(background.id).status).toBe("running");

    releaseBackground();
    await waitUntil(() => manager.get(background.id).status === "completed", "background task was cancelled with parent");
  });

  it("delivers messages to a running child in FIFO order", async () => {
    const started = deferred();
    const release = deferred();
    let injected = [];
    const manager = createSubagentManager({
      client: {},
      runner: async ({ messages, beforeAssistantDone }) => {
        started.resolve();
        await release.promise;
        injected = beforeAssistantDone();
        messages.push(...injected, { role: "assistant", content: "已处理补充消息" });
        return done("已处理补充消息");
      },
    });
    const task = await manager.spawn(taskArgs({ run_in_background: true }));
    await started.promise;

    manager.send(task.id, "第一条");
    manager.send(task.id, "第二条");
    manager.send(task.id, "第三条");
    release.resolve();

    await waitUntil(() => manager.get(task.id).status === "completed", "messaged task did not finish");
    expect(injected.map((message) => message.content)).toEqual([
      "# 父代理补充消息\n第一条",
      "# 父代理补充消息\n第二条",
      "# 父代理补充消息\n第三条",
    ]);
  });

  it("resumes a terminal child with its transcript, ID and latest configured client", async () => {
    const calls = [];
    const originalClient = { id: "original-client" };
    const updatedClient = { id: "updated-client" };
    const manager = createSubagentManager({
      client: originalClient,
      runner: async ({ messages, client: usedClient }) => {
        calls.push({ messages: cloneMessages(messages), client: usedClient });
        const final = calls.length === 1 ? "初次结论" : "续跑结论";
        messages.push({ role: "assistant", content: final });
        return done(final);
      },
    });
    const first = await manager.spawn(taskArgs({ name: "research" }));
    expect(first).toMatchObject({ status: "completed", run_id: 1, result: "初次结论" });

    manager.configure({ client: updatedClient });
    const resumed = manager.send("research", "请再检查一次");
    expect(resumed).toMatchObject({ id: first.id, status: "running", run_id: 2, background: true });
    await waitUntil(() => manager.get(first.id).status === "completed" && manager.get(first.id).run_id === 2, "resumed task did not finish");

    expect(calls).toHaveLength(2);
    expect(calls[0].client).toBe(originalClient);
    expect(calls[1].client).toBe(updatedClient);
    expect(calls[1].messages.some((message) => message.role === "assistant" && message.content === "初次结论")).toBe(true);
    expect(calls[1].messages.some((message) => message.role === "user" && message.content.endsWith("请再检查一次"))).toBe(true);
    expect(manager.get(first.id)).toMatchObject({ result: "续跑结论", run_id: 2 });
  });

  it("closes the final inbox race by continuing for a message queued after the last drain", async () => {
    const afterFinalDrain = deferred();
    const releaseFirstRun = deferred();
    let calls = 0;
    const manager = createSubagentManager({
      client: {},
      runner: async ({ messages, beforeAssistantDone }) => {
        calls++;
        if (calls === 1) {
          expect(beforeAssistantDone()).toEqual([]);
          afterFinalDrain.resolve();
          await releaseFirstRun.promise;
          return done("过早结论");
        }
        expect(messages.some((message) => message.role === "user" && message.content.endsWith("竞态补充"))).toBe(true);
        return done("包含补充后的结论");
      },
    });
    const task = await manager.spawn(taskArgs({ run_in_background: true }));
    await afterFinalDrain.promise;

    manager.send(task.id, "竞态补充");
    releaseFirstRun.resolve();

    await waitUntil(() => manager.get(task.id).status === "completed", "race task did not finish");
    expect(calls).toBe(2);
    expect(manager.get(task.id).result).toBe("包含补充后的结论");
  });

  it("does not let a stopped stale run overwrite a resumed generation", async () => {
    const stale = deferred();
    const firstStarted = deferred();
    let calls = 0;
    const manager = createSubagentManager({
      client: {},
      runner: async () => {
        calls++;
        if (calls === 1) {
          firstStarted.resolve();
          return stale.promise;
        }
        return done("新一代结果");
      },
    });
    const task = await manager.spawn(taskArgs({ run_in_background: true }));
    await firstStarted.promise;
    expect(manager.stop(task.id).status).toBe("killed");

    const resumed = manager.send(task.id, "重新执行");
    expect(resumed.run_id).toBe(2);
    await waitUntil(() => manager.get(task.id).status === "completed", "second generation did not finish");
    stale.reject(new Error("旧一代迟到失败"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.get(task.id)).toMatchObject({ status: "completed", run_id: 2, result: "新一代结果", error: null });
  });

  it("delivers each background notification once and restores it when its delivery turn is rewound", async () => {
    const manager = createSubagentManager({ client: {}, runner: async () => done("后台报告") });
    const task = await manager.spawn(taskArgs({ name: "notice", run_in_background: true }), { parentTurnId: "origin" });
    await waitUntil(() => manager.get(task.id).status === "completed", "notification task did not finish");

    expect(manager.pendingNotifications()).toHaveLength(1);
    const first = manager.takeNotifications("delivery-turn");
    expect(first.notifications).toHaveLength(1);
    expect(first.notifications[0]).toMatchObject({ id: task.id, delivered: true, delivered_turn_id: "delivery-turn" });
    expect(first.content).toContain("后台报告");
    expect(first.content).toMatch(/^<subagent_notifications>\n/);
    expect(first.content).toMatch(/\n<\/subagent_notifications>$/);
    expect(manager.takeNotifications("another-turn").notifications).toEqual([]);

    manager.rewind({ removedTurnIds: ["delivery-turn"] });
    expect(manager.has(task.id)).toBe(true);
    expect(manager.pendingNotifications()).toHaveLength(1);
    expect(manager.drainNotifications("redelivery-turn")).toHaveLength(1);
    expect(manager.pendingNotifications()).toEqual([]);
  });

  it("keeps overflow notifications pending instead of dropping clipped reports", async () => {
    const manager = createSubagentManager({ client: {}, runner: async () => done("x".repeat(8_000)) });
    const tasks = await Promise.all(Array.from({ length: 8 }, (_, index) => manager.spawn(taskArgs({
      name: `long-${index + 1}`,
      run_in_background: true,
    }))));
    await waitUntil(() => manager.list({ status: "completed" }).length === tasks.length, "long notification tasks did not finish");

    const first = manager.takeNotifications("first-delivery");
    expect(first.notifications.length).toBeGreaterThan(0);
    expect(first.notifications.length).toBeLessThan(tasks.length);
    expect(first.content.length).toBeLessThanOrEqual(20_000);
    for (const notification of first.notifications) expect(first.content).toContain(notification.name);
    expect(manager.pendingNotifications()).toHaveLength(tasks.length - first.notifications.length);

    const delivered = [...first.notifications];
    let delivery = 2;
    while (manager.pendingNotifications().length) {
      const batch = manager.takeNotifications(`delivery-${delivery++}`);
      expect(batch.notifications.length).toBeGreaterThan(0);
      expect(batch.content.length).toBeLessThanOrEqual(20_000);
      delivered.push(...batch.notifications);
    }
    expect(delivered.map((item) => item.id)).toEqual(tasks.map((task) => task.id));
    expect(manager.pendingNotifications()).toEqual([]);
  });

  it("bounds transcript JSON even when a tool call has huge arguments", async () => {
    const manager = createSubagentManager({
      client: {},
      runner: async ({ messages }) => {
        messages.push({
          role: "assistant",
          content: "准备调用工具",
          tool_calls: [{
            id: "huge-call",
            type: "function",
            function: { name: "read_workspace", arguments: "x".repeat(50_000) },
          }],
        });
        return done("完成");
      },
    });
    const task = await manager.spawn(taskArgs());
    const transcript = manager.get(task.id, { includeTranscript: true }).transcript;

    expect(JSON.stringify(transcript).length).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(transcript)).toContain("read_workspace");
    expect(transcript.some((message) => message.truncated)).toBe(true);
  });

  it("removes tasks owned by rewound turns and clear stops all remaining work", async () => {
    const running = deferred();
    const manager = createSubagentManager({
      client: {},
      runner: async ({ signal, messages }) => {
        if (messages.at(-1)?.content.includes("持续运行")) {
          return new Promise((resolve) => {
            const abort = () => resolve({ stopped: "aborted", final: "", steps: 0 });
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
            running.resolve();
          });
        }
        return done("短任务完成");
      },
    });
    const doomed = await manager.spawn(taskArgs({ run_in_background: true }), { parentTurnId: "doomed-turn" });
    await waitUntil(() => manager.get(doomed.id).status === "completed", "doomed task did not finish");
    manager.rewind({ removedTurnIds: ["doomed-turn"] });
    expect(manager.has(doomed.id)).toBe(false);

    const survivor = await manager.spawn(taskArgs({ prompt: "持续运行", run_in_background: true }), { parentTurnId: "kept-turn" });
    await running.promise;
    expect(manager.get(survivor.id).status).toBe("running");
    manager.clear();
    expect(manager.size()).toBe(0);
    expect(manager.pendingNotifications()).toEqual([]);
  });

  it("removes a task when a turn that sent it a follow-up message is rewound", async () => {
    const manager = createSubagentManager({ client: {}, runner: async () => done("完成") });
    const task = await manager.spawn(taskArgs(), { parentTurnId: "spawn-turn" });
    manager.send(task.id, "来自后续回合的补充", { parentTurnId: "message-turn" });
    await waitUntil(() => manager.get(task.id).run_id === 2 && manager.get(task.id).status === "completed", "follow-up generation did not finish");

    manager.rewind({ removedTurnIds: ["message-turn"] });
    expect(manager.has(task.id)).toBe(false);
  });

  it("starts more than six background children without an application-level cap", async () => {
    let active = 0;
    let peak = 0;
    const release = deferred();
    const manager = createSubagentManager({
      client: {},
      runner: async () => {
        active++;
        peak = Math.max(peak, active);
        await release.promise;
        active--;
        return done("完成");
      },
    });

    const tasks = await Promise.all(Array.from({ length: 8 }, (_, index) => manager.spawn(taskArgs({
      name: `agent-${index}`,
      run_in_background: true,
    }))));
    await waitUntil(() => active === 8, "not all eight SubAgents started concurrently");
    expect(peak).toBe(8);
    expect(tasks.every((task) => task.status === "running")).toBe(true);

    release.resolve();
    await waitUntil(() => manager.list({ status: "completed" }).length === 8, "concurrent tasks did not finish");
  });
});

describe("SubAgent tool contract", () => {
  it("keeps child tools read-only and prevents recursive delegation", () => {
    expect(SUBAGENT_TOOLS.map((tool) => tool.name)).toEqual(["read_workspace", "search_blocks", "think"]);
    expect(SUBAGENT_TOOLS.every((tool) => tool.isReadOnly && !tool.needsConfirm)).toBe(true);
    expect(SUBAGENT_TOOLS.some((tool) => tool.name.includes("agent"))).toBe(false);
  });

  it("allows spawn fan-out but serializes message and stop mutations without confirmation", () => {
    expect(spawnAgentTool).toMatchObject({ isReadOnly: true, needsConfirm: false, unboundedConcurrency: true });
    expect(sendAgentMessageTool).toMatchObject({ isReadOnly: false, needsConfirm: false });
    expect(stopAgentTool).toMatchObject({ isReadOnly: false, needsConfirm: false });
  });
});
