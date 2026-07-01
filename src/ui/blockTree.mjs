// src/ui/blockTree.mjs — Pure, Blockly-free fallback renderer that draws an IR
// program as a tree of nested rounded "block" chips for the edit-preview confirm
// card. The high-fidelity path renders real Blockly SVG (src/host/renderBlocks);
// this is the graceful degradation when that fails — it needs only the IR + the
// catalog (zh labels, field enums, colour family), so it is fully offline and
// unit-testable.
//
// Colour: the catalog stores `colour` as a `ke.*` symbol reference (175 of them),
// not a hex — only the live Blockly theme resolves those. So we map the symbol's
// family keyword to one of a small fixed palette; the class strings are written
// out as literals so Tailwind's build:css scan can see them (dynamic class names
// would be purged).

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Fixed palette → each entry carries the full class string (literal, scannable).
// `chip` styles a statement block; `inline` styles a value block rendered inline.
const PALETTE = {
  amber:   { chip: "border-amber-500/30 bg-amber-500/10 dark:border-amber-400/25 dark:bg-amber-400/10",     inline: "bg-amber-500/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200" },
  blue:    { chip: "border-blue-500/30 bg-blue-500/10 dark:border-blue-400/25 dark:bg-blue-400/10",         inline: "bg-blue-500/15 text-blue-800 dark:bg-blue-400/15 dark:text-blue-200" },
  indigo:  { chip: "border-indigo-500/30 bg-indigo-500/10 dark:border-indigo-400/25 dark:bg-indigo-400/10", inline: "bg-indigo-500/15 text-indigo-800 dark:bg-indigo-400/15 dark:text-indigo-200" },
  teal:    { chip: "border-teal-500/30 bg-teal-500/10 dark:border-teal-400/25 dark:bg-teal-400/10",         inline: "bg-teal-500/15 text-teal-800 dark:bg-teal-400/15 dark:text-teal-200" },
  emerald: { chip: "border-emerald-500/30 bg-emerald-500/10 dark:border-emerald-400/25 dark:bg-emerald-400/10", inline: "bg-emerald-500/15 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-200" },
  cyan:    { chip: "border-cyan-500/30 bg-cyan-500/10 dark:border-cyan-400/25 dark:bg-cyan-400/10",         inline: "bg-cyan-500/15 text-cyan-800 dark:bg-cyan-400/15 dark:text-cyan-200" },
  orange:  { chip: "border-orange-500/30 bg-orange-500/10 dark:border-orange-400/25 dark:bg-orange-400/10", inline: "bg-orange-500/15 text-orange-800 dark:bg-orange-400/15 dark:text-orange-200" },
  zinc:    { chip: "border-zinc-950/15 bg-zinc-950/[.04] dark:border-white/15 dark:bg-white/[.05]",         inline: "bg-zinc-950/8 text-zinc-700 dark:bg-white/10 dark:text-zinc-200" },
};

// Map a catalog colour family (e.g. "ke.Event", "Me", "") to a palette key by
// keyword. Best-effort — the goal is "looks roughly right", not pixel accuracy.
function familyOf(colour) {
  const c = String(colour || "").toLowerCase();
  if (/event|interrupt|radio|wifi|iot|mqtt|conn/.test(c)) return "amber";
  if (/show|display|oled|lcd|rgb|neopixel|led|lvgl|image|camera|music|audio/.test(c)) return "blue";
  if (/math/.test(c)) return "indigo";
  if (/text|string/.test(c)) return "teal";
  if (/logic|control|^me$|loop|event_thread|thread/.test(c)) return "emerald";
  if (/pin|sensor|actuator|servo|motor|handle/.test(c)) return "cyan";
  if (/var|list/.test(c)) return "orange";
  return "zinc";
}
const pal = (colour, palette = PALETTE) => palette[familyOf(colour)] || palette.zinc;

// modern 主题调色板：uidotsh 禁多彩强调 / 禁 indigo，故所有色族折叠到中性 zinc chip，
// 行内值块用**唯一强调蓝**点缀。familyOf(colour) 命中的非 zinc 键都回落到这里的 zinc。
// 类名写成字面量，供 build:css:modern 的 v4 扫描到（动态类会被 purge）。
export const MODERN_PALETTE = {
  zinc: {
    chip: "border-zinc-950/10 bg-zinc-950/[.03] dark:border-white/10 dark:bg-white/[.05]",
    inline: "bg-blue-500/10 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
  },
};

