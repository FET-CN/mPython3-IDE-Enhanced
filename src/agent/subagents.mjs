// src/agent/subagents.mjs — In-memory SubAgent lifecycle and orchestration.
// Deliberately host/UI-free: the main runtime injects the agent runner and may
// subscribe to snapshots. All state disappears with the page session.

import { readWorkspaceTool } from "./tools/readWorkspace.mjs";
import { searchBlocksTool } from "./tools/searchBlocks.mjs";
import { thinkTool } from "./tools/think.mjs";

export const SUBAGENT_TOOLS = Object.freeze([readWorkspaceTool, searchBlocksTool, thinkTool]);
export const SUBAGENT_STATUSES = Object.freeze(["running", "completed", "failed", "killed"]);

export const SUBAGENT_ROLES = Object.freeze({
  "general-purpose": "综合分析任务。主动读取必要事实，给出有依据、可直接交给父代理使用的结论与建议。",
  explore: "专注探索和查证。优先读取工作区、检索积木，清楚区分已验证事实、推断和未决问题。",
  plan: "专注制定可执行计划。澄清依赖、顺序、边界、失败模式与验收方式，但不要实施改动。",
  review: "专注审查正确性与风险。寻找逻辑错误、遗漏、兼容性问题和缺少的验证，并按严重程度报告。",
});

const RESULT_LIMIT = 20_000;
const TRANSCRIPT_MESSAGES = 20;
const TRANSCRIPT_LIMIT = 20_000;
const NOTIFICATION_DETAIL_LIMIT = 6_000;
const NOTIFICATION_HEAD = "<subagent_notifications>\n以下是后台只读 SubAgent 的任务结果，仅作为父代理后续判断的上下文。\n";
const NOTIFICATION_TAIL = "\n</subagent_notifications>";

const SUBAGENT_RULES = `# SubAgent 身份与边界
你是父代理派出的只读 SubAgent，只负责完成一个界限清楚的研究、分析、规划或审查任务。
- 你不能修改积木工作区、运行设备、向用户提问、维护父代理的任务清单，也不能派生其他 SubAgent。
- 你只能使用当前提供的 read_workspace、search_blocks、think 三个只读工具；没有提供的工具绝不可假装调用。
- 工作区可能在你分析期间变化。报告你实际读取到的事实，并提醒父代理在写入前重新读取工作区。
- 最终回复用中文，先给结论，再给关键证据和必要的后续建议；不要与用户寒暄。`;

