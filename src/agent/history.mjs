// src/agent/history.mjs — In-memory multi-turn conversation state (session-only;
// cleared on reload, by design). Owns the live messages array that the agent loop
// appends to, keeps the system prompt at index 0 as a stable cacheable prefix, and
// implements /compact summarization. Optional Anthropic-style cache breakpoints.

const COMPACT_PROMPT =
  "请把上面的对话压缩成一段简洁但完整的中文摘要，供后续继续对话使用。" +
  "重点保留：用户的目标与偏好、已对工作区做了哪些改动、当前积木程序的状态、" +
  "尚未完成的任务、以及任何需要延续的上下文。只输出摘要本身。";

export function createHistory(system = "") {
  // messages[0] is always the system message; turns follow.
  let messages = [{ role: "system", content: system }];

  const api = {
    /** Live array passed to runAgentTurn (it appends assistant + tool messages). */
    messages: () => messages,

    setSystem(s) { messages[0] = { role: "system", content: s }; },
    getSystem() { return messages[0]?.content || ""; },

    addUser(content) { messages.push({ role: "user", content: String(content) }); return api; },

    /** Drop everything but the system prompt. */
    clear() { messages = [messages[0]]; return api; },

    /** Number of non-system turns. */
    turnCount() { return messages.length - 1; },

    /**
     * Summarize the conversation so far and restart from the summary, keeping the
     * system prompt. Uses client.complete (non-streaming) with a summarizer prompt.
     * @returns the summary text
     */
    async compact(client) {
      if (messages.length <= 1) return "";
      const req = [...messages, { role: "user", content: COMPACT_PROMPT }];
      const summary = await client.complete(req, {});
      messages = [
        messages[0],
        { role: "user", content: `# 对话摘要（之前的对话已压缩，请据此继续）\n${summary}` },
      ];
      return summary;
    },
  };
  return api;
}

/**
 * Return a shallow copy of `messages` with Anthropic-style ephemeral cache_control
 * on the system block and the last `tail` turns. ONLY apply this when the endpoint
 * is Anthropic-compatible — OpenAI/DeepSeek-style endpoints reject/ignore it, and
 * there we rely on the stable prefix for automatic caching instead.
 */
export function withCacheBreakpoints(messages, tail = 2) {
  const n = messages.length;
  return messages.map((m, i) => {
    const isSystem = i === 0;
    const isTail = i >= n - tail;
    if (!isSystem && !isTail) return m;
    const content = typeof m.content === "string"
      ? [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }]
      : m.content;
    return { ...m, content };
  });
}

/** Heuristic: does this base URL look like an Anthropic-compatible endpoint? */
export function isAnthropicEndpoint(baseURL = "") {
  return /anthropic|claude/i.test(baseURL);
}
