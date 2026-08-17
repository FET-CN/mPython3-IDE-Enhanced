// src/agent/tools/editBlocksSchema.mjs — Provider-facing Wire DTO for
// edit_blocks. The internal IR deliberately keeps dynamic maps; this closed
// transport shape makes strict JSON-schema tool calls possible.

export const EDIT_BLOCKS_SCHEMA_VERSION = 2;

const ref = (name) => ({ $ref: `#/$defs/${name}` });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const closedObject = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const anchor = closedObject({
  at: { type: "string", enum: ["new", "after", "body"] },
  id: nullable({ type: "string" }),
  input: nullable({ type: "string" }),
  index: nullable({ type: "integer" }),
});

const field = closedObject({ name: { type: "string" }, value: { type: "string" } });

const input = closedObject({
  name: { type: "string" },
  kind: { type: "string", enum: ["expr", "block"] },
  expression: nullable({ type: "string" }),
  block: nullable(ref("node")),
});

const statement = closedObject({
  name: { type: "string" },
  blocks: { type: "array", items: ref("node") },
});

const node = closedObject({
  type: { type: "string" },
  fields: { type: "array", items: field },
  inputs: { type: "array", items: input },
  statements: { type: "array", items: statement },
});

const OP_NAMES = ["clear", "insert", "delete", "move", "setField"];
const OP_NAMES_TEXT = `${OP_NAMES.slice(0, -1).join("、")} 或 ${OP_NAMES.at(-1)}`;
const op = closedObject({
  op: { type: "string", enum: OP_NAMES },
  id: nullable({ type: "string" }),
  name: nullable({ type: "string" }),
  value: nullable({ type: "string" }),
  anchor: nullable(ref("anchor")),
  blocks: { type: "array", items: ref("node") },
});

export const EDIT_BLOCKS_PARAMETERS = {
  type: "object",
  properties: {
    ops: { type: "array", description: "按顺序执行的编辑算子。", items: op },
  },
  required: ["ops"],
  additionalProperties: false,
  $defs: { anchor, node },
};

export const EDIT_BLOCKS_FALLBACK_PARAMETERS = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      description: "编辑算子数组；结构由客户端在执行前继续校验。",
      items: { type: "object" },
    },
  },
  required: ["ops"],
};

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value) => typeof value === "string" && /^b[1-9][0-9]*$/.test(value);
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

function exactKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} 是未定义的参数`);
  }
}

function recordName(name, names, path, errors) {
  if (!isNonEmptyString(name)) return;
  if (names.has(name)) errors.push(`${path} 中的 ${name} 重复`);
  names.add(name);
}

function decodeAnchor(value, path, errors) {
  if (!isObject(value)) { errors.push(`${path} 必须是锚点对象`); return null; }
  exactKeys(value, Object.keys(anchor.properties), path, errors);
  if (value.at === "new") {
    if (value.id !== null || value.input !== null || value.index !== null) errors.push(`${path}.new 锚点的其余字段必须为 null`);
    return { at: "new" };
  }
  if (value.at === "after") {
    if (!isId(value.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    if (value.input !== null || value.index !== null) errors.push(`${path}.after 锚点的 input 和 index 必须为 null`);
    return { at: "after", id: value.id };
  }
  if (value.at === "body") {
    if (!isId(value.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    if (!isNonEmptyString(value.input)) errors.push(`${path}.input 必须是非空字符串`);
    if (value.index !== null && (!Number.isSafeInteger(value.index) || value.index < 0)) errors.push(`${path}.index 必须是非负整数或 null`);
    return value.index === null
      ? { at: "body", id: value.id, input: value.input }
      : { at: "body", id: value.id, input: value.input, index: value.index };
  }
  errors.push(`${path}.at 必须是 new、after 或 body`);
  return null;
}

function decodeNode(value, path, errors) {
  if (!isObject(value)) { errors.push(`${path} 必须是积木节点对象`); return null; }
  exactKeys(value, Object.keys(node.properties), path, errors);
  if (!isNonEmptyString(value.type)) errors.push(`${path}.type 必须是非空字符串`);
  const out = { type: value.type };

  if (!Array.isArray(value.fields)) errors.push(`${path}.fields 必须是数组`);
  else {
    const fields = {};
    const names = new Set();
    value.fields.forEach((entry, index) => {
      const itemPath = `${path}.fields[${index}]`;
      if (!isObject(entry)) { errors.push(`${itemPath} 必须是字段对象`); return; }
      exactKeys(entry, Object.keys(field.properties), itemPath, errors);
      recordName(entry.name, names, `${path}.fields`, errors);
      if (!isNonEmptyString(entry.name)) errors.push(`${itemPath}.name 必须是非空字符串`);
      if (typeof entry.value !== "string") errors.push(`${itemPath}.value 必须是字符串`);
      if (isNonEmptyString(entry.name) && typeof entry.value === "string") fields[entry.name] = entry.value;
    });
    if (value.fields.length) out.fields = fields;
  }

  if (!Array.isArray(value.inputs)) errors.push(`${path}.inputs 必须是数组`);
  else {
    const inputs = {};
    const names = new Set();
    value.inputs.forEach((entry, index) => {
      const itemPath = `${path}.inputs[${index}]`;
      if (!isObject(entry)) { errors.push(`${itemPath} 必须是输入对象`); return; }
      exactKeys(entry, Object.keys(input.properties), itemPath, errors);
      recordName(entry.name, names, `${path}.inputs`, errors);
      if (!isNonEmptyString(entry.name)) errors.push(`${itemPath}.name 必须是非空字符串`);
      if (entry.kind === "expr") {
        if (!isNonEmptyString(entry.expression) || entry.block !== null) errors.push(`${itemPath} 的 expr 输入必须带 expression 且 block 为 null`);
        else if (isNonEmptyString(entry.name)) inputs[entry.name] = entry.expression;
      } else if (entry.kind === "block") {
        if (entry.expression !== null || !isObject(entry.block)) errors.push(`${itemPath} 的 block 输入必须带 block 且 expression 为 null`);
        else {
          const block = decodeNode(entry.block, `${itemPath}.block`, errors);
          if (block && isNonEmptyString(entry.name)) inputs[entry.name] = block;
        }
      } else errors.push(`${itemPath}.kind 必须是 expr 或 block`);
    });
    if (value.inputs.length) out.inputs = inputs;
  }

  if (!Array.isArray(value.statements)) errors.push(`${path}.statements 必须是数组`);
  else {
    const statements = {};
    const names = new Set();
    value.statements.forEach((entry, index) => {
      const itemPath = `${path}.statements[${index}]`;
      if (!isObject(entry)) { errors.push(`${itemPath} 必须是语句对象`); return; }
      exactKeys(entry, Object.keys(statement.properties), itemPath, errors);
      recordName(entry.name, names, `${path}.statements`, errors);
      if (!isNonEmptyString(entry.name)) errors.push(`${itemPath}.name 必须是非空字符串`);
      if (!Array.isArray(entry.blocks)) { errors.push(`${itemPath}.blocks 必须是积木数组`); return; }
      const blocks = entry.blocks.map((block, blockIndex) => decodeNode(block, `${itemPath}.blocks[${blockIndex}]`, errors)).filter(Boolean);
      if (isNonEmptyString(entry.name)) statements[entry.name] = blocks;
    });
    if (value.statements.length) out.statements = statements;
  }
  return out;
}

function isWireOp(value) {
  return isObject(value) && op.required.every((key) => own(value, key));
}

function decodeWireOp(value, path, errors) {
  if (!isObject(value)) { errors.push(`${path} 必须是算子对象`); return null; }
  exactKeys(value, Object.keys(op.properties), path, errors);
  const blocksValue = Array.isArray(value.blocks) ? value.blocks : [];
  if (!Array.isArray(value.blocks)) errors.push(`${path}.blocks 必须是积木数组`);
  if (value.op === "clear") {
    if (value.id !== null || value.name !== null || value.value !== null || value.anchor !== null || value.blocks?.length) errors.push(`${path}.clear 的非 op 字段必须为空`);
    return { op: "clear" };
  }
  if (value.op === "insert") {
    const anchor = decodeAnchor(value.anchor, `${path}.anchor`, errors);
    if (value.id !== null || value.name !== null || value.value !== null || !blocksValue.length) errors.push(`${path}.insert 必须只包含 anchor 和非空 blocks`);
    const blocks = blocksValue.map((block, index) => decodeNode(block, `${path}.blocks[${index}]`, errors)).filter(Boolean);
    return { op: "insert", anchor, blocks };
  }
  if (value.op === "delete") {
    if (!isId(value.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    if (value.name !== null || value.value !== null || value.anchor !== null || value.blocks?.length) errors.push(`${path}.delete 的其余字段必须为空`);
    return { op: "delete", id: value.id };
  }
  if (value.op === "move") {
    const anchor = decodeAnchor(value.anchor, `${path}.anchor`, errors);
    if (!isId(value.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    if (value.name !== null || value.value !== null || value.blocks?.length) errors.push(`${path}.move 的 name、value 和 blocks 必须为空`);
    return { op: "move", id: value.id, anchor };
  }
  if (value.op === "setField") {
    if (!isId(value.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    if (!isNonEmptyString(value.name) || typeof value.value !== "string") errors.push(`${path}.setField 必须带 name 和 value`);
    if (value.anchor !== null || value.blocks?.length) errors.push(`${path}.setField 的 anchor 和 blocks 必须为空`);
    return { op: "setField", id: value.id, name: value.name, value: value.value };
  }
  errors.push(`${path}.op 必须是 ${OP_NAMES_TEXT}`);
  return null;
}

function validateLegacyNode(node, path, errors) {
  if (!isObject(node)) { errors.push(`${path} 必须是积木节点对象`); return; }
  exactKeys(node, ["type", "fields", "inputs", "statements"], path, errors);
  if (!isNonEmptyString(node.type)) errors.push(`${path}.type 必须是非空字符串`);
  if (own(node, "fields")) {
    if (!isObject(node.fields)) errors.push(`${path}.fields 必须是对象`);
    else for (const [name, value] of Object.entries(node.fields)) if (typeof value !== "string") errors.push(`${path}.fields.${name} 必须是字符串`);
  }
  if (own(node, "inputs")) {
    if (!isObject(node.inputs)) errors.push(`${path}.inputs 必须是对象`);
    else for (const [name, value] of Object.entries(node.inputs)) if (typeof value !== "string") validateLegacyNode(value, `${path}.inputs.${name}`, errors);
  }
  if (own(node, "statements")) {
    if (!isObject(node.statements)) errors.push(`${path}.statements 必须是对象`);
    else for (const [name, blocks] of Object.entries(node.statements)) {
      if (!Array.isArray(blocks)) errors.push(`${path}.statements.${name} 必须是积木数组`);
      else blocks.forEach((block, index) => validateLegacyNode(block, `${path}.statements.${name}[${index}]`, errors));
    }
  }
}

function validateLegacyAnchor(anchor, path, errors) {
  if (!isObject(anchor)) { errors.push(`${path} 必须是锚点对象`); return; }
  if (anchor.at === "new") { exactKeys(anchor, ["at"], path, errors); return; }
  if (anchor.at === "after") {
    exactKeys(anchor, ["at", "id"], path, errors);
    if (!isId(anchor.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    return;
  }
  if (anchor.at === "body") {
    exactKeys(anchor, ["at", "id", "input", "index"], path, errors);
    if (!isId(anchor.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    if (!isNonEmptyString(anchor.input)) errors.push(`${path}.input 必须是非空字符串`);
    if (own(anchor, "index") && (!Number.isSafeInteger(anchor.index) || anchor.index < 0)) errors.push(`${path}.index 必须是非负整数`);
    return;
  }
  errors.push(`${path}.at 必须是 new、after 或 body`);
}

function validateLegacyOp(op, path, errors) {
  if (!isObject(op)) { errors.push(`${path} 必须是算子对象`); return; }
  if (op.op === "clear") { exactKeys(op, ["op"], path, errors); return; }
  if (op.op === "insert") {
    exactKeys(op, ["op", "anchor", "blocks"], path, errors);
    validateLegacyAnchor(op.anchor, `${path}.anchor`, errors);
    if (!Array.isArray(op.blocks) || !op.blocks.length) errors.push(`${path}.blocks 必须是非空积木数组`);
    else op.blocks.forEach((block, index) => validateLegacyNode(block, `${path}.blocks[${index}]`, errors));
    return;
  }
  if (op.op === "delete") {
    exactKeys(op, ["op", "id"], path, errors);
    if (!isId(op.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    return;
  }
  if (op.op === "move") {
    exactKeys(op, ["op", "id", "anchor"], path, errors);
    if (!isId(op.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    validateLegacyAnchor(op.anchor, `${path}.anchor`, errors);
    return;
  }
  if (op.op === "setField") {
    exactKeys(op, ["op", "id", "name", "value"], path, errors);
    if (!isId(op.id)) errors.push(`${path}.id 必须是当前工作区的 bN id`);
    if (!isNonEmptyString(op.name)) errors.push(`${path}.name 必须是非空字符串`);
    if (typeof op.value !== "string") errors.push(`${path}.value 必须是字符串`);
    return;
  }
  errors.push(`${path}.op 必须是 ${OP_NAMES_TEXT}`);
}

export function decodeEditBlocksArgs(args) {
  const errors = [];
  if (!isObject(args)) return { ok: false, errors: ["参数必须是对象"] };
  exactKeys(args, ["ops"], "$", errors);
  const opsValue = Array.isArray(args.ops) ? args.ops : [];
  if (!opsValue.length) errors.push("$.ops 必须是非空数组");
  const ops = opsValue.map((item, index) => {
    const path = `$.ops[${index}]`;
    if (isWireOp(item)) return decodeWireOp(item, path, errors);
    validateLegacyOp(item, path, errors);
    return item;
  }).filter(Boolean);
  return errors.length ? { ok: false, errors } : { ok: true, args: { ops } };
}
