import { describe, it, expect } from "vitest";
import { DOMParser } from "linkedom";
import { patchOps, buildIdMap } from "../../src/xml/patch.mjs";
import { annotateIds } from "../../src/host/ops.mjs";
import { decompile } from "../../src/xml/decompile.mjs";
import { catalogBuilt, loadCatalogMap } from "../helpers/catalog.mjs";

const NS = "https://developers.google.com/blockly/xml";
const opts = { DOMParser, catalog: catalogBuilt ? loadCatalogMap() : new Map() };
const parse = (xml) => new DOMParser().parseFromString(xml, "text/xml");
const root = (xml) => parse(xml).documentElement;
const types = (xml) => {
  const d = parse(xml);
  return [...d.getElementsByTagName("block")].map((b) => b.getAttribute("type"));
};

// A workspace stack like the user's screenshot: a hat with an OLED-clear, a
// display block whose image input is a SHADOW mpython_pbm_image, and a show —
// with math_number SHADOW defaults in the coordinate slots.
const SHADOW_IMG =
  '<shadow type="mpython_pbm_image"><field name="file_image">static/face/3.png</field><field name="path">face/3.pbm</field></shadow>';
const WORKSPACE = `<xml xmlns="${NS}">
  <block type="mpython_radio_recv" id="A1" x="20" y="20">
    <statement name="DO">
      <block type="mpython_display_DispChar">
        <value name="x"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
        <value name="y"><shadow type="math_number"><field name="NUM">48</field></shadow></value>
        <value name="message">${SHADOW_IMG}</value>
        <field name="mode">normal</field>
        <next><block type="mpython_display_Show"></block></next>
      </block>
    </statement>
  </block>
</xml>`;

describe("buildIdMap mirrors annotateIds(decompile(xml))", () => {
  // distinct types per position so id→type pins the traversal order
  const samples = [
    `<xml xmlns="${NS}"><block type="aaa"><value name="X"><block type="bbb"></block></value>` +
      `<statement name="DO"><block type="ccc"></block></statement>` +
      `<next><block type="ddd"></block></next></block></xml>`,
    WORKSPACE,
    `<xml xmlns="${NS}"><block type="t1"></block><block type="t2"><statement name="DO">` +
      `<block type="t3"><next><block type="t4"></block></next></block></statement></block></xml>`,
  ];
  it("assigns identical ids in identical order (only <block>, skips <shadow>)", () => {
    for (const xml of samples) {
      const ir = annotateIds(decompile(xml, { DOMParser }));
      const want = new Map();
      const walk = (n) => {
        if (n.id) want.set(n.id, n.type);
        for (const v of Object.values(n.inputs || {})) walk(v);
        for (const seq of Object.values(n.statements || {})) for (const c of seq) walk(c);
      };
      for (const stack of ir) for (const n of stack) walk(n);

      const got = buildIdMap(root(xml));
      const gotTypes = new Map([...got].map(([id, el]) => [id, el.getAttribute("type")]));
      expect(gotTypes).toEqual(want);
      // shadows never get ids
      expect([...got.values()].some((el) => el.nodeName.toLowerCase() === "shadow")).toBe(false);
    }
  });
});

describe("patchOps preserves untouched blocks (the bug)", () => {
  it("insert@new keeps every existing shadow byte-identical", () => {
    const ops = [{
      op: "insert", anchor: { at: "new" },
      blocks: [{ type: "mpython_set_RGB" }],
    }];
    const { ok, xml } = patchOps(WORKSPACE, ops, opts);
    expect(ok).toBe(true);
    // the 内置图像 shadow + its pbm path survive intact
    expect(xml).toContain('<shadow type="mpython_pbm_image">');
    expect(xml).toContain('<field name="path">face/3.pbm</field>');
    // coordinate math_number shadows survive
    expect(xml).toContain('<field name="NUM">48</field>');
    // and the new block landed as a second top-level stack
    expect(types(xml)).toContain("mpython_set_RGB");
    expect(types(xml).filter((t) => t === "mpython_display_DispChar").length).toBe(1);
  });

  it("setField on one block does not disturb sibling shadows", () => {
    // id b2 = the DispChar block (b1=hat, b2=DispChar, b3=Show in this layout)
    const map = buildIdMap(root(WORKSPACE));
    const dispId = [...map].find(([, el]) => el.getAttribute("type") === "mpython_display_DispChar")[0];
    const { ok, xml } = patchOps(WORKSPACE, [{ op: "setField", id: dispId, name: "TEXTMODE", value: "1" }], opts);
    expect(ok).toBe(true);
    expect(xml).toContain('<shadow type="mpython_pbm_image">');
  });
});

