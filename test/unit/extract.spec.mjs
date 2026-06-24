import { describe, it, expect } from "vitest";
import { extractOps, extractIR, repairJson } from "../../src/llm/extract.mjs";

describe("repairJson — structural tolerance", () => {
  it("drops a stray closer in array context (the real -1 model slip)", () => {
    // ...}}]}}]}}]}  should have been  ...}}]}}]}]}  — one extra } in `ops` array
    const bad = '{"ops":[{"op":"clear"},{"op":"insert","blocks":[{"type":"a"}]}}]}';
    expect(() => JSON.parse(bad)).toThrow();
    const { out, fixes } = repairJson(bad);
    expect(fixes).toBe(1);
    expect(JSON.parse(out)).toEqual({ ops: [{ op: "clear" }, { op: "insert", blocks: [{ type: "a" }] }] });
  });
  it("appends missing closers on truncation", () => {
    const { out } = repairJson('{"ops":[{"op":"insert","blocks":[{"type":"a"}');
    expect(JSON.parse(out)).toEqual({ ops: [{ op: "insert", blocks: [{ type: "a" }] }] });
  });
  it("leaves valid JSON byte-identical (fixes=0)", () => {
    const good = '{"a":[1,[2,3],{"b":[4]}],"c":{"d":"e"}}';
    expect(repairJson(good)).toEqual({ out: good, fixes: 0 });
  });
  it("ignores braces inside strings", () => {
    const s = '{"t":"a}]{["}';
    expect(repairJson(s)).toEqual({ out: s, fixes: 0 });
  });
});

describe("extractOps — tolerant fallback", () => {
  it("strict parse sets repaired=false", () => {
    const r = extractOps('```json\n{"ops":[{"op":"clear"}]}\n```');
    expect(r).toMatchObject({ repaired: false, fixes: 0 });
    expect(r.ops).toEqual([{ op: "clear" }]);
  });
  it("recovers a one-brace slip and flags repaired=true", () => {
    const raw = '```json\n{"ops":[{"op":"clear"},{"op":"insert","blocks":[{"type":"a"}]}}]}\n```';
    const r = extractOps(raw);
    expect(r.repaired).toBe(true);
    expect(r.fixes).toBe(1);
    expect(r.ops).toEqual([{ op: "clear" }, { op: "insert", blocks: [{ type: "a" }] }]);
  });
  it("still throws when the imbalance is too large to trust", () => {
    // 9 surplus object-context closers (the pre-shorthand failure mode) is not
    // a trustworthy auto-repair → surface the error for repair feedback instead.
    const raw = '```json\n{"ops":[{"a":{"b":{"c":1}}}}}}}}}}}]}\n```';
    expect(() => extractOps(raw)).toThrow(/编辑算子 JSON/);
  });
});

describe("extractIR — tolerant fallback", () => {
  it("recovers a one-brace slip into a program", () => {
    const ir = extractIR('```json\n[[{"type":"a","inputs":{"x":"1"}}]]}\n```');
    expect(ir).toEqual([[{ type: "a", inputs: { x: "1" } }]]);
  });
});
