// src/agent/history.mjs — In-memory multi-turn conversation state (session-only;
// cleared on reload, by design). Owns the live messages array that the agent loop
// appends to, keeps the system prompt at index 0 as a stable cacheable prefix, and
// implements /compact summarization. Optional Anthropic-style cache breakpoints.

const COMPACT_PROMPT =
  "请把上面的对话压缩成一段简洁但完整的中文摘要，供后续继续对话使用。" +
  "重点保留：用户的目标与偏好、已对工作区做了哪些改动、当前积木程序的状态、" +
  "尚未完成的任务、以及任何需要延续的上下文。只输出摘要本身。";

export function createHistory(system = "") {
  // messages[0] is always the system message; turns follow. Keep the array object
  // stable where possible because runAgentTurn mutates the live reference in place.
  let messages = [{ role: "system", content: system }];
  let turns = [];
  let nextTurnId = 1;

  const closed = () => turns.filter((t) => t.status === "closed");

  const api = {
    /** Live array passed to runAgentTurn (it appends assistant + tool messages). */
    messages: () => messages,

    setSystem(s) { messages[0] = { role: "system", content: s }; },
    getSystem() { return messages[0]?.content || ""; },

    addUser(content) { messages.push({ role: "user", content: String(content) }); return api; },

    beginTurn(content, meta = {}) {
      const turn = { id: "t" + nextTurnId++, messageStart: messages.length, messageEnd: null, status: "open", meta: { ...meta } };
      messages.push({ role: "user", content: String(content) });
      turns.push(turn);
      return turn;
    },

    closeTurn(turn, meta = {}) {
      const t = turns.find((x) => x === turn || x.id === turn?.id || x.id === turn);
      if (!t || t.status !== "open") return null;
      t.messageEnd = messages.length;
      t.status = "closed";
      t.meta = { ...(t.meta || {}), ...meta };
      return { ...t, meta: { ...(t.meta || {}) } };
    },

    discardTurn(turn) {
      const i = turns.findIndex((x) => x === turn || x.id === turn?.id || x.id === turn);
      if (i < 0) return false;
      const [t] = turns.splice(i, 1);
      if (messages.length > t.messageStart) messages.length = t.messageStart;
      return true;
    },

    rewind(count = 1) {
      const n = Number(count);
      const done = closed();
      if (!Number.isSafeInteger(n) || n <= 0 || n > done.length) return { ok: false, count: 0, available: done.length };
      const target = done[done.length - n];
      messages.length = target.messageStart;
      turns = turns.filter((t) => t.messageStart < target.messageStart);
      return { ok: true, count: n, targetTurnId: target.id, messageStart: target.messageStart, available: closed().length };
    },

    rewindableCount() { return closed().length; },
    closedTurns() { return closed().map((t) => ({ ...t, meta: { ...(t.meta || {}) } })); },

    /** Drop everything but the system prompt. */
    clear() { messages.length = 1; turns = []; return api; },

    /** Number of non-system messages (legacy; not rewindable user turns). */
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
      messages.length = 1;
      messages.push({ role: "user", content: `# 对话摘要（之前的对话已压缩，请据此继续）\n${summary}` });
      turns = [];
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
