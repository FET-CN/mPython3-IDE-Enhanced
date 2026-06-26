import { describe, it, expect } from "vitest";
import { DOMParser } from "linkedom";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { retrieve, coreTypes, groupCatalog } from "../../src/kb/retriever.mjs";
import { renderCard } from "../../src/ctx/cards.mjs";
import { assembleMessages, renderRepairFeedback } from "../../src/ctx/assemble.mjs";
import { validate } from "../../src/xml/validate.mjs";
import { compile } from "../../src/xml/compile.mjs";
import { decompile, canonicalize } from "../../src/xml/decompile.mjs";
import { expandOps } from "../../src/ir/expr.mjs";
import { applyOps } from "../../src/host/ops.mjs";
import { catalogBuilt, loadCatalogMap } from "../helpers/catalog.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const d = catalogBuilt ? describe : describe.skip;

d("context engineering (requires built catalog)", () => {
  const catalog = loadCatalogMap();
  const index = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.index.json"), "utf8"));
  const seeds = JSON.parse(
    readFileSync(resolve(ROOT, "tools/data/fewshot-seeds.json"), "utf8"),
  ).seeds;

  describe("expression-shorthand pipeline (regression: deep math without deep JSON)", () => {
    it("expands string inputs → valid value blocks → compiles (circular motion)", () => {
      // The exact class of request that made the model emit unbalanced JSON
      // (each 20*cos(angle) term is 6 levels deep). With the shorthand the model
      // writes a flat string; the host expands it deterministically.
      const ops = [
        {
          op: "insert",
          anchor: { at: "new" },
          blocks: [
            { type: "variables_set", fields: { VAR: "angle" }, inputs: { VALUE: "0" } },
            {
              type: "mpython_display_fill_circle",
              fields: { state: "1" },
              inputs: { x: "64 + 20*cos(angle)", y: "32 + 20*sin(angle)", radius: "4" },
            },
            { type: "variables_set", fields: { VAR: "angle" }, inputs: { VALUE: "(angle + 10) % 360" } },
          ],
        },
      ];
      const { ops: expanded, errors } = expandOps(ops);
      expect(errors).toEqual([]);
      expect(validate(expanded[0].blocks, catalog).errors).toEqual([]);
      const applied = applyOps([], expanded, catalog);
      expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
      const xml = compile(applied.result, { catalog });
      expect(/math_trig/.test(xml)).toBe(true);
      expect(/math_modulo/.test(xml)).toBe(true);
    });

    it("math_constant (pi) is now a usable value block", () => {
      const { ops: expanded } = expandOps([
        { op: "insert", anchor: { at: "new" }, blocks: [
          { type: "variables_set", fields: { VAR: "c" }, inputs: { VALUE: "2 * pi * r" } } ] },
      ]);
      expect(validate(expanded[0].blocks, catalog).errors).toEqual([]);
    });
  });

  describe("few-shot seeds are valid in our own type system", () => {
    for (const seed of seeds) {
      it(`seed: ${seed.intent}`, () => {
        const r = validate(seed.ir, catalog);
        expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
        // and they compile + round-trip
        const xml = compile(seed.ir, { catalog });
        expect(decompile(xml, { DOMParser })).toEqual(canonicalize(seed.ir));
      });
    }
  });

  describe("retriever", () => {
    it("surfaces relevant blocks for a Chinese request", () => {
      const { types } = retrieve("用超声波测距并显示距离", index, { topN: 40 });
      expect(types.length).toBeGreaterThan(0);
      const zhById = new Map(index.map((e) => [e.type, e.zh]));
      const anyDistance = types.some((t) => /测距|超声|距离/.test(zhById.get(t) || ""));
      expect(anyDistance).toBe(true);
    });

    it("ranks display blocks for a display request", () => {
      const { types } = retrieve("在屏幕上显示文本", index, { topN: 30 });
      const zhById = new Map(index.map((e) => [e.type, e.zh]));
      expect(types.some((t) => /显示|屏/.test(zhById.get(t) || ""))).toBe(true);
    });

    it("coreTypes returns the always-on vocabulary", () => {
      expect(coreTypes(index).length).toBeGreaterThan(50);
    });

    it("groupCatalog summarizes groups by count", () => {
      const gc = groupCatalog(index);
      expect(gc[0].count).toBeGreaterThanOrEqual(gc[gc.length - 1].count);
    });
  });

  describe("card rendering", () => {
    it("renders a value block with type + enum", () => {
      const card = renderCard(catalog.get("logic_compare"));
      expect(card).toContain("值积木:Boolean");
      expect(card).toContain("OP=");
      expect(card).toContain("EQ");
    });
    it("renders an event block with statement body", () => {
      const card = renderCard(catalog.get("mpython_Interrupt_AB"));
      expect(card).toContain("事件积木");
      expect(card).toContain("语句体: DO");
    });
    it("标注新一代 next 型事件块的事件体接法（顺接其后），区别于 DO 型", () => {
      // mpython3_radio_recv: next:true / statements:[] → 顺接其后，无 DO 插槽
      const next = renderCard(catalog.get("mpython3_radio_recv"));
      expect(next).toContain("事件积木");
      expect(next).toContain('事件体: 顺接其后(at:"after")');
      expect(next).not.toContain("语句体: DO");
      // 旧版 mpython_radio_recv 仍是 DO 插槽型
      const doType = renderCard(catalog.get("mpython_radio_recv"));
      expect(doType).toContain("语句体: DO");
      expect(doType).not.toContain("顺接其后");
      // mpython3_main 虽是 mpython3 但显式带 DO，归 DO 型（不可误判成顺接型）
      const main = renderCard(catalog.get("mpython3_main"));
      expect(main).toContain("语句体: DO");
      expect(main).not.toContain("顺接其后");
    });
  });

  describe("assembleMessages", () => {
    it("builds a system+user pair with spec, core vocab, and request", () => {
      const msgs = assembleMessages({
        request: "按A键显示Hello",
        catalog,
        coreTypes: ["logic_compare", "math_number", "controls_if"],
        retrievedTypes: ["mpython_Interrupt_AB", "mpython_display_DispChar"],
        seeds,
        core: { import: "from mpython import *", core_api: {}, display_geometry: {}, version_diffs_critical: [] },
        withIds: [],
        anchors: [],
        boardDocs: [],
        version: "v2",
      });
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("system");
      expect(msgs[0].content).toContain("图形化积木语言");
      expect(msgs[0].content).toContain("编辑算子");
      expect(msgs[0].content).toContain("logic_compare");
      expect(msgs[1].content).toContain("按A键显示Hello");
      expect(msgs[1].content).toContain("mpython_Interrupt_AB");
      expect(msgs[1].content).toContain("v2");
    });
  });

  describe("renderRepairFeedback", () => {
    it("lists errors with suggestions", () => {
      const fb = renderRepairFeedback({
        ok: false,
        errors: [{ path: "stack[0][0]", kind: "unknown_type", detail: "未知类型 X", suggestions: ["math_number"] }],
      });
      expect(fb).toContain("unknown_type");
      expect(fb).toContain("math_number");
    });
  });
});
