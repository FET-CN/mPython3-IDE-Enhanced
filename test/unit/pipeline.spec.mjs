import { describe, it, expect } from "vitest";
import { DOMParser } from "linkedom";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractIR, normalizeProgram } from "../../src/llm/extract.mjs";
import { generateProgram } from "../../src/pipeline.mjs";
import { decompile, canonicalize } from "../../src/xml/decompile.mjs";
import { validate } from "../../src/xml/validate.mjs";
import { resolveVersion } from "../../src/kb/knowledge.mjs";
import { catalogBuilt, loadCatalogMap } from "../helpers/catalog.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("extractIR", () => {
  it("parses a fenced json block", () => {
    const t = 'sure!\n```json\n[[{"type":"text","fields":{"TEXT":"hi"}}]]\n```\ndone';
    expect(extractIR(t)).toEqual([[{ type: "text", fields: { TEXT: "hi" } }]]);
  });
  it("normalizes a single stack and a bare node", () => {
    expect(normalizeProgram([{ type: "a" }])).toEqual([[{ type: "a" }]]);
    expect(normalizeProgram({ type: "a" })).toEqual([[{ type: "a" }]]);
    expect(normalizeProgram({ program: [[{ type: "a" }]] })).toEqual([[{ type: "a" }]]);
  });
  it("tolerates // comments", () => {
    const t = '```json\n[[{"type":"text"}]] // a note\n```';
    expect(extractIR(t)).toEqual([[{ type: "text" }]]);
  });
  it("throws on non-JSON", () => {
    expect(() => extractIR("no json here")).toThrow();
  });
});

describe("resolveVersion", () => {
  const triggers = { version: { v2: ["oled", "单色"], v3: ["lcd", "lvgl", "esp32-s3"] } };
  it("detects v3 from request", () => {
    expect(resolveVersion({ request: "用 LVGL 显示", triggers })).toBe("v3");
  });
  it("detects v2 from master", () => {
    expect(resolveVersion({ request: "显示文本", master: "mPython oled", triggers })).toBe("v2");
  });
  it("unknown when ambiguous", () => {
    expect(resolveVersion({ request: "点亮RGB", triggers })).toBe("unknown");
  });
});

const d = catalogBuilt ? describe : describe.skip;

d("generateProgram brain (mock LLM, requires built catalog)", () => {
  const catalog = loadCatalogMap();
  const index = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.index.json"), "utf8"));
  const seeds = JSON.parse(readFileSync(resolve(ROOT, "tools/data/fewshot-seeds.json"), "utf8")).seeds;
  const knowledge = {
    core: JSON.parse(readFileSync(resolve(ROOT, "dist/knowledge/core.json"), "utf8")),
    antipatterns: JSON.parse(readFileSync(resolve(ROOT, "dist/knowledge/antipatterns.json"), "utf8")),
    triggers: JSON.parse(readFileSync(resolve(ROOT, "dist/knowledge/triggers.json"), "utf8")),
    loadDoc: (name) => {
      try { return readFileSync(resolve(ROOT, "dist/knowledge", name), "utf8"); }
      catch { return ""; }
    },
  };

  const STACK = [
    { type: "mpython_Interrupt_AB", fields: { button: "button_a", action: "down" },
      statements: { DO: [
        { type: "mpython_display_DispChar", inputs: {
          x: { type: "math_number", fields: { NUM: "0" } },
          y: { type: "math_number", fields: { NUM: "0" } },
          message: { type: "text", fields: { TEXT: "Hello" } } } } ] } },
  ];
  const BAD_STACK = [
    { type: "mpython_Interrupt_AB", fields: { button: "X", action: "down" }, statements: { DO: [] } },
  ];
  const GOOD_PROGRAM = [STACK];
  const GOOD_OPS = { ops: [{ op: "insert", anchor: { at: "new" }, blocks: STACK }] };
  const BAD_OPS = { ops: [{ op: "insert", anchor: { at: "new" }, blocks: BAD_STACK }] };

  it("recovers from an invalid first response via the repair loop", async () => {
    let call = 0;
    const seen = [];
    const client = async (messages) => {
      seen.push(messages);
      call++;
      return "```json\n" + JSON.stringify(call === 1 ? BAD_OPS : GOOD_OPS) + "\n```";
    };
    const res = await generateProgram({
      request: "按 A 键时在 OLED 显示 Hello",
      index, catalog, seeds, knowledge,
      client, maxRepairs: 2,
    });
    expect(call).toBe(2); // first bad, second good
    expect(res.ok).toBe(true);
    expect(res.report.errors).toEqual([]);
    // second call must include repair feedback referencing the bad enum
    const repairTurn = seen[1].map((m) => m.content).join("\n");
    expect(repairTurn).toContain("bad_enum_value");
    // applied program compiles + round-trips back to the IR
    expect(decompile(res.xml, { DOMParser })).toEqual(canonicalize(GOOD_PROGRAM));
    expect(validate(res.ir, catalog).ok).toBe(true);
  });

  it("includes module board docs when triggered (超声波)", async () => {
    let captured;
    const client = async (messages) => {
      captured = messages.map((m) => m.content).join("\n");
      return "```json\n{\"ops\":[]}\n```";
    };
    await generateProgram({
      request: "用超声波模块测距",
      index, catalog, seeds, knowledge, client, maxRepairs: 0,
    });
    expect(captured).toContain("板子知识");
    expect(captured.toLowerCase()).toContain("hcsr04");
  });

  it("fails gracefully after maxRepairs with a report", async () => {
    const client = async () => "```json\n" + JSON.stringify(BAD_OPS) + "\n```";
    const res = await generateProgram({
      request: "x", index, catalog, seeds, knowledge, client, maxRepairs: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.xml).toBeNull();
    expect(res.report.errors.length).toBeGreaterThan(0);
    expect(res.attempts).toBe(2);
  });
});