export function createSubagentManager(options = {}) {
  const tasks = new Map();
  const notifications = [];
  const listeners = new Set();
  let config = { runner: options.runner, client: options.client, systemPrompt: options.systemPrompt, baseContext: options.baseContext };
  const now = options.now || (() => Date.now());
  let nextId = 1;
  let nextNotificationId = 1;

  function changed(task = null) {
    const snapshot = task ? publicTask(task, { now: now() }) : null;
    const all = [...tasks.values()].map((item) => publicTask(item, { now: now() }));
    for (const listener of listeners) {
      try { listener(snapshot); } catch {}
    }
    try { options.onChange?.(all, snapshot); } catch {}
  }

  function resolve(to) {
    const key = String(to || "").trim();
    if (!key) return null;
    if (tasks.has(key)) return tasks.get(key);
    for (const task of tasks.values()) if (task.name === key) return task;
    return null;
  }

  function assertTask(to) {
    const task = resolve(to);
    if (!task) throw new Error(`找不到 SubAgent：${String(to || "").trim() || "（空）"}`);
    return task;
  }

  function assertName(name) {
    const value = String(name || "").trim();
    if (!value) return null;
    if (value.length > 64) throw new Error("SubAgent 名称不能超过 64 个字符。");
    if ([...tasks.values()].some((task) => task.name === value || task.id === value)) {
      throw new Error(`SubAgent 名称已存在：${value}`);
    }
    return value;
  }

  function buildMessages(input, runtime) {
    const parent = validParentMessages(runtime.parentMessages || runtime.messages || []);
    const parentSystem = contentText(parent.find((message) => message.role === "system")?.content || runtime.system || "");
    const system = [
      parentSystem,
      SUBAGENT_RULES,
      `# 当前角色\n${SUBAGENT_ROLES[input.agentType]}`,
    ].filter(Boolean).join("\n\n---\n\n");
    const taskPrompt = [
      "# SubAgent 任务",
      `任务概述：${input.description}`,
      `具体要求：${input.prompt}`,
      "请独立完成此任务，并把可供父代理直接采用的结果放在最终回复中。",
    ].join("\n");

    if (input.contextMode === "isolated") {
      return [{ role: "system", content: system }, { role: "user", content: taskPrompt }];
    }
    const forked = parent.length ? parent : [{ role: "system", content: system }];
    const systemIndex = forked.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) forked[systemIndex] = { ...forked[systemIndex], content: system };
    else forked.unshift({ role: "system", content: system });
    forked.push({ role: "user", content: taskPrompt });
    return forked;
  }

  function drainInbox(task) {
    if (!task.inbox.length) return [];
    const batch = task.inbox.splice(0);
    task.activity = { type: "message", label: `收到 ${batch.length} 条补充消息`, at: now() };
    changed(task);
    return batch.map((item) => ({
      role: "user",
      content: `# 父代理补充消息\n${item.message}`,
    }));
  }

  function addNotification(task) {
    if (!task.background) return;
    if (notifications.some((item) => item.taskId === task.id && item.runId === task.runId)) return;
    notifications.push({
      id: "n" + nextNotificationId++,
      taskId: task.id,
      taskName: task.name,
      runId: task.runId,
      status: task.status,
      result: task.result,
      error: task.error,
      createdAt: now(),
      delivered: false,
      deliveredTurnId: null,
    });
  }

  function finish(task, runId, status, detail = {}) {
    if (task.runId !== runId || task.status !== "running") return false;
    task.status = status;
    task.result = detail.result == null ? task.result : String(detail.result);
    task.error = detail.error == null ? null : String(detail.error);
    task.finishedAt = now();
    task.activity = {
      type: status,
      label: status === "completed" ? "已完成" : status === "killed" ? "已停止" : "执行失败",
      at: task.finishedAt,
    };
    addNotification(task);
    changed(task);
    return true;
  }

  function eventFor(task, runId, event) {
    if (task.runId !== runId || task.status !== "running") return;
    if (event.type === "tool_start") {
      task.activity = { type: "tool", label: `正在调用 ${event.name}`, tool: event.name, at: now() };
    } else if (event.type === "tool_result") {
      task.activity = { type: "tool", label: `${event.name} 已完成`, tool: event.name, at: now() };
    } else if (event.type === "assistant_start") {
      task.activity = { type: "model", label: "正在分析", at: now() };
    } else if (event.type === "tool_repair") {
      task.activity = { type: "repair", label: "正在修正工具调用", at: now() };
    } else {
      return;
    }
    changed(task);
  }

  function childContext(task) {
    const source = task.runtime.ctx || {};
    const {
      emit: _emit, confirm: _confirm, ask: _ask, session: _session,
      subagents: _subagents, signal: _signal, client: _client,
      agentTools: _agentTools, parentMessages: _parentMessages,
      runAgentTurn: _runAgentTurn, subagentRunner: _subagentRunner,
      toolCallId: _toolCallId, ...shared
    } = source;
    return { ...shared, session: task.session, parentAgentId: task.id };
  }

  function start(task, { background }) {
    const run = task.runtime.runner || config.runner;
    if (typeof run !== "function") throw new Error("SubAgent runner 未配置。");
    if (!task.runtime.client) throw new Error("SubAgent LLM client 未配置。");

    task.runId++;
    const runId = task.runId;
    task.background = !!background;
    task.status = "running";
    task.error = null;
    task.result = null;
    task.startedAt = now();
    task.finishedAt = null;
    task.controller = new AbortController();
    task.activity = { type: "model", label: "正在启动", at: task.startedAt };

    let unlinkParent = null;
    if (!background && task.runtime.signal) {
      const stopWithParent = () => { if (task.runId === runId) stopTask(task); };
      if (task.runtime.signal.aborted) stopWithParent();
      else {
        task.runtime.signal.addEventListener("abort", stopWithParent, { once: true });
        unlinkParent = () => task.runtime.signal.removeEventListener("abort", stopWithParent);
      }
    }
    changed(task);

    const promise = Promise.resolve().then(async () => {
      if (task.status !== "running") return publicTask(task, { now: now() });
      try {
        // A resumed terminal task already has inbox messages. Inject those before
        // the first model request; later messages are drained at every response.
        task.messages.push(...drainInbox(task));
        let result = null;
        let remainingSteps = 8;
        do {
          result = await run({
            messages: task.messages,
            tools: SUBAGENT_TOOLS,
            client: task.runtime.client,
            ctx: childContext(task),
            signal: task.controller.signal,
            maxSteps: remainingSteps,
            beforeStep: () => drainInbox(task),
            beforeAssistantDone: () => drainInbox(task),
            onEvent: (event) => eventFor(task, runId, event),
          });
          remainingSteps -= Math.max(1, Number(result.steps) || 1);
          // Catch the narrow race after the loop's final inbox drain but before
          // it resolves. A message sent after this atomic check observes terminal
          // state and intentionally starts a new run generation instead.
          if (result.stopped === "done" && task.inbox.length) {
            task.messages.push(...drainInbox(task));
            if (remainingSteps > 0) continue;
            result = { ...result, final: null, stopped: "max_steps" };
          }
          break;
        } while (remainingSteps > 0);
        if (task.runId !== runId || task.status !== "running") return publicTask(task, { now: now() });
        if (result.stopped === "done") finish(task, runId, "completed", { result: result.final || "" });
        else if (result.stopped === "aborted") finish(task, runId, "killed");
        else finish(task, runId, "failed", { error: "SubAgent 已达到最多 8 个步骤。" });
      } catch (error) {
        if (task.runId === runId && task.status === "running") {
          if (task.controller.signal.aborted) finish(task, runId, "killed");
          else finish(task, runId, "failed", { error: error?.message || String(error) });
        }
      } finally {
        unlinkParent?.();
        if (task.runId === runId) task.controller = null;
      }
      return publicTask(task, { now: now() });
    });
    task.promise = promise;
    return promise;
  }

  function stopTask(task) {
    if (task.status !== "running") return publicTask(task, { now: now() });
    const controller = task.controller;
    finish(task, task.runId, "killed");
    controller?.abort();
    return publicTask(task, { now: now() });
  }

  const api = {
    configure(next = {}) {
      config = { ...config, ...next };
      return api;
    },

    async spawn(args = {}, runtime = {}) {
      const description = String(args.description || "").trim();
      const prompt = String(args.prompt || "").trim();
      if (!description || !prompt) throw new Error("spawn_agent 需要 description 和 prompt。");
      const agentType = SUBAGENT_ROLES[args.agent_type] ? args.agent_type : "general-purpose";
      const contextMode = args.context_mode === "fork" ? "fork" : "isolated";
      const name = assertName(args.name);
      let id;
      do { id = "a" + nextId++; } while (resolve(id));
      const task = {
        id, name, description, prompt, agentType, contextMode,
        parentTurnId: runtime.parentTurnId || null,
        relatedTurnIds: new Set(runtime.parentTurnId ? [runtime.parentTurnId] : []),
        runId: 0,
        status: "running",
        background: !!args.run_in_background,
        messages: [],
        session: { approvals: new Set() },
        inbox: [],
        activity: null,
        result: null,
        error: null,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        controller: null,
        promise: null,
        runtime: {
          ...runtime,
          client: runtime.client || config.client,
          parentMessages: runtime.parentMessages || [],
          system: runtime.system || config.systemPrompt || "",
          ctx: { ...(typeof config.baseContext === "function" ? config.baseContext() : config.baseContext || {}), ...(runtime.ctx || {}) },
        },
      };
      task.messages = buildMessages({ description, prompt, agentType, contextMode }, task.runtime);
      tasks.set(id, task);
      let promise;
      try { promise = start(task, { background: task.background }); }
      catch (error) { tasks.delete(id); throw error; }
      if (!task.background) await promise;
      return publicTask(task, { now: now() });
    },

    send(to, message, runtime = {}) {
      const task = assertTask(to);
      const content = String(message || "").trim();
      if (!content) throw new Error("补充消息不能为空。");
      task.inbox.push({ message: content, at: now() });
      if (runtime.parentTurnId) task.relatedTurnIds.add(runtime.parentTurnId);
      if (task.status !== "running") {
        const baseContext = typeof config.baseContext === "function" ? config.baseContext() : config.baseContext || {};
        task.runtime = mergeRuntime(task.runtime, {
          ...runtime,
          runner: runtime.runner || config.runner || task.runtime.runner,
          client: runtime.client || config.client || task.runtime.client,
          system: runtime.system || config.systemPrompt || task.runtime.system,
          ctx: { ...baseContext, ...(runtime.ctx || {}) },
        });
        start(task, { background: true });
      } else {
        changed(task);
      }
      return publicTask(task, { now: now() });
    },

    list(filter = {}) {
      const status = typeof filter === "string" ? filter : filter?.status;
      return [...tasks.values()]
        .filter((task) => !status || task.status === status)
        .map((task) => publicTask(task, { now: now() }));
    },

    get(to, options = {}) {
      return publicTask(assertTask(to), { includeTranscript: !!options.includeTranscript, now: now() });
    },

    transcript(to) {
      return cloneMessages(assertTask(to).messages);
    },

    stop(to) {
      const target = typeof to === "object" ? to?.to : to;
      return stopTask(assertTask(target));
    },

    stopForeground(parentTurnId = null) {
      const stopped = [];
      for (const task of tasks.values()) {
        if (task.status !== "running" || task.background) continue;
        if (parentTurnId && task.parentTurnId !== parentTurnId) continue;
        stopped.push(stopTask(task));
      }
      return stopped;
    },

    removeForParentTurn(parentTurnId) {
      const removed = [];
      for (const task of [...tasks.values()]) {
        if (task.parentTurnId !== parentTurnId && !task.relatedTurnIds.has(parentTurnId)) continue;
        stopTask(task);
        tasks.delete(task.id);
        removed.push(task.id);
      }
      for (let index = notifications.length - 1; index >= 0; index--) {
        if (removed.includes(notifications[index].taskId)) notifications.splice(index, 1);
      }
      if (removed.length) changed();
      return removed;
    },

    pendingNotifications() {
      return notifications.filter((item) => !item.delivered).map(publicNotification);
    },

    takeNotifications(turnId = null) {
      const pending = notifications.filter((item) => !item.delivered);
      const batch = buildNotificationBatch(pending, RESULT_LIMIT);
      for (const item of batch.items) {
        item.delivered = true;
        item.deliveredTurnId = turnId;
      }
      return {
        notifications: batch.items.map(publicNotification),
        content: batch.content,
      };
    },

    restoreNotificationsForTurn(turnId) {
      let restored = 0;
      for (const item of notifications) {
        if (item.deliveredTurnId !== turnId || !tasks.has(item.taskId)) continue;
        item.delivered = false;
        item.deliveredTurnId = null;
        restored++;
      }
      return restored;
    },

    drainNotifications(turnId = null) {
      const taken = api.takeNotifications(turnId);
      return taken.content ? [taken.content] : [];
    },

    rewind({ removedTurnIds = [] } = {}) {
      for (const turnId of removedTurnIds) {
        api.restoreNotificationsForTurn(turnId);
        api.removeForParentTurn(turnId);
      }
    },

    clear() {
      for (const task of tasks.values()) stopTask(task);
      tasks.clear();
      notifications.length = 0;
      changed();
    },

    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    has(to) { return !!resolve(to); },
    size() { return tasks.size; },
  };
  return api;
}

