import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { retrieve, coreTypes, boardAllows, preferredTypes } from "../../src/kb/retriever.mjs";
import { annotateIds, enumerateAnchors } from "../../src/host/ops.mjs";
import { boardFromMaster } from "../../src/kb/knowledge.mjs";
import { buildAgentSystem } from "../../src/ctx/agent-prompt.mjs";
import { makeVisible } from "../../src/runtime/data.mjs";
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
    // Names are the CURRENT side-palette blocks (display_circle → display_shape_circle).
    const first60 = new Set(coreTypes(index, "mPython").slice(0, 60));
    for (const t of [
      "mpython_display_fill", "mpython_display_Show", "mpython_display_shape_circle",
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

  it("mpython_main has a real next connection (not a statement body)", () => {
    const full = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.full.json"), "utf8"));
    const catalog = new Map(full.map((b) => [b.type, b]));
    const main = catalog.get("mpython_main");
    expect(main).toMatchObject({ zh: "主程序", prev: false, next: true, statements: [] });

    const current = annotateIds([[{ type: "mpython_main" }]]);
    const anchors = enumerateAnchors(current, catalog);
    expect(anchors).toContainEqual(expect.objectContaining({ key: "after:b1", at: "after", id: "b1" }));
    expect(anchors.some((a) => a.key === "body:b1/")).toBe(false);
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

d("侧边栏真实可见积木偏好 (requires built catalog + toolbox.visible.json)", () => {
  const index = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.index.json"), "utf8"));
  const visRaw = JSON.parse(readFileSync(resolve(ROOT, "data/toolbox.visible.json"), "utf8"));
  const vis = makeVisible(visRaw);

  it("preferredTypes uses the board's real visible set, not every mpython3 block", () => {
    for (const board of ["mPython", "mPython_V3"]) {
      const set = vis.forBoard(board);
      const pref = preferredTypes(index, board, set);
      expect(pref.length).toBe(set.size);
      expect(pref.every((t) => set.has(t))).toBe(true);
      expect(pref).toContain("mpython_main");       // visible on both boards
      expect(pref).not.toContain("mpython3_main");  // hidden, do not teach as default
      expect(pref).toContain("mpython3_button_event"); // visible mpython3 event hats still surface
    }
  });

  it("retrieve can filter to visible blocks, while include-hidden mode only boosts", () => {
    const set = vis.forBoard("mPython");
    const visibleOnly = retrieve("主程序", index, { topN: 50, board: "mPython", visibleSet: set, visibleMode: "filter" }).types;
    expect(visibleOnly).toContain("mpython_main");
    expect(visibleOnly).not.toContain("mpython3_main");

    const boosted = retrieve("主程序", index, { topN: 50, board: "mPython", visibleSet: set, visibleMode: "boost" }).types;
    expect(boosted).toContain("mpython_main");
  });

  it("buildAgentSystem renders a visible-toolbox preferred section", () => {
    const catalog = loadCatalogMap();
    const visibleSet = vis.forBoard("mPython");
    const sys = buildAgentSystem({
      catalog,
      coreTypes: coreTypes(index, "mPython", visibleSet),
      preferredTypes: preferredTypes(index, "mPython", visibleSet),
      version: "v2",
    });
    expect(sys).toContain("侧边栏可见积木");
    expect(sys).toContain("mpython_main");
    expect(sys).not.toContain("优先使用 mpython3");
  });
});

d("toolbox 可见性 (requires built catalog + toolbox.visible.json)", () => {
  const index = JSON.parse(readFileSync(resolve(ROOT, "data/catalog.index.json"), "utf8"));
  const visRaw = JSON.parse(readFileSync(resolve(ROOT, "data/toolbox.visible.json"), "utf8"));
  const vis = makeVisible(visRaw);
  const catTypes = new Set(index.map((b) => b.type));

  it("snapshot has per-board sets, all ⊂ catalog", () => {
    expect(vis.has).toBe(true);
    for (const board of ["mPython", "mPython_V3"]) {
      const set = vis.forBoard(board);
      expect(set && set.size).toBeGreaterThan(100);
      for (const t of set) expect(catTypes.has(t), `${t} not in catalog`).toBe(true);
    }
    expect(vis.forBoard("nope")).toBeNull(); // unknown board → no filtering
  });

  it("coreTypes ∩ visible drops retired blocks and keeps live replacements", () => {
    const v2 = vis.forBoard("mPython");
    const core = coreTypes(index, "mPython", v2);
    // retired → gone
    for (const t of ["mpython_set_RGB", "mpython_display_circle", "mpython_button_is_pressed", "logic_operation"]) {
      expect(core).not.toContain(t);
    }
    // current side-palette replacements → present (force-included via priority spine
    // even though some carry core:false in the catalog)
    for (const t of ["mpython_set_rgb_list_color", "mpython_display_shape_circle", "mpython_button_pressed", "logic_operation_2", "math_random_int_time"]) {
      expect(core, `${t} should be in visible-filtered core`).toContain(t);
    }
  });

  it("coreTypes without a visible set keeps legacy behavior (backward compatible)", () => {
    const core = coreTypes(index, "mPython");
    expect(core).toContain("mpython_display_DispChar"); // still works with no snapshot
  });

  it("retrieve biases toward side-palette-visible blocks", () => {
    const v2 = vis.forBoard("mPython");
    const withVis = retrieve("设置 RGB 灯颜色", index, { topN: 30, board: "mPython", visibleSet: v2 }).types;
    // the live RGB block should outrank the retired mpython_set_RGB
    const liveIdx = withVis.findIndex((t) => t === "mpython_set_rgb_list_color");
    const oldIdx = withVis.findIndex((t) => t === "mpython_set_RGB");
    expect(liveIdx).toBeGreaterThanOrEqual(0);
    if (oldIdx >= 0) expect(liveIdx).toBeLessThan(oldIdx);
  });
});
