import { describe, it, expect } from "vitest";
import { DOMParser } from "linkedom";
import { compile } from "../../src/xml/compile.mjs";
import { decompile, canonicalize } from "../../src/xml/decompile.mjs";
import { validate } from "../../src/xml/validate.mjs";
import { catalogBuilt, loadCatalogMap } from "../helpers/catalog.mjs";

const d = catalogBuilt ? describe : describe.skip;

d("IR core (requires built catalog)", () => {
  const catalog = loadCatalogMap();
  const opts = { DOMParser };

  // A realistic program: when button A pressed → repeat 3 times → print "hi".
  const program = [
    [
      {
        type: "mpython_Interrupt_AB",
        fields: { button: "button_a", action: "down" },
        statements: {
          DO: [
            {
              type: "controls_repeat_ext",
              inputs: { TIMES: { type: "math_number", fields: { NUM: "3" } } },
              statements: {
                DO: [
                  { type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "hi" } } } },
                ],
              },
            },
          ],
        },
      },
    ],
  ];

  it("compile produces well-formed XML with namespace + positioned root", () => {
    const xml = compile(program, { catalog });
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    expect(doc.documentElement.nodeName.toLowerCase()).toBe("xml");
    const root = doc.getElementsByTagName("block")[0];
    expect(root.getAttribute("type")).toBe("mpython_Interrupt_AB");
    expect(root.getAttribute("x")).toBeTruthy();
    expect(xml).toContain("<statement name=\"DO\">");
    expect(xml).toContain("<value name=\"TIMES\">");
  });

  it("round-trips: decompile(compile(ir)) === canonical ir", () => {
    const xml = compile(program, { catalog });
    const back = decompile(xml, opts);
    expect(back).toEqual(canonicalize(program));
  });

  it("round-trips controls_if with mutation (else branch)", () => {
    const prog = [[
      {
        type: "controls_if",
        inputs: { IF0: { type: "logic_boolean", fields: { BOOL: "TRUE" } } },
        statements: {
          DO0: [{ type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "yes" } } } }],
          ELSE: [{ type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "no" } } } }],
        },
      },
    ]];
    const xml = compile(prog, { catalog });
    expect(xml).toContain('<mutation else="1">');
    expect(decompile(xml, opts)).toEqual(canonicalize(prog));
  });

  it("compiles multiple top-level stacks separately", () => {
    const prog = [
      [{ type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "a" } } } }],
      [{ type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "b" } } } }],
    ];
    const xml = compile(prog, { catalog });
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const tops = [...doc.documentElement.childNodes].filter(
      (n) => n.nodeType === 1 && n.nodeName.toLowerCase() === "block",
    );
    expect(tops.length).toBe(2);
  });

  describe("validator", () => {
    it("accepts the valid program", () => {
      expect(validate(program, catalog).ok).toBe(true);
    });

    it("flags unknown block type with suggestions", () => {
      const bad = [[{ type: "math_numbr", fields: { NUM: "1" } }]];
      const r = validate(bad, catalog);
      expect(r.ok).toBe(false);
      const e = r.errors.find((x) => x.kind === "unknown_type");
      expect(e).toBeTruthy();
      expect(e.suggestions).toContain("math_number");
    });

    it("flags out-of-enum dropdown value", () => {
      const bad = [[{ type: "mpython_Interrupt_AB", fields: { button: "X", action: "down" }, statements: { DO: [] } }]];
      const r = validate(bad, catalog);
      const e = r.errors.find((x) => x.kind === "bad_enum_value");
      expect(e).toBeTruthy();
      expect(e.suggestions).toContain("button_a");
    });

    it("flags a value block placed in a statement sequence", () => {
      const bad = [[{ type: "math_number", fields: { NUM: "1" } }]];
      const r = validate(bad, catalog);
      expect(r.errors.some((x) => x.kind === "misplaced_value")).toBe(true);
    });

    it("flags unknown field and input names", () => {
      const bad = [[
        { type: "controls_repeat_ext", fields: { NOPE: "1" }, inputs: { WRONG: { type: "math_number", fields: { NUM: "1" } } }, statements: { DO: [] } },
      ]];
      const r = validate(bad, catalog);
      expect(r.errors.some((x) => x.kind === "unknown_field")).toBe(true);
      expect(r.errors.some((x) => x.kind === "unknown_input")).toBe(true);
    });

    it("flags type mismatch in a typed value slot", () => {
      // TIMES expects Number; feed a String-output text block
      const bad = [[
        { type: "controls_repeat_ext", inputs: { TIMES: { type: "text", fields: { TEXT: "x" } } }, statements: { DO: [] } },
      ]];
      const r = validate(bad, catalog);
      expect(r.errors.some((x) => x.kind === "type_mismatch")).toBe(true);
    });
  });
});
