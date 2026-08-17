import { describe, it, expect } from "vitest";
import { chatStream, makeClient } from "../../src/llm/client.mjs";
import { toToolSpecs } from "../../src/agent/tools/index.mjs";

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

  it("only serializes strict for tools that explicitly opt in", () => {
    const specs = toToolSpecs([
      { name: "strict_one", description: "", parameters: { type: "object" }, strict: true },
      { name: "normal_one", description: "", parameters: { type: "object" } },
    ]);
    expect(specs[0].function.strict).toBe(true);
    expect(specs[1].function).not.toHaveProperty("strict");
  });

  it("downgrades a strict-schema compatibility 400 once before streaming starts", async () => {
    const bodies = [];
    const f = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools?.[0]?.function?.strict) {
        return {
          ok: false,
          status: 400,
          body: null,
          text: async () => "strict mode is not supported by this endpoint",
        };
      }
      return sseFetch([data({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })])();
    };
    const tools = toToolSpecs([{
      name: "x", description: "", strict: true,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }]);
    const result = await chatStream(cfg(f), [{ role: "user", content: "x" }], { tools });
    expect(result.content).toBe("ok");
    expect(result.strict_downgraded).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools[0].function.strict).toBe(true);
    expect(bodies[1].tools[0].function).not.toHaveProperty("strict");
  });

  it("downgrades an unsupported recursive schema without leaking client metadata", async () => {
    const bodies = [];
    const f = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools?.[0]?.function?.parameters?.$defs) {
        return {
          ok: false,
          status: 400,
          body: null,
          text: async () => "invalid JSON schema: $defs is unsupported",
        };
      }
      return sseFetch([data({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })])();
    };
    const tools = toToolSpecs([{
      name: "x", description: "",
      parameters: { type: "object", properties: {}, $defs: { node: { type: "object" } } },
      fallbackParameters: { type: "object", properties: {} },
    }]);
    const result = await chatStream(cfg(f), [{ role: "user", content: "x" }], { tools });
    expect(result.tool_schema_downgraded).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools[0]).not.toHaveProperty("_fallbackParameters");
    expect(bodies[1].tools[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("caches a schema downgrade on a bound client", async () => {
    const bodies = [];
    const f = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools?.[0]?.function?.parameters?.$defs) {
        return { ok: false, status: 400, body: null, text: async () => "$defs is unsupported by this JSON schema endpoint" };
      }
      return sseFetch([data({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })])();
    };
    const tools = toToolSpecs([{
      name: "x", description: "",
      parameters: { type: "object", properties: {}, $defs: { node: { type: "object" } } },
      fallbackParameters: { type: "object", properties: {} },
    }]);
    const client = makeClient(cfg(f));
    await client.stream([{ role: "user", content: "one" }], { tools });
    await client.stream([{ role: "user", content: "two" }], { tools });
    expect(bodies).toHaveLength(3);
    expect(bodies[2].tools[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("does not mask a genuinely invalid schema as provider incompatibility", async () => {
    let calls = 0;
    const f = async () => {
      calls++;
      return { ok: false, status: 400, body: null, text: async () => "invalid JSON schema: required property is missing" };
    };
    const tools = toToolSpecs([{
      name: "x", description: "",
      parameters: { type: "object", properties: {} },
      fallbackParameters: { type: "object", properties: {} },
    }]);
    await expect(chatStream(cfg(f), [{ role: "user", content: "x" }], { tools }))
      .rejects.toThrow(/required property is missing/);
    expect(calls).toBe(1);
  });

  it("does not downgrade unrelated 400 responses", async () => {
    let calls = 0;
    const f = async () => ({
      ok: false,
      status: 400,
      body: null,
      text: async () => { calls++; return "messages are invalid"; },
    });
    const tools = toToolSpecs([{
      name: "x", description: "", strict: true,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }]);
    await expect(chatStream(cfg(f), [{ role: "user", content: "x" }], { tools })).rejects.toThrow(/messages are invalid/);
    expect(calls).toBe(1);
  });
});
