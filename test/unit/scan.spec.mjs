import { describe, it, expect } from "vitest";
import {
  splitTopLevel,
  balancedSlice,
  parseOptionPairs,
  asStringLiteral,
  enclosingObject,
  extractMsgRef,
} from "../../tools/lib/scan.mjs";

describe("splitTopLevel", () => {
  it("splits at depth 0 only", () => {
    expect(splitTopLevel("a,b,c")).toEqual(["a", "b", "c"]);
    expect(splitTopLevel("a,[b,c],d")).toEqual(["a", "[b,c]", "d"]);
    expect(splitTopLevel('a,"b,c",d')).toEqual(["a", '"b,c"', "d"]);
    expect(splitTopLevel("f(a,b),g")).toEqual(["f(a,b)", "g"]);
  });
});

describe("balancedSlice", () => {
  it("returns balanced region respecting strings", () => {
    const s = 'x=[["a","b"],["c","d"]];';
    const idx = s.indexOf("[");
    expect(balancedSlice(s, idx)).toBe('[["a","b"],["c","d"]]');
  });
  it("respects brackets inside strings", () => {
    const s = '[a,"]",b]';
    expect(balancedSlice(s, 0)).toBe('[a,"]",b]');
  });
});

describe("parseOptionPairs", () => {
  it("extracts values from literal label/value pairs", () => {
    const pairs = parseOptionPairs('[["P0","0"],["P1","1"]]');
    expect(pairs).toEqual([
      { label: "P0", value: "0" },
      { label: "P1", value: "1" },
    ]);
  });
  it("handles Msg-ref labels (null label, captures labelRef key)", () => {
    const pairs = parseOptionPairs('[[Me["Msg"].mpython_display_hline_1,"1"],[Me["Msg"].mpython_display_hline_0,"0"]]');
    expect(pairs.map((p) => p.value)).toEqual(["1", "0"]);
    expect(pairs[0].label).toBeNull();
    expect(pairs[0].labelRef).toBe("mpython_display_hline_1");
    expect(pairs[1].labelRef).toBe("mpython_display_hline_0");
  });
  it("handles numeric values", () => {
    const pairs = parseOptionPairs('[["x",1],["y",2]]');
    expect(pairs.map((p) => p.value)).toEqual(["1", "2"]);
  });
});

describe("extractMsgRef", () => {
  it("pulls the trailing key from Msg member access", () => {
    expect(extractMsgRef('Me["Msg"].mpython_display_hline_1')).toBe("mpython_display_hline_1");
    expect(extractMsgRef("r.Msg.foo_bar")).toBe("foo_bar");
    expect(extractMsgRef('a.Msg["scan_mode_0"]')).toBe("scan_mode_0");
  });
  it("returns null for non-Msg tokens", () => {
    expect(extractMsgRef('"literal"')).toBeNull();
    expect(extractMsgRef("someVar")).toBeNull();
  });
});

describe("asStringLiteral", () => {
  it("strips matching quotes", () => {
    expect(asStringLiteral('"hi"')).toBe("hi");
    expect(asStringLiteral("'hi'")).toBe("hi");
    expect(asStringLiteral("hi")).toBeNull();
  });
});

describe("enclosingObject", () => {
  it("returns the object literal containing an index", () => {
    const s = 'args0:[{type:"field_dropdown",name:"button"},{type:"x"}]';
    const idx = s.indexOf('name:"button"');
    expect(enclosingObject(s, idx)).toBe('{type:"field_dropdown",name:"button"}');
  });
});