/** Current display value of a field: dropdown → its zh label, else the raw value. */
function fieldDisplay(node, field) {
  const raw = node.fields?.[field.name];
  const val = raw != null ? raw : field.default;
  if (field.kind === "field_dropdown" && Array.isArray(field.enum)) {
    const hit = field.enum.find((e) => String(e.value) === String(val));
    if (hit) return hit.label;
  }
  return val == null || val === "" ? "" : String(val);
}

/** Render a value block (sits in an input slot) as an inline rounded chip. */
function inlineValue(node, catalog, palette) {
  if (!node || !node.type) return "";
  const schema = catalog?.get?.(node.type);
  const label = blockLabel(node, schema, catalog, true, palette) || node.type;
  return `<span class="rounded px-1 py-px ${pal(schema?.colour, palette).inline}">${label}</span>`;
}

/** Build a block's title text: fill the zh template's %1/%2… placeholders, in
 *  order, from the field display values then the inline value blocks. Leftover
 *  placeholders (usually statement slots, drawn separately below) are dropped.
 *  Without a zh template we fall back to the raw type. All text is escaped; only
 *  the inline-value chips inject (already-escaped) markup. */
function blockLabel(node, schema, catalog, inline = false, palette) {
  const tpl = schema?.zh;
  // Ordered slot queue approximating Blockly's args0 order (lossy: catalog keeps
  // fields and values separately, so we concatenate fields then values).
  const slots = [];
  for (const f of schema?.fields || []) {
    const d = fieldDisplay(node, f);
    if (d !== "") slots.push(`<b class="font-medium">${esc(d)}</b>`);
    else slots.push("");
  }
  if (!inline) {
    for (const v of schema?.values || []) {
      const child = node.inputs?.[v.name];
      slots.push(child ? inlineValue(child, catalog, palette) : "");
    }
  } else {
    for (const v of schema?.values || []) {
      const child = node.inputs?.[v.name];
      if (child) slots.push(inlineValue(child, catalog, palette));
    }
  }
  if (!tpl) return esc(node.type);
  let i = 0;
  return esc(tpl).replace(/%\d+/g, () => slots[i++] ?? "").replace(/\s{2,}/g, " ").trim();
}

/** Render one statement block (+ its nested statement bodies) as a chip. */
function blockChip(node, catalog, palette) {
  if (!node || !node.type) return "";
  const schema = catalog?.get?.(node.type);
  const title = blockLabel(node, schema, catalog, false, palette) || esc(node.type);
  let bodies = "";
  for (const [name, seq] of Object.entries(node.statements || {})) {
    if (!Array.isArray(seq) || !seq.length) continue;
    bodies +=
      `<div class="ml-2.5 mt-1 border-l-2 border-zinc-950/10 pl-2 dark:border-white/10">` +
      `<div class="mb-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">${esc(name)}</div>` +
      seq.map((n) => blockChip(n, catalog, palette)).join("") +
      `</div>`;
  }
  return (
    `<div class="rounded-md border px-2 py-1 ${pal(schema?.colour, palette).chip} [&+&]:mt-1">` +
    `<div class="text-[11.5px] leading-snug text-zinc-700 dark:text-zinc-200">${title}</div>` +
    bodies +
    `</div>`
  );
}

/**
 * Render an IR program (one stack, or an array of stacks) as nested block chips.
 * Returns an HTML string for injection into the Shadow-DOM panel. Empty program
 * → a muted "empty workspace" line.
 * @param program IR — Program (Stack[] or a single Stack of nodes)
 * @param catalog Map<type, schema> (see catalogFromArray)
 * @param opts    { palette } — 调色板；缺省用 classic 多彩 PALETTE，modern 传 MODERN_PALETTE。
 */
export function blockTreeHtml(program, catalog, opts = {}) {
  const palette = opts.palette || PALETTE;
  const stacks = Array.isArray(program) && program.every((e) => Array.isArray(e)) ? program : program ? [program] : [];
  const nonEmpty = stacks.filter((s) => Array.isArray(s) && s.length);
  if (!nonEmpty.length) {
    return `<div class="text-[11.5px] text-zinc-400 dark:text-zinc-500">（空工作区）</div>`;
  }
  return nonEmpty
    .map((stack) => `<div class="space-y-1">${stack.map((n) => blockChip(n, catalog, palette)).join("")}</div>`)
    .join(`<div class="my-1.5 h-px bg-zinc-950/10 dark:bg-white/10"></div>`);
}
