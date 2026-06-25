// src/kb/retriever.mjs — Stage A of "vocabulary loading": local keyword scoring
// over catalog.index.json to shortlist relevant blocks + groups for a Chinese
// request. Stage B (LLM group-select) is layered on top in the pipeline.

/** Generate char n-grams (2..3) from a Chinese/mixed string. */
function ngrams(s, min = 2, max = 3) {
  const out = new Set();
  const clean = s.replace(/\s+/g, "");
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= clean.length; i++) out.add(clean.slice(i, i + n));
  }
  return out;
}

/** Latin word tokens (lowercased) from a string. */
function latinTokens(s) {
  return (s.toLowerCase().match(/[a-z][a-z0-9_]+/g) || []).filter((t) => t.length > 1);
}

/**
 * Score one index entry against the request's ngram set + latin tokens.
 * zh substring (ngram) hits weigh most; kw/type latin hits add signal.
 */
function scoreEntry(entry, reqNgrams, reqLatin) {
  let score = 0;
  const zh = entry.zh || "";
  for (const g of reqNgrams) {
    if (g.length >= 2 && zh.includes(g)) score += g.length; // longer match = stronger
  }
  const kw = entry.kw || [];
  for (const t of reqLatin) {
    if (kw.includes(t)) score += 3;
    else if (kw.some((k) => k.includes(t) || t.includes(k))) score += 1;
  }
  return score;
}

/** Whether a block's board-code `bd` is usable on the current masterControl. */
export function boardAllows(bd, board) {
  if (!board) return true; // unknown board → no filtering
  if (bd === "u" || bd == null) return true; // universal / built-in
  if (board === "mPython") return bd.includes("2");
  if (board === "mPython_V3") return bd.includes("3");
  return true;
}

/**
 * @param request user's Chinese request string
 * @param index   parsed catalog.index.json (array)
 * @param opts { topN=80, board?, groups?, preferGroups? }
 * @returns { types, groups, scored }
 */
export function retrieve(request, index, opts = {}) {
  const topN = opts.topN ?? 80;
  const reqNgrams = ngrams(request);
  const reqLatin = latinTokens(request);
  const restrict = opts.groups ? new Set(opts.groups) : null;
  const prefer = opts.preferGroups ? new Set(opts.preferGroups) : null;
  const board = opts.board || null;

  const scored = [];
  for (const e of index) {
    if (board && !boardAllows(e.bd, board)) continue;
    if (restrict && !restrict.has(e.group)) continue;
    let s = scoreEntry(e, reqNgrams, reqLatin);
    if (s <= 0) continue;
    if (prefer && prefer.has(e.group)) s += 3;
    scored.push({ type: e.type, score: s, group: e.group });
  }
  scored.sort((a, b) => b.score - a.score || a.type.length - b.type.length);
  const top = scored.slice(0, topN);
  const groups = [...new Set(top.map((t) => t.group))];
  return { types: top.map((t) => t.type), groups, scored: top };
}

/** Distinct groups present in the index, with counts + a sample zh per group. */
export function groupCatalog(index) {
  const m = new Map();
  for (const e of index) {
    if (!m.has(e.group)) m.set(e.group, { group: e.group, count: 0, sampleZh: [] });
    const g = m.get(e.group);
    g.count++;
    if (g.sampleZh.length < 3 && e.zh) g.sampleZh.push(e.zh);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/**
 * Priority spine of the core vocabulary. These must survive the core-card cap
 * (assemble.mjs slices coreTypes to ~60) because they are the primitives almost
 * every program needs — control flow, math/logic/variables, and the v2 OLED
 * drawing stack. Without this, alphabetical/index ordering can push
 * mpython_display_* past the cap and the model never sees their real fields.
 */
const CORE_PRIORITY = [
  // control flow
  "controls_if", "controls_for", "controls_whileUntil", "controls_repeat_ext",
  "controls_flow_statements",
  // logic
  "logic_compare", "logic_operation", "logic_boolean", "logic_negate",
  // math
  "math_number", "math_arithmetic", "math_single", "math_trig", "math_modulo",
  "math_round", "math_random_int", "math_constrain", "math_map",
  // text + variables
  "text", "text_join", "text_print",
  "variables_set", "variables_get", "math_change",
  // mpython timing / actuators / inputs
  "mpython_sleep_ms", "mpython_set_RGB", "mpython_rgb_set", "mpython_rgb_clear",
  "mpython_Interrupt_AB", "mpython_button_is_pressed", "mpython_button_both_pressed",
  // v2 OLED drawing stack (the subject of most display requests)
  "mpython_display_fill", "mpython_display_Show", "mpython_display_DispChar",
  "mpython_display_DispChar_5lines", "mpython_display_circle",
  "mpython_display_fill_circle", "mpython_display_line", "mpython_display_pixel",
  "mpython_display_fill_rect", "mpython_display_RoundRect",
];
const PRIORITY_RANK = new Map(CORE_PRIORITY.map((t, i) => [t, i]));

/** Always-on core vocabulary types (L2), board-filtered, priority-ordered. */
export function coreTypes(index, board = null) {
  const types = index.filter((e) => e.core && boardAllows(e.bd, board)).map((e) => e.type);
  return types.sort((a, b) => {
    const ra = PRIORITY_RANK.has(a) ? PRIORITY_RANK.get(a) : Infinity;
    const rb = PRIORITY_RANK.has(b) ? PRIORITY_RANK.get(b) : Infinity;
    return ra - rb; // ranked spine first, then original (stable) order
  });
}

// Block "generations": the IDE's current side palette is the newer mpython3_*
// family (event hats 「当…时」, threads, custom events, modern IoT receivers).
// We surface these to the model always (preferredTypes) and boost them in
// retrieval (retrieve's preferGroups), so it picks the current blocks the user
// can actually drag, instead of the legacy mpython_* polling style.
export const PREFERRED_GROUPS = ["mpython3"];

/**
 * Always-on "new generation" vocabulary (mpython3_*), board-filtered. Excludes
 * the labplus/1956-board variants (not 掌控板). Use to render a stable, cacheable
 * "优先使用" card section in the system prompt.
 */
export function preferredTypes(index, board = null) {
  return index
    .filter(
      (e) =>
        PREFERRED_GROUPS.includes(e.group) &&
        boardAllows(e.bd, board) &&
        !/1956|labplus/.test(e.type),
    )
    .map((e) => e.type);
}
