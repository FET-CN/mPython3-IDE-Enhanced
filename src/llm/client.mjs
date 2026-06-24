// src/llm/client.mjs — Minimal OpenAI-compatible chat client (browser fetch).
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
  const base = (cfg.baseURL || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const res = await f(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature ?? 0.2,
      stream: false,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("LLM 响应缺少 choices[0].message.content");
  }
  return text;
}

/** A client bound to a config: returns (messages, opts) => Promise<text>. */
export function makeClient(cfg) {
  return (messages, opts) => chat(cfg, messages, opts || {});
}
