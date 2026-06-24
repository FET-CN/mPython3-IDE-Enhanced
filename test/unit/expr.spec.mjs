import { describe, it, expect } from "vitest";
import { parseExpr, expandOps, ExprError } from "../../src/ir/expr.mjs";

// helpers to read the produced tree compactly
const op = (n) => n.fields?.OP;
const num = (n) => (n.type === "math_number" ? n.fields.NUM : undefined);

describe("parseExpr — literals & atoms", () => {
  it("number / negative number (literal folding)", () => {
    expect(parseExpr("20")).toEqual({ type: "math_number", fields: { NUM: "20" } });
    expect(parseExpr("-5")).toEqual({ type: "math_number", fields: { NUM: "-5" } });
    expect(parseExpr("3.14")).toEqual({ type: "math_number", fields: { NUM: "3.14" } });
  });
  it("string literal vs bare-word variable", () => {
    expect(parseExpr("'Hi'")).toEqual({ type: "text", fields: { TEXT: "Hi" } });
    expect(parseExpr('"Hi"')).toEqual({ type: "text", fields: { TEXT: "Hi" } });
    expect(parseExpr("angle1")).toEqual({ type: "variables_get", fields: { VAR: "angle1" } });
  });
  it("booleans and pi constant", () => {
    expect(parseExpr("true")).toEqual({ type: "logic_boolean", fields: { BOOL: "TRUE" } });
    expect(parseExpr("false")).toEqual({ type: "logic_boolean", fields: { BOOL: "FALSE" } });
    expect(parseExpr("pi")).toEqual({ type: "math_constant", fields: { CONSTANT: "PI" } });
  });
});

describe("parseExpr — arithmetic precedence & associativity", () => {
  it("* binds tighter than +", () => {
    const n = parseExpr("2 + 3 * 4");
    expect(op(n)).toBe("ADD");
    expect(num(n.inputs.A)).toBe("2");
    expect(op(n.inputs.B)).toBe("MULTIPLY");
  });
  it("parentheses override precedence", () => {
    const n = parseExpr("(2 + 3) * 4");
    expect(op(n)).toBe("MULTIPLY");
    expect(op(n.inputs.A)).toBe("ADD");
  });
  it("** is right-associative", () => {
    const n = parseExpr("2 ** 3 ** 2"); // 2 ** (3 ** 2)
    expect(op(n)).toBe("POWER");
    expect(num(n.inputs.A)).toBe("2");
    expect(op(n.inputs.B)).toBe("POWER");
  });
  it("% maps to math_modulo", () => {
    const n = parseExpr("(a + 10) % 360");
    expect(n.type).toBe("math_modulo");
    expect(op(n.inputs.DIVIDEND)).toBe("ADD");
    expect(num(n.inputs.DIVISOR)).toBe("360");
  });
  it("unary minus on an expression → math_single NEG", () => {
    const n = parseExpr("-cos(x)");
    expect(n).toMatchObject({ type: "math_single", fields: { OP: "NEG" } });
    expect(n.inputs.NUM.type).toBe("math_trig");
  });
});

describe("parseExpr — comparison & logic", () => {
  it("comparison ops", () => {
    expect(parseExpr("a < b")).toMatchObject({ type: "logic_compare", fields: { OP: "LT" } });
    expect(parseExpr("a >= b")).toMatchObject({ type: "logic_compare", fields: { OP: "GTE" } });
    expect(parseExpr("a == b")).toMatchObject({ type: "logic_compare", fields: { OP: "EQ" } });
    expect(parseExpr("a != b")).toMatchObject({ type: "logic_compare", fields: { OP: "NEQ" } });
  });
  it("and / or / not with correct precedence (or < and < not)", () => {
    const n = parseExpr("a or b and not c");
    expect(n).toMatchObject({ type: "logic_operation", fields: { OP: "OR" } });
    expect(n.inputs.B).toMatchObject({ type: "logic_operation", fields: { OP: "AND" } });
    expect(n.inputs.B.inputs.B.type).toBe("logic_negate");
  });
  it("ternary a if c else b → logic_ternary", () => {
    const n = parseExpr("x if a > 0 else y");
    expect(n.type).toBe("logic_ternary");
    expect(n.inputs.IF).toMatchObject({ type: "logic_compare", fields: { OP: "GT" } });
    expect(n.inputs.THEN).toMatchObject({ type: "variables_get", fields: { VAR: "x" } });
    expect(n.inputs.ELSE).toMatchObject({ type: "variables_get", fields: { VAR: "y" } });
  });
});

