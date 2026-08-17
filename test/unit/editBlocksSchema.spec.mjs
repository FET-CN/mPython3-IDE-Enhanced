import { describe, it, expect } from "vitest";
import { editBlocksTool } from "../../src/agent/tools/editBlocks.mjs";
import {
  EDIT_BLOCKS_FALLBACK_PARAMETERS,
  EDIT_BLOCKS_PARAMETERS,
  EDIT_BLOCKS_SCHEMA_VERSION,
  decodeEditBlocksArgs,
} from "../../src/agent/tools/editBlocksSchema.mjs";

const node = (type, values = {}) => ({
  type,
  fields: values.fields || [],
  inputs: values.inputs || [],
  statements: values.statements || [],
});

const op = (kind, values = {}) => ({
  op: kind,
  id: null,
  name: null,
  value: null,
  anchor: null,
  blocks: [],
  ...values,
});

const anchor = (at, values = {}) => ({ at, id: null, input: null, index: null, ...values });

describe("edit_blocks structured schema", () => {
  it("publishes a versioned, closed recursive Wire contract", () => {
    expect(EDIT_BLOCKS_SCHEMA_VERSION).toBe(2);
    expect(editBlocksTool.parameters).toBe(EDIT_BLOCKS_PARAMETERS);
    expect(editBlocksTool.fallbackParameters).toBe(EDIT_BLOCKS_FALLBACK_PARAMETERS);
    expect(EDIT_BLOCKS_PARAMETERS).toMatchObject({
      type: "object",
      required: ["ops"],
      additionalProperties: false,
    });
    expect(EDIT_BLOCKS_PARAMETERS.properties.ops.items).toMatchObject({
      additionalProperties: false,
      required: ["op", "id", "name", "value", "anchor", "blocks"],
    });
    expect(EDIT_BLOCKS_PARAMETERS.$defs.node).toMatchObject({
      additionalProperties: false,
      required: ["type", "fields", "inputs", "statements"],
    });
    expect(EDIT_BLOCKS_PARAMETERS.$defs.node.properties.inputs.items.properties.block.anyOf)
      .toContainEqual({ $ref: "#/$defs/node" });
  });

  it("decodes every operation and recursive Wire nodes to the internal map IR", () => {
    const args = {
      ops: [
        op("clear"),
        op("insert", {
          anchor: anchor("new"),
          blocks: [node("controls_if", {
            inputs: [
              { name: "IF0", kind: "expr", expression: "x > 0", block: null },
              { name: "VALUE", kind: "block", expression: null, block: node("math_number", { fields: [{ name: "NUM", value: "1" }] }) },
            ],
            statements: [{
              name: "DO0",
              blocks: [node("text_print", {
                inputs: [{ name: "TEXT", kind: "expr", expression: "'ok'", block: null }],
              })],
            }],
          })],
        }),
        op("delete", { id: "b1" }),
        op("move", { id: "b2", anchor: anchor("body", { id: "b1", input: "DO", index: 0 }) }),
        op("setField", { id: "b3", name: "OP", value: "ADD" }),
      ],
    };
    const decoded = decodeEditBlocksArgs(args);
    expect(decoded.ok).toBe(true);
    expect(decoded.args.ops[1]).toEqual({
      op: "insert",
      anchor: { at: "new" },
      blocks: [{
        type: "controls_if",
        inputs: {
          IF0: "x > 0",
          VALUE: { type: "math_number", fields: { NUM: "1" } },
        },
        statements: {
          DO0: [{ type: "text_print", inputs: { TEXT: "'ok'" } }],
        },
      }],
    });
  });

  it("rejects unknown keys, malformed anchors and duplicate entry names", () => {
    const result = decodeEditBlocksArgs({
      ops: [op("insert", {
        anchor: anchor("after", { id: "made-up", extra: true }),
        blocks: [node("math_number", {
          fields: [{ name: "NUM", value: "1" }, { name: "NUM", value: "2" }],
        })],
      })],
      surprise: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "$.surprise 是未定义的参数",
      "$.ops[0].anchor.extra 是未定义的参数",
      "$.ops[0].anchor.id 必须是当前工作区的 bN id",
      "$.ops[0].blocks[0].fields 中的 NUM 重复",
    ]));
  });

  it("keeps accepting the legacy map DTO at the local compatibility boundary", () => {
    const args = {
      ops: [{
        op: "insert",
        anchor: { at: "new" },
        blocks: [{ type: "text_print", inputs: { TEXT: { type: "text", fields: { TEXT: "ok" } } } }],
      }],
    };
    expect(decodeEditBlocksArgs(args)).toEqual({ ok: true, args });
  });

  it("rejects empty plans and unknown operations", () => {
    expect(decodeEditBlocksArgs({ ops: [] }).ok).toBe(false);
    const result = decodeEditBlocksArgs({ ops: [{ op: "replaceAll" }] });
    expect(result.errors[0]).toContain("clear、insert、delete、move 或 setField");
  });

  it("returns shape errors instead of throwing for non-array containers", () => {
    expect(() => decodeEditBlocksArgs({ ops: {} })).not.toThrow();
    expect(() => decodeEditBlocksArgs({ ops: [op("insert", { anchor: anchor("new"), blocks: {} })] })).not.toThrow();
    expect(decodeEditBlocksArgs({ ops: {} }).ok).toBe(false);
  });

  it("feeds shape failures into preflight before touching the host", () => {
    const result = editBlocksTool.preflight({ ops: [{ op: "delete", id: "nope" }] }, {});
    expect(result.ok).toBe(false);
    expect(result.content).toContain("参数结构不符合编辑算子协议");
    expect(result.content).toContain("重新调用 edit_blocks");
  });
});
