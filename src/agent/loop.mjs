// src/agent/loop.mjs — The tool-calling agent loop (mirrors Claude Code's query.ts).
// Streams an assistant turn; if it returns tool_calls, executes them (read-only
// tools concurrently, writes serially), feeds each result back as a `tool` message,
// and recurses until the model answers with no tool calls. AbortSignal aware.

import { toToolSpecs } from "./tools/index.mjs";
import { MAX_JSON_FIXES, repairJson } from "../llm/extract.mjs";
import { log, clip, contextText } from "../runtime/log.mjs";

const MAX_STEPS = 16;
const MAX_CONCURRENCY = 6;

/**
 * @param o {
 *   messages: chat messages (mutated in place: assistant + tool messages appended),
 *   tools: tool defs (see tools/index.mjs),
 *   client: makeClient() result (needs .stream),
 *   ctx: { caps, data, board, version, session, emit, confirm? },
 *   onEvent?: (ev)=>void,   // UI events; also forwarded to ctx.emit
 *   signal?
 * }
 * @returns { messages, final, steps, stopped }
 */
export async function runAgentTurn(o) {
  const { messages, tools, client, ctx, signal } = o;
  const emit = (ev) => { o.onEvent?.(ev); ctx?.emit?.(ev); };
  const runCtx = {
    ...ctx,
    emit,
    signal,
    client,
    subagentRunner: o.subagentRunner || ctx?.subagentRunner || runAgentTurn,
    parentMessages: () => messages,
  };
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = toToolSpecs(tools);

  const maxSteps = Number.isSafeInteger(o.maxSteps) && o.maxSteps > 0 ? o.maxSteps : MAX_STEPS;
  const maxConcurrency = Number.isSafeInteger(o.maxConcurrency) && o.maxConcurrency > 0 ? o.maxConcurrency : MAX_CONCURRENCY;
  const unlimitedTools = new Set([
    ...(o.unlimitedConcurrencyTools || []),
    ...tools.filter((tool) => tool.unboundedConcurrency).map((tool) => tool.name),
  ]);

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { messages, final: null, steps: step, stopped: "aborted" };

    const beforeStep = o.beforeStep
      ? await o.beforeStep({ step, messages, signal })
      : null;
    messages.push(...injectedMessages(beforeStep));

    emit({ type: "assistant_start", step });
    log.group(`第 ${step + 1} 步 · 装配上下文（${messages.length} 条 / ${specs.length} 个工具）`, () => {
      log.debug("messages（发送给模型的数组）", messages);
      log.debug("文本预览\n" + contextText(messages));
      log.debug("可用工具", specs.map((s) => s.function?.name));
    });
    const res = await client.stream(messages, {
      tools: specs,
      signal,
      onDelta: (text) => emit({ type: "assistant_delta", text }),
    });

    const injected = o.beforeAssistantDone
      ? await o.beforeAssistantDone({ step, response: res, messages, signal })
      : null;
    const afterResponse = injectedMessages(injected);

    const prepared = await prepareToolCalls(res.tool_calls || [], byName);
    const repair = prepared.repair || await preflightToolCalls(res.tool_calls || [], byName, runCtx, prepared.argsByCall);
    if (repair) {
      emit({ type: "assistant_discard" });
      emit({ type: "tool_repair", name: repair.name, detail: repair.content });
      log.group(`第 ${step + 1} 步 · 工具预校验未通过（内部修复）`, () => {
        log.debug("工具", repair.name);
        log.debug("反馈", clip(repair.content));
      });
      messages.push({ role: "user", content: repair.content });
      if (afterResponse.length) messages.push(...afterResponse);
      continue;
    }

    const assistantMsg = { role: "assistant", content: res.content || "" };
    if (res.tool_calls?.length) assistantMsg.tool_calls = res.tool_calls;
    messages.push(assistantMsg);
    emit({ type: "assistant_done", content: res.content || "", tool_calls: res.tool_calls || [] });
    log.group(`第 ${step + 1} 步 · 模型回复`, () => {
      log.debug("文本", clip(res.content || "(空)"));
      if (res.tool_calls?.length) {
        log.debug("工具调用", res.tool_calls.map((c) => ({ name: c.function?.name, arguments: c.function?.arguments })));
      } else {
        log.debug("无工具调用（本轮结束）");
      }
    });

    if (!res.tool_calls?.length && afterResponse.length) {
      messages.push(...afterResponse);
      continue;
    }

    if (!res.tool_calls?.length) {
      log.info(`本轮结束（${step + 1} 步）`);
      return { messages, final: res.content || "", steps: step + 1, stopped: "done" };
    }

    const calls = res.tool_calls;
    const exec = (c) => executeCall(c, byName, runCtx, prepared.argsByCall);
    const results = await mapToolCalls(calls, byName, maxConcurrency, unlimitedTools, exec);
    for (const r of results) messages.push(r);
    if (afterResponse.length) messages.push(...afterResponse);
  }
  return { messages, final: null, steps: maxSteps, stopped: "max_steps" };
}

function injectedMessages(value) {
  return (Array.isArray(value) ? value : value?.messages || [])
    .map((content) => typeof content === "string" ? { role: "user", content } : content)
    .filter((message) => message?.role && message?.content != null);
}

/** Parse and normalize each known call once, before preflight and confirmation.
 * A small bracket imbalance may be repaired, but the parsed value must still pass
 * the tool's own structural validator before it can reach the user or host. */
