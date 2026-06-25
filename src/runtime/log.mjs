// src/runtime/log.mjs — Lightweight runtime logging to the browser console.
// Diagnostics for the agent loop live here so they stay queryable in DevTools
// without cluttering the chat panel. By design this only uses the informational
// console channels — console.log / console.info / console.debug — never
// console.error / console.warn (the panel surfaces user-facing failures).

const TAG = "[m3e]";
const has = typeof console !== "undefined";

/** Truncate long strings for tidy console rows. */
export const clip = (v, n = 600) => {
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s.length > n ? s.slice(0, n) + `… (+${s.length - n})` : s;
};

/** Flatten an OpenAI-style messages array into a readable role/content transcript
 *  (incl. tool_calls), so the exact context sent to the model is inspectable. */
export const contextText = (messages) =>
  (messages || [])
    .map((m) => {
      let body = typeof m.content === "string" ? m.content : (m.content != null ? JSON.stringify(m.content) : "");
      if (m.tool_calls?.length) {
        body += (body ? "\n" : "") + m.tool_calls
          .map((c) => `→ ${c.function?.name}(${c.function?.arguments || ""})`)
          .join("\n");
      }
      const tag = m.role === "tool" ? `tool:${m.name || ""}` : m.role;
      return `── [${tag}] ──\n${body}`;
    })
    .join("\n\n");

export const log = {
  info: (...a) => { if (has) console.info(TAG, ...a); },
  log: (...a) => { if (has) console.log(TAG, ...a); },
  debug: (...a) => { if (has) console.debug(TAG, ...a); },
  /** Collapsed group; falls back to console.debug where groups are unsupported. */
  group(label, body) {
    if (!has) return body?.();
    const open = console.groupCollapsed || console.debug;
    open.call(console, `${TAG} ${label}`);
    try { return body?.(); } finally { console.groupEnd?.(); }
  },
};