describe("parseExpr — functions", () => {
  it("trig / single / round", () => {
    expect(parseExpr("cos(x)")).toMatchObject({ type: "math_trig", fields: { OP: "COS" } });
    expect(parseExpr("sqrt(x)")).toMatchObject({ type: "math_single", fields: { OP: "ROOT" } });
    expect(parseExpr("abs(x)")).toMatchObject({ type: "math_single", fields: { OP: "ABS" } });
    expect(parseExpr("floor(x)")).toMatchObject({ type: "math_round", fields: { OP: "ROUNDDOWN" } });
  });
  it("multi-arg functions", () => {
    expect(parseExpr("random(1, 6)")).toMatchObject({
      type: "math_random_int",
      inputs: { FROM: { fields: { NUM: "1" } }, TO: { fields: { NUM: "6" } } },
    });
    expect(parseExpr("constrain(v, 0, 100)")).toMatchObject({ type: "math_constrain" });
    expect(parseExpr("mod(a, b)")).toMatchObject({ type: "math_modulo" });
  });
});

describe("parseExpr — out-of-grammar inputs throw ExprError", () => {
  const bad = [
    ["unknown function", "hypot(a, b)"],
    ["indexing / bracket", "s[2]"],
    ["bitwise", "a & b"],
    ["arity mismatch", "sin(a, b)"],
    ["unclosed string", "'oops"],
    ["empty", "   "],
    ["trailing token", "1 2"],
    ["incomplete", "1 +"],
  ];
  for (const [label, src] of bad) {
    it(label, () => {
      expect(() => parseExpr(src)).toThrow(ExprError);
    });
  }
});

describe("expandOps — string inputs in insert.blocks", () => {
  it("expands string inputs recursively, leaving explicit nodes intact", () => {
    const ops = [
      {
        op: "insert",
        anchor: { at: "new" },
        blocks: [
          {
            type: "mpython_display_fill_circle",
            fields: { state: "1" },
            inputs: {
              x: "64 + 20*cos(angle)",
              y: { type: "math_number", fields: { NUM: "32" } }, // explicit stays
              radius: "4",
            },
          },
          { type: "variables_set", fields: { VAR: "angle" }, inputs: { VALUE: "(angle + 10) % 360" } },
        ],
      },
    ];
    const { ops: out, errors } = expandOps(ops);
    expect(errors).toEqual([]);
    const fc = out[0].blocks[0];
    expect(fc.inputs.x).toMatchObject({ type: "math_arithmetic", fields: { OP: "ADD" } });
    expect(fc.inputs.x.inputs.B.inputs.B.type).toBe("math_trig");
    expect(fc.inputs.y).toEqual({ type: "math_number", fields: { NUM: "32" } });
    expect(fc.inputs.radius).toEqual({ type: "math_number", fields: { NUM: "4" } });
    expect(out[0].blocks[1].inputs.VALUE.type).toBe("math_modulo");
  });

  it("expands strings nested inside statement bodies", () => {
    const ops = [
      {
        op: "insert",
        anchor: { at: "new" },
        blocks: [
          {
            type: "controls_if",
            inputs: { IF0: "a > 0" },
            statements: { DO0: [{ type: "variables_set", fields: { VAR: "x" }, inputs: { VALUE: "x + 1" } }] },
          },
        ],
      },
    ];
    const { ops: out, errors } = expandOps(ops);
    expect(errors).toEqual([]);
    expect(out[0].blocks[0].inputs.IF0.type).toBe("logic_compare");
    expect(out[0].blocks[0].statements.DO0[0].inputs.VALUE).toMatchObject({
      type: "math_arithmetic",
      fields: { OP: "ADD" },
    });
  });

  it("surfaces expr_error with an ops[i] path; does not throw", () => {
    const ops = [{ op: "insert", anchor: { at: "new" }, blocks: [{ type: "foo", inputs: { X: "a[2] + 1" } }] }];
    const { errors } = expandOps(ops);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "expr_error", path: "ops[0].blocks[0].inputs.X" });
  });

  it("leaves non-insert ops untouched", () => {
    const ops = [
      { op: "delete", id: "b4" },
      { op: "setField", id: "b3", name: "TEXT", value: "1 + 1" }, // value is NOT expanded
      { op: "clear" },
    ];
    const { ops: out, errors } = expandOps(ops);
    expect(errors).toEqual([]);
    expect(out).toEqual(ops);
  });
});
