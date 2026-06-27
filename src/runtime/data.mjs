// src/runtime/data.mjs — Load build artifacts (catalog + knowledge + seeds) from
// the hosting base URL at runtime, with caching. Base URL is set by the loader
// as window.__M3E_BASE__ (or derived from the executing <script> src).

import { catalogFromArray } from "../xml/validate.mjs";

export function baseUrl(win = globalThis.window) {
  return (win.__M3E_BASE__ || "").replace(/\/+$/, "");
}

async function getJSON(base, path) {
  const res = await fetch(`${base}/${path}`, { cache: "no-store", mode: "cors" });
  if (!res.ok) throw new Error(`加载 ${path} 失败: HTTP ${res.status}`);
  return res.json();
}
async function getText(base, path) {
  const res = await fetch(`${base}/${path}`, { cache: "no-store", mode: "cors" });
  if (!res.ok) return "";
  return res.text();
}

/** Load everything the pipeline needs. Returns { index, catalog, seeds, knowledge, visible }. */
export async function loadData(win = globalThis.window) {
  const base = baseUrl(win);
  if (!base) throw new Error("m3e: 未设置数据基址 (window.__M3E_BASE__)");
  const [index, full, seedsWrap, core, antipatterns, triggers, visibleRaw] = await Promise.all([
    getJSON(base, "catalog.index.json"),
    getJSON(base, "catalog.full.json"),
    getJSON(base, "fewshot-seeds.json").catch(() => ({ seeds: [] })),
    getJSON(base, "knowledge/core.json"),
    getJSON(base, "knowledge/antipatterns.json"),
    getJSON(base, "knowledge/triggers.json"),
    // Per-board side-palette visibility snapshot — optional; degrade gracefully.
    getJSON(base, "toolbox.visible.json").catch(() => null),
  ]);
  const docCache = new Map();
  const knowledge = {
    core, antipatterns, triggers,
    loadDoc: async (name) => {
      if (docCache.has(name)) return docCache.get(name);
      const t = await getText(base, `knowledge/${name}`);
      docCache.set(name, t);
      return t;
    },
  };
  return {
    index,
    catalog: catalogFromArray(full),
    seeds: seedsWrap.seeds || [],
    knowledge,
    visible: makeVisible(visibleRaw),
  };
}

/**
 * Wrap the toolbox.visible.json payload into { has, forBoard(board) → Set|null }.
 * forBoard returns null when no snapshot is available, so callers treat "unknown"
 * as "no visibility filtering" rather than "nothing is visible".
 */
export function makeVisible(raw) {
  const byBoard = raw?.byBoard || {};
  const categories = raw?.categories || {};
  const sets = new Map();
  for (const [b, entry] of Object.entries(byBoard)) {
    const list = Array.isArray(entry) ? entry : entry?.types;
    if (Array.isArray(list)) sets.set(b, new Set(list));
  }
  return {
    has: sets.size > 0,
    meta: raw ? { source: raw.source, capturedAt: raw.capturedAt, schema: raw.schema || 1 } : null,
    forBoard: (board) => sets.get(board) || null,
    categoriesForBoard: (board) => categories?.[board] || byBoard?.[board]?.categories || null,
  };
}

/** LLM + UI config persisted in localStorage under m3e_*. */
export const cfg = {
  get(k, d = "") { return globalThis.localStorage.getItem("m3e_" + k) ?? d; },
  set(k, v) { globalThis.localStorage.setItem("m3e_" + k, v); },
  llm() {
    return {
      baseURL: this.get("baseURL", "https://api.deepseek.com/v1"),
      apiKey: this.get("apiKey", ""),
      model: this.get("model", "deepseek-chat"),
    };
  },
};