export function getOrCreateSubagentManager(ctx) {
  if (ctx?.subagents) return ctx.subagents;
  if (!ctx?.session) return null;
  if (!ctx.session.subagents && ctx.subagentRunner) {
    ctx.session.subagents = createSubagentManager({ runner: ctx.subagentRunner });
  }
  return ctx.session.subagents || null;
}

export function subagentRuntimeFromContext(ctx = {}) {
  const parentMessages = typeof ctx.parentMessages === "function" ? ctx.parentMessages() : ctx.parentMessages;
  return {
    runner: ctx.subagentRunner,
    client: ctx.client,
    ctx,
    parentMessages: ctx.agentStepMessages || parentMessages || [],
    parentTurnId: ctx.parentTurnId || ctx.turnId || null,
    signal: ctx.signal,
  };
}

export function formatSubagentNotifications(items, limit = RESULT_LIMIT) {
  return buildNotificationBatch(items, limit).content;
}

function publicTask(task, options = {}) {
  const current = options.now ?? Date.now();
  const finishedAt = task.finishedAt || current;
  const out = {
    id: task.id,
    name: task.name,
    description: task.description,
    agent_type: task.agentType,
    context_mode: task.contextMode,
    parent_turn_id: task.parentTurnId,
    run_id: task.runId,
    status: task.status,
    background: task.background,
    activity: task.activity ? { ...task.activity } : null,
    result: task.result == null ? null : clip(task.result, RESULT_LIMIT),
    error: task.error == null ? null : clip(task.error, RESULT_LIMIT),
    created_at: task.createdAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    elapsed_ms: task.startedAt ? Math.max(0, finishedAt - task.startedAt) : 0,
  };
  if (options.includeTranscript) out.transcript = clippedTranscript(task.messages);
  return out;
}

