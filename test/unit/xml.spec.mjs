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

    it("accepts dynamic ADDn inputs on mutator value blocks", () => {
      const prog = [[{
        type: "text_print",
        inputs: {
          TEXT: {
            type: "text_join",
            inputs: {
              ADD0: { type: "text", fields: { TEXT: "a" } },
              ADD1: { type: "text", fields: { TEXT: "b" } },
              ADD2: { type: "text", fields: { TEXT: "c" } },
              ADD3: { type: "text", fields: { TEXT: "d" } },
            },
          },
        },
      }]];
      const r = validate(prog, catalog);
      expect(r.ok).toBe(true);
      const xml = compile(prog, { catalog });
      expect(xml).toContain('<mutation items="4">');
    });

    it("next 型事件帽子块误塞 DO → unknown_statement 给正向接法提示（顺接其后）", () => {
      // mpython3_radio_recv 无 DO 插槽，事件体应顺接其后。误放进 statements.DO 时报错应导向 at:"after"。
      const bad = [[{ type: "mpython3_radio_recv", statements: { DO: [{ type: "mpython_display_Show" }] } }]];
      const r = validate(bad, catalog);
      const e = r.errors.find((x) => x.kind === "unknown_statement");
      expect(e).toBeTruthy();
      expect(e.detail).toContain('at:"after"');
      expect(e.detail).toContain("顺接其后");
    });

    it("DO 型积木误用未知插槽 → 仍是普通「没有语句插槽」报错（不误导向 next）", () => {
      // controls_repeat_ext 有 DO 插槽但无 FOO；不应蹭到 next 型的正向文案。
      const bad = [[{ type: "controls_repeat_ext", inputs: { TIMES: { type: "math_number", fields: { NUM: "1" } } }, statements: { FOO: [] } }]];
      const r = validate(bad, catalog);
      const e = r.errors.find((x) => x.kind === "unknown_statement");
      expect(e).toBeTruthy();
      expect(e.detail).not.toContain("顺接其后");
      expect(e.suggestions).toContain("DO");
    });
  });
});
