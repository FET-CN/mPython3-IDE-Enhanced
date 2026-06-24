import { describe, it, expect } from "vitest";
import {
  annotateIds, enumerateAnchors, applyOps, anchorKey, anchorFromKey,
} from "../../src/host/ops.mjs";
import { extractOps, normalizeOps } from "../../src/llm/extract.mjs";
import { catalogBuilt, loadCatalogMap } from "../helpers/catalog.mjs";

const catalog = catalogBuilt ? loadCatalogMap() : new Map();
const d = catalogBuilt ? describe : describe.skip;

describe("annotateIds", () => {
  it("assigns deterministic preorder ids to every block incl. nested", () => {
    const prog = [[
      { type: "a", inputs: { X: { type: "v" } }, statements: { DO: [{ type: "b" }] } },
      { type: "c" },
    ]];
    const out = annotateIds(prog);
    expect(out[0][0].id).toBe("b1");
    expect(out[0][0].inputs.X.id).toBe("b2"); // input child before statement child
    expect(out[0][0].statements.DO[0].id).toBe("b3");
    expect(out[0][1].id).toBe("b4");
  });
  it("does not mutate the input program", () => {
    const prog = [[{ type: "a" }]];
    annotateIds(prog);
    expect(prog[0][0].id).toBeUndefined();
  });
});

describe("anchor key round-trip", () => {
  it("new / after / body", () => {
    expect(anchorKey({ at: "new" })).toBe("new");
    expect(anchorKey({ at: "after", id: "b3" })).toBe("after:b3");
    expect(anchorKey({ at: "body", id: "b3", input: "DO" })).toBe("body:b3/DO");
    expect(anchorFromKey("after:b3")).toEqual({ at: "after", id: "b3" });
    expect(anchorFromKey("body:b3/DO")).toEqual({ at: "body", id: "b3", input: "DO" });
    expect(anchorFromKey("new")).toEqual({ at: "new" });
  });
});

describe("applyOps (catalog-free structural ops)", () => {
  const prog = () => annotateIds([[
    { type: "s1" }, { type: "s2", statements: { DO: [{ type: "inner" }] } },
  ]]);

  it("clear empties the workspace", () => {
    const r = applyOps(prog(), [{ op: "clear" }], catalog);
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([]);
  });

  it("delete removes a block and heals the chain", () => {
    const r = applyOps(prog(), [{ op: "delete", id: "b1" }], catalog);
    expect(r.ok).toBe(true);
    expect(r.result[0].map((n) => n.type)).toEqual(["s2"]); // s1 gone, s2 remains
  });

  it("move detaches a block and reinserts it (children travel)", () => {
    const r = applyOps(prog(), [{ op: "move", id: "b2", anchor: { at: "new" } }], catalog);
    expect(r.ok).toBe(true);
    // s2 left the first stack, became its own stack carrying its DO body
    expect(r.result[0].map((n) => n.type)).toEqual(["s1"]);
    expect(r.result[1][0].type).toBe("s2");
    expect(r.result[1][0].statements.DO[0].type).toBe("inner");
  });

  it("rejects moving a block into its own subtree (cycle)", () => {
    const r = applyOps(prog(), [{ op: "move", id: "b2", anchor: { at: "body", id: "b3", input: "DO" } }], catalog);
    expect(r.ok).toBe(false);
    expect(r.errors[0].kind).toBe("cycle");
  });

  it("reports bad ids / unknown ops with ops[i] paths", () => {
    const r = applyOps(prog(), [{ op: "delete", id: "nope" }, { op: "frobnicate" }], catalog);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toEqual(["ops[0]", "ops[1]"]);
  });
});

d("applyOps (catalog-aware, requires built catalog)", () => {
  const evtProg = () => annotateIds([[
    { type: "mpython_Interrupt_AB", fields: { button: "button_a", action: "down" }, statements: { DO: [] } },
  ]]);

  it("rejects an event block inserted at a non-new anchor (events only go new)", () => {
    const r = applyOps(evtProg(), [{ op: "insert", anchor: { at: "body", id: "b1", input: "DO" }, blocks: [
      { type: "mpython_Interrupt_AB", statements: { DO: [] } },
    ] }], catalog);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.kind === "hat_not_new")).toBe(true);
  });

  it("rejects after-anchor on a block that can't take a next", () => {
    const r = applyOps(evtProg(), [{ op: "insert", anchor: { at: "after", id: "b1" }, blocks: [{ type: "mpython_set_RGB" }] }], catalog);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.kind === "no_next")).toBe(true);
  });

  it("accepts inserting into the event's DO body", () => {
    const r = applyOps(evtProg(), [{ op: "insert", anchor: { at: "body", id: "b1", input: "DO" }, blocks: [{ type: "mpython_set_RGB" }] }], catalog);
    expect(r.ok).toBe(true);
    expect(r.result[0][0].statements.DO[0].type).toBe("mpython_set_RGB");
  });

  it("insert at new adds a top-level stack", () => {
    const r = applyOps(evtProg(), [{ op: "insert", anchor: { at: "new" }, blocks: [{ type: "mpython_set_RGB" }] }], catalog);
    expect(r.ok).toBe(true);
    expect(r.result.length).toBe(2);
    expect(r.result[1][0].type).toBe("mpython_set_RGB");
  });

  it("setField validates dropdown enums", () => {
    const ok = applyOps(evtProg(), [{ op: "setField", id: "b1", name: "button", value: "button_b" }], catalog);
    expect(ok.ok).toBe(true);
    const bad = applyOps(evtProg(), [{ op: "setField", id: "b1", name: "button", value: "ZZZ" }], catalog);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].kind).toBe("bad_enum_value");
  });

  it("enumerateAnchors lists new + event body", () => {
    const anchors = enumerateAnchors(evtProg(), catalog);
    expect(anchors.some((a) => a.key === "new")).toBe(true);
    expect(anchors.some((a) => a.key === "body:b1/DO")).toBe(true);
  });
});

describe("extractOps", () => {
  it("parses a fenced {ops:[...]} object", () => {
    const t = '好的\n```json\n{"ops":[{"op":"clear"}]}\n```';
    expect(extractOps(t)).toMatchObject({ ops: [{ op: "clear" }], repaired: false });
  });
  it("wraps a bare op array and a single op object", () => {
    expect(normalizeOps([{ op: "clear" }])).toEqual([{ op: "clear" }]);
    expect(normalizeOps({ op: "clear" })).toEqual([{ op: "clear" }]);
    expect(normalizeOps({ ops: [{ op: "delete", id: "b1" }] })).toEqual([{ op: "delete", id: "b1" }]);
  });
  it("throws on non-JSON", () => {
    expect(() => extractOps("no json")).toThrow();
  });
});