function clippedTranscript(messages) {
  const tail = cloneMessages(messages.slice(-TRANSCRIPT_MESSAGES));
  const out = [];
  let remaining = TRANSCRIPT_LIMIT - 2; // JSON array brackets
  for (let index = tail.length - 1; index >= 0; index--) {
    const message = tail[index];
    const separator = out.length ? 1 : 0;
    const serialized = JSON.stringify(message);
    if (serialized.length + separator <= remaining) {
      out.unshift(message);
      remaining -= serialized.length + separator;
      continue;
    }
    const compact = compactTranscriptMessage(message, remaining - separator);
    if (compact) out.unshift(compact);
    break;
  }
  return out;
}

function compactTranscriptMessage(message, budget) {
  if (budget <= 0) return null;
  const base = {
    role: clip(message.role || "unknown", 64),
    ...(message.name ? { name: clip(message.name, 128) } : {}),
    ...(message.tool_call_id ? { tool_call_id: clip(message.tool_call_id, 128) } : {}),
    truncated: true,
  };
  const calls = (message.tool_calls || []).slice(0, 20).map((call) => {
    const name = clip(call?.function?.name || "unknown", 128);
    const args = clip(call?.function?.arguments || "", 2_000);
    return `${name}(${args})`;
  });
  const text = [contentText(message.content), calls.length ? `工具调用：\n${calls.join("\n")}` : ""]
    .filter(Boolean).join("\n\n");
  const emptySize = JSON.stringify({ ...base, content: "" }).length;
  if (emptySize > budget) return null;

  let low = 0;
  let high = text.length;
  let fitted = { ...base, content: "" };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...base, content: clip(text, middle) };
    if (JSON.stringify(candidate).length <= budget) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}

