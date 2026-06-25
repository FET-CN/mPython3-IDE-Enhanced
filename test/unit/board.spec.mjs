import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { retrieve, coreTypes, boardAllows, preferredTypes } from "../../src/kb/retriever.mjs";
import { boardFromMaster } from "../../src/kb/knowledge.mjs";
import { buildAgentSystem } from "../../src/ctx/agent-prompt.mjs";
import { catalogBuilt, loadCatalogMap } from "../helpers/catalog.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const d = catalogBuilt ? describe : describe.skip;

describe("boardFromMaster", () => {
  it("maps the two supported boards", () => {
    expect(boardFromMaster("mPython")).toMatchObject({ version: "v2", supported: true });
    expect(boardFromMaster("mPython_V3")).toMatchObject({ version: "v3", supported: true });
  });
  it("marks everything else unsupported", () => {
    for (const m of ["_1956_V2", "MicroBit", "mPythonBox", "AiMutualBox"]) {
      expect(boardFromMaster(m).supported).toBe(false);
    }
  });
  it("empty defaults to 掌控板 (app default)", () => {
    expect(boardFromMaster("")).toMatchObject({ board: "mPython", supported: true });
  });
});

describe("boardAllows", () => {
  it("universal/built-in allowed on any board", () => {
    expect(boardAllows("u", "mPython")).toBe(true);
    expect(boardAllows("23", "mPython_V3")).toBe(true);
  });
  it("board-specific filtered correctly", () => {
    expect(boardAllows("2", "mPython")).toBe(true);
    expect(boardAllows("2", "mPython_V3")).toBe(false);
    expect(boardAllows("3", "mPython")).toBe(false);
    expect(boardAllows("", "mPython")).toBe(false); // other-board-only
  });
  it("no board → no filtering", () => {
    expect(boardAllows("", null)).toBe(true);
  });
});

d("board-filtered retrieval (requires built catalog)", () => {
  const index = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.index.json"), "utf8"));
  it("excludes other-board blocks when board=mPython", () => {
    const all = new Set(retrieve("引脚 读取 数字", index, { topN: 200 }).types);
    const v2 = new Set(retrieve("引脚 读取 数字", index, { topN: 200, board: "mPython" }).types);
    // _1956_* pin blocks should be present unfiltered but gone when board-filtered
    const has1956 = (s) => [...s].some((t) => t.startsWith("_1956"));
    expect(has1956(v2)).toBe(false);
  });
  it("keeps core 掌控板 blocks under board filter", () => {
    const core = coreTypes(index, "mPython");
    expect(core).toContain("mpython_display_DispChar");
    expect(core).not.toContain("_1956_v2_all_pin");
  });

  it("surfaces the v2 drawing stack + trig within the core-card cap (regression)", () => {
    // Past bug: mpython_display_* + math_trig fell past the ~60-card core cap
    // (crowded by AIcamera/AMIGO foreign-family blocks wrongly flagged core),
    // so the model never saw display_fill's real field and hallucinated SIN/COS.
    const first60 = new Set(coreTypes(index, "mPython").slice(0, 60));
    for (const t of [
      "mpython_display_fill", "mpython_display_Show", "mpython_display_circle",
      "mpython_display_line", "math_trig",
    ]) {
      expect(first60.has(t), `${t} missing from first 60 core cards`).toBe(true);
    }
  });

  it("does not flag foreign-family peripheral blocks as core (regression)", () => {
    const foreignCore = index.filter(
      (e) => e.core && /AIcamera|AMIGO|box_and|bluebit|siot|blynk/i.test(e.type),
    );
    expect(foreignCore.map((e) => e.type)).toEqual([]);
  });

  it("classifies drawing-block slots cleanly with labeled pen-color (regression)", () => {
    // Past bug: the snippet's args0 (authoritative) was unioned with noisy
    // i18n/non-strict name lists, so the pen-color `state` dropdown + x/y inputs
    // were cross-listed as BOTH field and value, and `state` rendered as bare
    // 1|0 with no label — so the model omitted the color on first output.
    const full = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.full.json"), "utf8"));
    const byType = new Map(full.map((b) => [b.type, b]));

    const circle = byType.get("mpython_display_circle");
    const fNames = new Set((circle.fields || []).map((f) => f.name));
    const vNames = new Set((circle.values || []).map((v) => v.name));
    // state is a field only; coordinates are value inputs only — no overlap
    expect(fNames.has("state")).toBe(true);
    expect(vNames.has("state")).toBe(false);
    expect(vNames.has("x")).toBe(true);
    expect(fNames.has("x")).toBe(false);
    const state = circle.fields.find((f) => f.name === "state");
    expect(state.enum.map((e) => `${e.label}:${e.value}`)).toEqual(["绘制:1", "擦除:0"]);

    // the 清屏 block's fill dropdown is fully labeled
    const fill = byType.get("mpython_display_fill").fields.find((f) => f.name === "display_fill");
    expect(fill.enum.find((e) => e.value === "fill(0)").label).toBe("清空");

    // no core block cross-lists a name as both field and value
    const coreDup = full.filter((b) => {
      if (!b.core) return false;
      const fs = new Set((b.fields || []).map((f) => f.name));
      return (b.values || []).some((v) => fs.has(v.name));
    });
    expect(coreDup.map((b) => b.type)).toEqual([]);
  });

  it("every core block ships a non-empty zh description (regression)", () => {
    // Past bug: blocks whose message0 was a Msg ref or bare "%1" exported with an
    // empty zh, so the card head read "(无描述)". They are now resolved from the
    // Msg table or synthesized from type tokens.
    const full = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.full.json"), "utf8"));
    const blankCore = full.filter((b) => b.core && (!b.zh || !b.zh.trim()));
    expect(blankCore.map((b) => b.type)).toEqual([]);
  });
});

