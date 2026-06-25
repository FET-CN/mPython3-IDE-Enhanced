// src/llm/client.mjs — OpenAI-compatible chat client (browser fetch).
// Two modes:
//   • chat()       — non-streaming, returns assistant text (legacy: repair.mjs, eval).
//   • chatStream() — streaming + tool-calling, returns {content, tool_calls,
//                    finish_reason} and pushes text deltas through onDelta().
// Config (baseURL, apiKey, model) comes from localStorage m3e_* at call sites.

/** Transient transport faults worth retrying (truncated stream, reset, 5xx). */
function isTransient(err) {
  const m = String(err?.message || err || "");
  return (
    /Content-Length|network|Failed to fetch|terminated|ECONNRESET|socket|stream|timeout|aborted by the server|LLM HTTP 5\d\d|LLM HTTP 429/i
      .test(m) && !/AbortError/i.test(err?.name || "")
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param cfg { baseURL, apiKey, model, temperature?, fetchImpl? }
 * @param messages [{role, content}]
 * @returns assistant message text
 */
export async function chat(cfg, messages, { signal } = {}) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chatOnce(cfg, messages, { signal });
    } catch (err) {
      lastErr = err;
      if (signal?.aborted || attempt === maxAttempts || !isTransient(err)) throw err;
      await sleep(400 * attempt); // brief backoff before retrying a transient fault
    }
  }
  throw lastErr;
}

async function chatOnce(cfg, messages, { signal } = {}) {
  const f = cfg.fetchImpl || globalThis.fetch;
  const res = await f(endpoint(cfg), {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature ?? 0.2,
      stream: false,
    }),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("LLM 响应缺少 choices[0].message.content");
  }
  return text;
}

/**
 * Streaming chat with optional tool-calling. Parses OpenAI SSE deltas, pushing
 * text fragments through onDelta and accumulating tool_calls by index.
 *
 * @param cfg      { baseURL, apiKey, model, temperature?, fetchImpl? }
 * @param messages [{role, content, tool_calls?, tool_call_id?}]
 * @param o {
 *   tools?: [{type:'function', function:{name, description, parameters}}],
 *   toolChoice?: 'auto'|'none'|object,
 *   signal?, onDelta?: (textChunk)=>void
 * }
 * @returns { role:'assistant', content, tool_calls, finish_reason }
 */
export async function chatStream(cfg, messages, o = {}) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let started = false;
    try {
      return await chatStreamOnce(cfg, messages, o, () => { started = true; });
    } catch (err) {
      lastErr = err;
      // Only retry if nothing was emitted yet (otherwise the UI already has a
      // partial answer and re-streaming would duplicate it).
      if (started || o.signal?.aborted || attempt === maxAttempts || !isTransient(err)) throw err;
      await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

async function chatStreamOnce(cfg, messages, o, markStarted) {
  const f = cfg.fetchImpl || globalThis.fetch;
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.2,
    stream: true,
  };
  if (o.tools && o.tools.length) {
    body.tools = o.tools;
    body.tool_choice = o.toolChoice ?? "auto";
  }
  const res = await f(endpoint(cfg), {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal: o.signal,
  });
  if (!res.ok) throw await httpError(res);
  if (!res.body || typeof res.body.getReader !== "function") {
    // Environment without a streamable body (e.g. some test mocks): fall back to
    // reading the whole text and parsing it as concatenated SSE.
    return parseSSEText(await res.text(), o.onDelta, markStarted);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const acc = newAccumulator();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    // SSE events are separated by blank lines; data lines start with "data: ".
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      consumeSSELine(line, acc, o.onDelta, markStarted);
    }
  }
  if (buf.trim()) consumeSSELine(buf.trim(), acc, o.onDelta, markStarted);
  return finalizeAccumulator(acc);
}

// ---- SSE accumulation ----

function newAccumulator() {
  return { content: "", toolCalls: [], finish: null };
}

/** Apply one streamed `choices[0].delta` chunk to the accumulator. */
function applyDelta(acc, choice, onDelta, markStarted) {
  const delta = choice?.delta || {};
  if (typeof delta.content === "string" && delta.content.length) {
    acc.content += delta.content;
    markStarted?.();
    onDelta?.(delta.content);
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const i = tc.index ?? 0;
      const slot = (acc.toolCalls[i] ||= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.type) slot.type = tc.type;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") slot.function.arguments += tc.function.arguments;
      markStarted?.();
    }
  }
  if (choice?.finish_reason) acc.finish = choice.finish_reason;
}

function consumeSSELine(line, acc, onDelta, markStarted) {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  let json;
  try { json = JSON.parse(payload); } catch { return; }
  const choice = json.choices?.[0];
  if (choice) applyDelta(acc, choice, onDelta, markStarted);
}

/** Parse a whole SSE response body at once (non-streaming fallback path). */
function parseSSEText(text, onDelta, markStarted) {
  const acc = newAccumulator();
  for (const raw of text.split("\n")) consumeSSELine(raw.trim(), acc, onDelta, markStarted);
  // If the server returned a plain JSON completion instead of SSE, handle it.
  if (!acc.content && !acc.toolCalls.length) {
    try {
      const data = JSON.parse(text);
      const msg = data?.choices?.[0]?.message;
      if (msg) {
        if (typeof msg.content === "string") { acc.content = msg.content; onDelta?.(msg.content); markStarted?.(); }
        if (Array.isArray(msg.tool_calls)) acc.toolCalls = msg.tool_calls;
        acc.finish = data.choices[0].finish_reason || null;
      }
    } catch { /* not JSON either */ }
  }
  return finalizeAccumulator(acc);
}

function finalizeAccumulator(acc) {
  const tool_calls = acc.toolCalls.filter(Boolean).filter((t) => t.function?.name);
  return {
    role: "assistant",
    content: acc.content,
    tool_calls: tool_calls.length ? tool_calls : undefined,
    finish_reason: acc.finish,
  };
}

// ---- shared HTTP helpers ----

function endpoint(cfg) {
  const base = (cfg.baseURL || "").replace(/\/+$/, "");
  return `${base}/chat/completions`;
}
function headers(cfg) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };
}
async function httpError(res) {
  const body = await res.text().catch(() => "");
  return new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
}

/**
 * A client bound to a config. Callable as `client(messages, opts) => Promise<text>`
 * for legacy non-streaming callers, with `.stream` / `.complete` attached for the
 * agent loop.
 */
export function makeClient(cfg) {
  const fn = (messages, opts) => chat(cfg, messages, opts || {});
  fn.complete = (messages, opts) => chat(cfg, messages, opts || {});
  fn.stream = (messages, opts) => chatStream(cfg, messages, opts || {});
  fn.cfg = cfg;
  return fn;
}
