import { describe, it, expect } from "vitest";
import { chatStream } from "../../src/llm/client.mjs";

/** Build a fake fetch that returns the given SSE chunks as a streaming body. */
function sseFetch(chunks, { ok = true, status = 200 } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  const body = {
    getReader() {
      return {
        read() {
          if (i < chunks.length) return Promise.resolve({ value: enc.encode(chunks[i++]), done: false });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return async () => ({ ok, status, body, text: async () => chunks.join(""), json: async () => ({}) });
}

const cfg = (fetchImpl) => ({ baseURL: "https://x/v1", apiKey: "k", model: "m", fetchImpl });

const data = (o) => `data: ${JSON.stringify(o)}\n\n`;

describe("chatStream", () => {
  it("accumulates text deltas and reports them through onDelta", async () => {
    const chunks = [
      data({ choices: [{ delta: { content: "你好" } }] }),
      data({ choices: [{ delta: { content: "，世界" } }] }),
      data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ];
    const seen = [];
    const res = await chatStream(cfg(sseFetch(chunks)), [{ role: "user", content: "hi" }], {
      onDelta: (t) => seen.push(t),
    });
    expect(res.content).toBe("你好，世界");
    expect(res.tool_calls).toBeUndefined();
    expect(res.finish_reason).toBe("stop");
    expect(seen).toEqual(["你好", "，世界"]);
  });

  it("assembles streamed tool_calls fragments by index", async () => {
    const chunks = [
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "edit_blocks", arguments: "" } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ops":' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "[]}" } }] } }] }),
      data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ];
    const res = await chatStream(cfg(sseFetch(chunks)), [{ role: "user", content: "go" }], {});
    expect(res.finish_reason).toBe("tool_calls");
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls[0]).toMatchObject({ id: "c1", function: { name: "edit_blocks", arguments: '{"ops":[]}' } });
  });

  it("handles split SSE lines across read() chunk boundaries", async () => {
    // A single data: event delivered in two byte chunks splitting mid-JSON.
    const evt = data({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
    const mid = Math.floor(evt.length / 2);
    const res = await chatStream(cfg(sseFetch([evt.slice(0, mid), evt.slice(mid)])), [{ role: "user", content: "x" }], {});
    expect(res.content).toBe("ok");
  });

  it("throws on non-ok HTTP", async () => {
    const f = async () => ({ ok: false, status: 500, text: async () => "boom", body: null });
    await expect(chatStream(cfg(f), [{ role: "user", content: "x" }], {})).rejects.toThrow(/LLM HTTP 500/);
  });
});