d("mpython3 新一代积木偏好 (requires built catalog)", () => {
  const index = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.index.json"), "utf8"));

  it("preferredTypes surfaces the mpython3 event blocks on both boards", () => {
    for (const board of ["mPython", "mPython_V3"]) {
      const pref = preferredTypes(index, board);
      expect(pref).toContain("mpython3_button_event");
      expect(pref).toContain("mpython3_shake_detector");
      expect(pref).toContain("mpython3_main");
      // every entry is an mpython3_* type
      expect(pref.every((t) => t.startsWith("mpython3"))).toBe(true);
    }
  });

  it("preferredTypes excludes labplus/1956-board variants", () => {
    const pref = preferredTypes(index, "mPython");
    expect(pref.some((t) => /1956|labplus/.test(t))).toBe(false);
    expect(pref).not.toContain("mpython3_siot_receive_from_1956");
    expect(pref).not.toContain("mpython3_ir_remote_recv_new1956");
  });

  it("preferGroups ranks the mpython3 IoT receiver above the legacy mpython one", () => {
    const types = retrieve("收到 SIoT 消息", index, {
      topN: 80,
      board: "mPython",
      preferGroups: ["mpython3"],
    }).types;
    const newIdx = types.findIndex((t) => t.startsWith("mpython3_siot"));
    const oldIdx = types.findIndex((t) => /^mpython_siot/.test(t));
    expect(newIdx).toBeGreaterThanOrEqual(0);
    if (oldIdx >= 0) expect(newIdx).toBeLessThan(oldIdx);
  });

  it("buildAgentSystem renders the always-on mpython3 card section", () => {
    const catalog = loadCatalogMap();
    const sys = buildAgentSystem({
      catalog,
      coreTypes: coreTypes(index, "mPython"),
      preferredTypes: preferredTypes(index, "mPython"),
      version: "v2",
    });
    expect(sys).toContain("新一代积木 (mpython3");
    expect(sys).toContain("mpython3_button_event");
    expect(sys).toContain("优先使用 mpython3");
  });
});