async function prepareToolCalls(calls, byName) {
  const argsByCall = new Map();
  for (const call of calls || []) {
    const name = call.function?.name;
    const tool = byName.get(name);
    if (!tool) continue;
    const raw = call.function?.arguments || "";
    let args;
    try {
      args = raw ? JSON.parse(raw) : {};
    } catch (error) {
      const repaired = repairJson(raw);
      if (repaired.fixes === 0 || repaired.fixes > MAX_JSON_FIXES) {
        return { argsByCall, repair: invalidJsonRepair(name, error) };
      }
      try {
        args = JSON.parse(repaired.out);
        call.function.arguments = JSON.stringify(args);
        log.info(`工具 ${name} 参数已修复 ${repaired.fixes} 处括号失衡`);
      } catch {
        return { argsByCall, repair: invalidJsonRepair(name, error) };
      }
    }
    if (tool.normalizeArgs) {
      const normalized = await tool.normalizeArgs(args);
      if (!normalized?.ok) {
        return {
          argsByCall,
          repair: { name, content: String(normalized?.content || `上一次 ${name} 工具调用未执行：参数结构无效，请修正后重试。`) },
        };
      }
      args = normalized.args;
    }
    argsByCall.set(call, args);
  }
  return { argsByCall, repair: null };
}

function invalidJsonRepair(name, error) {
  return {
    name,
    content: `上一次 ${name} 工具调用未执行：参数不是合法 JSON（${error.message}）。请修正后重新调用 ${name}，不要把 JSON 写进聊天正文。`,
  };
}

/** Run model-repairable, side-effect-free checks before confirmation/execution.
 *  A failure is intentionally NOT encoded as assistant tool_calls + tool output:
 *  it is an internal repair turn, so we append only a compact user-facing-to-LLM
 *  hint and ask the model again. */
async function preflightToolCalls(calls, byName, ctx, argsByCall) {
  for (const call of calls || []) {
    const name = call.function?.name;
    const tool = byName.get(name);
    if (!tool?.preflight) continue;
    const out = await tool.preflight(argsByCall.get(call) || {}, ctx);
    if (out && out.ok === false) return { name, content: String(out.content || "工具预校验失败，请修正后重试。") };
  }
  return null;
}

/** Execute one tool_call → an OpenAI `tool` message (always, even on error). */
async function executeCall(call, byName, ctx, argsByCall) {
  const id = call.id;
  const name = call.function?.name;
  const tool = byName.get(name);
  const toolMsg = (content) => ({ role: "tool", tool_call_id: id, name, content: String(content ?? "") });

  if (!tool) { log.debug(`未知工具：${name}`); return toolMsg(`未知工具：${name}`); }

  const args = argsByCall.get(call) || {};

  // Confirmation gate for write/side-effecting tools (Phase 7 wires the UI).
  if (tool.needsConfirm && !ctx.session?.approvals?.has(tool.name)) {
    if (!ctx.confirm) {
      log.info(`工具 ${name} 缺少确认通道，已拒绝`);
      ctx.emit?.({ type: "tool_rejected", id, name });
      return toolMsg("当前上下文无法向用户请求确认，已拒绝该操作。");
    }
    let decision;
    try { decision = await ctx.confirm(tool, args); } catch { decision = false; }
    if (decision === "session") ctx.session?.approvals?.add(tool.name);
    if (!decision) {
      log.info(`工具 ${name} 被用户拒绝`);
      ctx.emit?.({ type: "tool_rejected", id, name });
      return toolMsg("用户拒绝了该操作。请改用其他方式或先征求用户意见。");
    }
  }

  ctx.emit?.({ type: "tool_start", id, name, args });
  return log.group(`工具 ${name}`, async () => {
    log.debug("参数", args);
    try {
      const out = await tool.run(args, { ...ctx, toolCallId: id });
      ctx.emit?.({ type: "tool_result", id, name, is_error: !!out?.is_error, display: out?.display });
      log.debug(out?.is_error ? "结果（错误）" : "结果", clip(out?.content));
      return toolMsg(out?.content);
    } catch (e) {
      ctx.emit?.({ type: "tool_result", id, name, is_error: true });
      log.debug("执行异常", e?.message || String(e));
      return toolMsg(`工具执行异常：${e?.message || String(e)}`);
    }
  });
}

/** Start specially marked calls immediately. The remaining calls preserve the
 * existing policy: an all-read-only batch uses a bounded pool; any stateful call
 * makes that remainder serial so message/stop operations retain FIFO ordering. */
async function mapToolCalls(calls, byName, limit, unlimitedTools, fn) {
  const out = new Array(calls.length);
  const ordinary = [];
  const immediate = [];
  calls.forEach((call, index) => {
    if (unlimitedTools.has(call.function?.name)) immediate.push([call, index]);
    else ordinary.push([call, index]);
  });
  const direct = immediate.map(async ([call, index]) => { out[index] = await fn(call, index); });
  const allOrdinaryReadOnly = ordinary.every(([call]) => byName.get(call.function?.name)?.isReadOnly);
  const rest = allOrdinaryReadOnly
    ? mapLimited(ordinary, limit, async ([call, index]) => { out[index] = await fn(call, index); })
    : (async () => {
        for (const [call, index] of ordinary) out[index] = await fn(call, index);
      })();
  await Promise.all([rest, ...direct]);
  return out;
}

/** Run async `fn` over items with bounded concurrency, preserving order. */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
