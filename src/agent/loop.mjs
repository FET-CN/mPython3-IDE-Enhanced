// src/agent/loop.mjs — The tool-calling agent loop (mirrors Claude Code's query.ts).
// Streams an assistant turn; if it returns tool_calls, executes them (read-only
// tools concurrently, writes serially), feeds each result back as a `tool` message,
// and recurses until the model answers with no tool calls. AbortSignal aware.

import { toToolSpecs } from "./tools/index.mjs";
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
  const runCtx = { ...ctx, emit, signal };
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = toToolSpecs(tools);

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return { messages, final: null, steps: step, stopped: "aborted" };

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

    if (!res.tool_calls?.length) {
      log.info(`本轮结束（${step + 1} 步）`);
      return { messages, final: res.content || "", steps: step + 1, stopped: "done" };
    }

    const calls = res.tool_calls;
    const allReadOnly = calls.every((c) => byName.get(c.function?.name)?.isReadOnly);
    const exec = (c) => executeCall(c, byName, runCtx);

    let results;
    if (allReadOnly) {
      results = await mapLimited(calls, MAX_CONCURRENCY, exec);
    } else {
      results = [];
      for (const c of calls) results.push(await exec(c)); // writes stay ordered
    }
    for (const r of results) messages.push(r);
  }
  return { messages, final: null, steps: MAX_STEPS, stopped: "max_steps" };
}

/** Execute one tool_call → an OpenAI `tool` message (always, even on error). */
async function executeCall(call, byName, ctx) {
  const id = call.id;
  const name = call.function?.name;
  const tool = byName.get(name);
  const toolMsg = (content) => ({ role: "tool", tool_call_id: id, name, content: String(content ?? "") });

  if (!tool) { log.debug(`未知工具：${name}`); return toolMsg(`未知工具：${name}`); }

  let args = {};
  try {
    const raw = call.function?.arguments;
    args = raw ? JSON.parse(raw) : {};
  } catch (e) {
    log.debug(`工具 ${name} 参数解析失败`, clip(call.function?.arguments));
    return toolMsg(`工具参数不是合法 JSON：${e.message}`);
  }

  // Confirmation gate for write/side-effecting tools (Phase 7 wires the UI).
  if (tool.needsConfirm && ctx.confirm && !ctx.session?.approvals?.has(tool.name)) {
    let decision;
    try { decision = await ctx.confirm(tool, args); } catch { decision = false; }
    if (decision === "session") ctx.session?.approvals?.add(tool.name);
    if (!decision) {
      log.info(`工具 ${name} 被用户拒绝`);
      ctx.emit?.({ type: "tool_rejected", name });
      return toolMsg("用户拒绝了该操作。请改用其他方式或先征求用户意见。");
    }
  }

  ctx.emit?.({ type: "tool_start", name, args });
  return log.group(`工具 ${name}`, async () => {
    log.debug("参数", args);
    try {
      const out = await tool.run(args, ctx);
      ctx.emit?.({ type: "tool_result", name, is_error: !!out?.is_error, display: out?.display });
      log.debug(out?.is_error ? "结果（错误）" : "结果", clip(out?.content));
      return toolMsg(out?.content);
    } catch (e) {
      ctx.emit?.({ type: "tool_result", name, is_error: true });
      log.debug("执行异常", e?.message || String(e));
      return toolMsg(`工具执行异常：${e?.message || String(e)}`);
    }
  });
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