describe("patchOps insert details", () => {
  it("merges variable declarations from the inserted fragment", () => {
    const ops = [{
      op: "insert", anchor: { at: "new" },
      blocks: [{
        type: "mpython_radio_recv",
        inputs: { message: { type: "variables_get", fields: { VAR: "msg" } } },
        statements: { DO: [] },
      }],
    }];
    const empty = `<xml xmlns="${NS}"></xml>`;
    const { ok, xml } = patchOps(empty, ops, opts);
    expect(ok).toBe(true);
    expect(xml).toContain("<variables>");
    expect(xml).toContain(">msg</variable>");
  });

  it("insert after threads the existing continuation behind the inserted block", () => {
    const base = `<xml xmlns="${NS}"><block type="mpython_radio_recv" id="H"><statement name="DO">` +
      `<block type="mpython_set_RGB"><next><block type="mpython_display_Show"></block></next></block>` +
      `</statement></block></xml>`;
    const map = buildIdMap(root(base));
    const rgbId = [...map].find(([, el]) => el.getAttribute("type") === "mpython_set_RGB")[0];
    const { ok, xml } = patchOps(base, [{
      op: "insert", anchor: { at: "after", id: rgbId },
      blocks: [{ type: "mpython_display_DispChar" }],
    }], opts);
    expect(ok).toBe(true);
    // order inside DO body: set_RGB → DispChar → Show
    const order = types(xml);
    expect(order).toEqual(["mpython_radio_recv", "mpython_set_RGB", "mpython_display_DispChar", "mpython_display_Show"]);
  });

  it("rejects a hat block at a non-new anchor", () => {
    const map = buildIdMap(root(WORKSPACE));
    const hatId = [...map].find(([, el]) => el.getAttribute("type") === "mpython_radio_recv")[0];
    const { ok, errors } = patchOps(WORKSPACE, [{
      op: "insert", anchor: { at: "body", id: hatId, input: "DO" },
      blocks: [{ type: "mpython_radio_recv", statements: { DO: [] } }],
    }], opts);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.kind === "hat_not_new")).toBe(true);
  });
});

describe("patchOps delete / move / clear / setField validation", () => {
  it("delete heals the chain and keeps surviving shadows", () => {
    // delete the DispChar block → Show heals up; but DispChar carried the image,
    // so deleting it is expected to drop its own shadow. Use a base with a
    // sibling stack that must remain untouched.
    const base = `<xml xmlns="${NS}">` +
      `<block type="mpython_radio_recv" id="H1"><statement name="DO">` +
      `<block type="mpython_set_RGB"><next><block type="mpython_display_Show"></block></next></block>` +
      `</statement></block>` +
      `<block type="mpython_radio_recv" id="H2"><statement name="DO">` +
      `<block type="mpython_display_DispChar"><value name="message">${SHADOW_IMG}</value></block>` +
      `</statement></block></xml>`;
    const map = buildIdMap(root(base));
    const rgbId = [...map].find(([, el]) => el.getAttribute("type") === "mpython_set_RGB")[0];
    const { ok, xml } = patchOps(base, [{ op: "delete", id: rgbId }], opts);
    expect(ok).toBe(true);
    // set_RGB gone, Show healed up into the DO body
    expect(types(xml)).toEqual(["mpython_radio_recv", "mpython_display_Show", "mpython_radio_recv", "mpython_display_DispChar"]);
    // the OTHER stack's image shadow is untouched
    expect(xml).toContain('<shadow type="mpython_pbm_image">');
  });

  it("move detaches a block (continuation stays) and re-places it", () => {
    const base = `<xml xmlns="${NS}"><block type="mpython_radio_recv" id="H"><statement name="DO">` +
      `<block type="mpython_set_RGB"><next><block type="mpython_display_Show"></block></next></block>` +
      `</statement></block></xml>`;
    const map = buildIdMap(root(base));
    const rgbId = [...map].find(([, el]) => el.getAttribute("type") === "mpython_set_RGB")[0];
    const { ok, xml } = patchOps(base, [{ op: "move", id: rgbId, anchor: { at: "new" } }], opts);
    expect(ok).toBe(true);
    // set_RGB became its own top stack; Show stays in the DO body
    const d = parse(xml);
    const tops = [...d.documentElement.childNodes].filter((n) => n.nodeType === 1 && n.nodeName.toLowerCase() === "block");
    expect(tops.map((b) => b.getAttribute("type"))).toEqual(["mpython_radio_recv", "mpython_set_RGB"]);
  });

  it("rejects moving a block into its own subtree", () => {
    const map = buildIdMap(root(WORKSPACE));
    const hatId = [...map].find(([, el]) => el.getAttribute("type") === "mpython_radio_recv")[0];
    const dispId = [...map].find(([, el]) => el.getAttribute("type") === "mpython_display_DispChar")[0];
    const { ok, errors } = patchOps(WORKSPACE, [{ op: "move", id: hatId, anchor: { at: "body", id: dispId, input: "DO" } }], opts);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.kind === "cycle")).toBe(true);
  });

  it("clear empties the workspace", () => {
    const { ok, xml } = patchOps(WORKSPACE, [{ op: "clear" }], opts);
    expect(ok).toBe(true);
    expect(types(xml)).toEqual([]);
  });

  it("setField rejects an out-of-enum dropdown value", () => {
    const base = `<xml xmlns="${NS}"><block type="mpython_Interrupt_AB" id="E">` +
      `<field name="button">button_a</field><field name="action">down</field><statement name="DO"></statement></block></xml>`;
    const map = buildIdMap(root(base));
    const id = [...map].find(([, el]) => el.getAttribute("type") === "mpython_Interrupt_AB")?.[0];
    if (!id) return; // skip if board block absent from catalog
    const okRes = patchOps(base, [{ op: "setField", id, name: "button", value: "button_b" }], opts);
    expect(okRes.ok).toBe(true);
    expect(okRes.xml).toContain(">button_b</field>");
    const bad = patchOps(base, [{ op: "setField", id, name: "button", value: "ZZZ" }], opts);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].kind).toBe("bad_enum_value");
  });
});
