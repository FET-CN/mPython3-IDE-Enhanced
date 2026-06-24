// src/ctx/cards.mjs — Render a typed SchemaEntry as a compact "block card" for
// the LLM. Each card teaches one block of the language: type, semantics (zh),
// shape (value/statement/event), and how to fill its slots.

const IO_LABEL = {
  value: (s) => `值积木:${s.output || "ANY"}`,
  hat: () => "事件积木(只能放栈顶)",
  statement: () => "语句积木",
  other: () => "表达式/特殊",
};

function ioKind(s) {
  if (s.output != null) return "value";
  if (!s.prev) return "hat"; // no upward connection → top-level (event/start)
  return "statement";
}

function fieldStr(f, maxEnum = 10) {
  if (f.kind === "field_dropdown") {
    if (f.enum) {
      // Show 标签(值) so the model understands opaque values (e.g. the pen-color
      // dropdown 绘制(1)|擦除(0)); fall back to bare value when no label resolved.
      const parts = f.enum
        .slice(0, maxEnum)
        .map((e) => (e.label ? `${e.label}(${e.value})` : e.value));
      return `${f.name}=${parts.join("|")}${f.enum.length > maxEnum ? "|…" : ""}`;
    }
    return `${f.name}=<下拉,值动态>`;
  }
  if (f.kind === "field_number") return `${f.name}=<数字>`;
  if (f.kind === "field_input") return `${f.name}=<文本>`;
  if (f.kind === "field_variable") return `${f.name}=<变量名>`;
  if (f.kind === "field_colour") return `${f.name}=<#RRGGBB>`;
  return `${f.name}=<值>`;
}

/** Render one schema as a 1–3 line card. */
export function renderCard(schema) {
  const io = ioKind(schema);
  const head = `${schema.type} | ${schema.zh || "(无描述)"} | ${IO_LABEL[io](schema)}`;
  const lines = [head];
  if (schema.fields?.length) {
    lines.push("  字段: " + schema.fields.map((f) => fieldStr(f)).join(", "));
  }
  if (schema.values?.length) {
    lines.push("  值插槽: " + schema.values.map((v) => `${v.name}:${v.check}`).join(", "));
  }
  if (schema.statements?.length) {
    lines.push("  语句体: " + schema.statements.join(", "));
  }
  return lines.join("\n");
}

/** Render a titled section of cards for a list of schemas. */
export function renderCardSection(title, schemas) {
  if (!schemas.length) return "";
  return `## ${title}\n` + schemas.map(renderCard).join("\n");
}
