// src/kb/knowledge.mjs — On-demand (L4) board-knowledge selection. Picks which
// version/module docs to inject based on trigger keywords in the request.
// `loadDoc(name)` is injected (browser: fetch; Node: fs) and returns markdown text.

const DISPLAY_HINTS = ["显示", "屏", "oled", "lcd", "坐标", "字", "图", "像素", "界面"];

/**
 * @param request user's Chinese request
 * @param version 'v2'|'v3'|'unknown'
 * @param deps { triggers (triggers.json), loadDoc(name)->Promise<string>|string, maxModules=2, includeVersionDoc=true }
 * @returns Promise<[{title, text}]>
 */
export async function selectBoardDocs(request, version, deps) {
  const { triggers, loadDoc, maxModules = 2, includeVersionDoc = true } = deps;
  const req = request.toLowerCase();
  const out = [];

  // module docs whose triggers fire
  const mods = triggers?.modules || {};
  const hits = [];
  for (const [doc, kws] of Object.entries(mods)) {
    const n = kws.filter((k) => req.includes(k.toLowerCase())).length;
    if (n > 0) hits.push([doc, n]);
  }
  hits.sort((a, b) => b[1] - a[1]);
  for (const [doc] of hits.slice(0, maxModules)) {
    const text = await loadDoc(`modules/${doc}`);
    if (text) out.push({ title: doc.replace(/\.md$/, ""), text: clip(text) });
  }

  // version display doc only when the task is display/geometry-ish
  if (
    includeVersionDoc &&
    (version === "v2" || version === "v3") &&
    DISPLAY_HINTS.some((h) => req.includes(h))
  ) {
    const text = await loadDoc(`${version}.md`);
    if (text) out.push({ title: `${version} 板子参考`, text: clip(text, 6000) });
  }
  return out;
}

function clip(s, max = 3500) {
  return s.length > max ? s.slice(0, max) + "\n…(已截断)" : s;
}

/** Resolve the board from masterControl. Only the two 掌控板 boards are supported.
 *  Empty/unset defaults to 掌控板 (mPython) — the app's own default master. */
export function boardFromMaster(master) {
  if (!master || master === "mPython") return { master: "mPython", board: "mPython", version: "v2", supported: true, label: "掌控板" };
  if (master === "mPython_V3") return { master, board: "mPython_V3", version: "v3", supported: true, label: "掌控板V3" };
  return { master, board: null, version: "unknown", supported: false, label: master };
}

/** Resolve the board version from explicit hint, request text, or stored master. */
export function resolveVersion({ request = "", master = "", triggers }) {
  const hay = `${request} ${master}`.toLowerCase();
  const v = triggers?.version || {};
  const v3 = (v.v3 || []).some((k) => hay.includes(k.toLowerCase()));
  const v2 = (v.v2 || []).some((k) => hay.includes(k.toLowerCase()));
  if (v3 && !v2) return "v3";
  if (v2 && !v3) return "v2";
  if (/v3|esp32-?s3|_v3/.test(hay)) return "v3";
  if (/\bv2\b/.test(hay)) return "v2";
  return "unknown";
}