function publicNotification(item) {
  return {
    notification_id: item.id,
    id: item.taskId,
    name: item.taskName,
    run_id: item.runId,
    status: item.status,
    result: item.result == null ? null : clip(item.result, RESULT_LIMIT),
    error: item.error == null ? null : clip(item.error, RESULT_LIMIT),
    created_at: item.createdAt,
    delivered: item.delivered,
    delivered_turn_id: item.deliveredTurnId,
  };
}

function buildNotificationBatch(items, limit) {
  if (!items?.length) return { items: [], content: "" };
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : RESULT_LIMIT;
  const selected = [];
  const parts = [];
  let used = NOTIFICATION_HEAD.length + NOTIFICATION_TAIL.length;

  for (const item of items) {
    const id = item.taskId ?? item.id;
    const name = item.taskName ?? item.name;
    const label = name ? `${name}（${id}）` : id;
    const detail = item.status === "completed" ? item.result : item.error || "任务已停止。";
    const header = `## ${label} · ${item.status}\n`;
    const separator = parts.length ? 2 : 0;
    const available = max - used - separator;
    if (available <= header.length) break;
    const part = header + clip(detail || "（无文本结果）", Math.min(NOTIFICATION_DETAIL_LIMIT, available - header.length));
    parts.push(part);
    selected.push(item);
    used += separator + part.length;
  }

  if (!selected.length) return { items: [], content: "" };
  return {
    items: selected,
    content: NOTIFICATION_HEAD + parts.join("\n\n") + NOTIFICATION_TAIL,
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
}

function validParentMessages(messages) {
  const cloned = cloneMessages(messages);
  for (let index = 0; index < cloned.length; index++) {
    const calls = cloned[index]?.tool_calls;
    if (!Array.isArray(calls) || !calls.length) continue;
    const results = new Set();
    for (let cursor = index + 1; cursor < cloned.length; cursor++) {
      const message = cloned[cursor];
      if (message.role === "tool") results.add(message.tool_call_id);
      else if (message.role === "assistant" || message.role === "user") break;
    }
    if (calls.some((call) => !results.has(call.id))) return cloned.slice(0, index);
  }
  return cloned;
}

function mergeRuntime(previous = {}, next = {}) {
  const mergedCtx = next.ctx
    ? { ...(previous.ctx || {}), ...next.ctx }
    : previous.ctx;
  return {
    ...previous,
    ...next,
    ctx: mergedCtx,
    runner: next.runner || previous.runner,
    client: next.client || previous.client,
  };
}

function cloneMessages(messages) {
  return (messages || []).map((message) => ({
    ...message,
    ...(Array.isArray(message.content)
      ? { content: message.content.map((part) => part && typeof part === "object" ? { ...part } : part) }
      : {}),
    ...(Array.isArray(message.tool_calls)
      ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) }
      : {}),
  }));
}

function clip(value, limit) {
  const text = String(value || "");
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : RESULT_LIMIT;
  if (text.length <= max) return text;
  const marker = "\n…（结果已截断）";
  if (max <= marker.length) return text.slice(0, max);
  return text.slice(0, max - marker.length) + marker;
}
