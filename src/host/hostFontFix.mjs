// src/host/hostFontFix.mjs — apply the embedded monospace font to host IDE UI.
//
// Scope: host-page UI only. The Shadow DOM chat panel has its own compiled CSS,
// while xterm-specific canvas metrics stay in termFix.mjs.

import { ensureEmbeddedFont, FONT_FAMILY } from "./font.mjs";

const STYLE_ID = "m3e-host-mono-font";

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
.aicg .dialog pre,
.aicg .dialog code,
.aicg .markdown pre,
.aicg .markdown code,
.aicg .markdown .hljs,
.aicg .message textarea,
.mainMad.aicg .dialog pre,
.mainMad.aicg .dialog code,
.mainMad.aicg .markdown pre,
.mainMad.aicg .markdown code,
.mainMad.aicg .markdown .hljs,
.mainMad.aicg .message textarea,
.ace_editor,
.ace_editor *,
.ace_content,
.ace_content *,
.ace_text-layer,
.ace_text-layer *,
.ace_gutter,
.ace_gutter *,
.ace_cursor,
.ace_marker-layer,
.ace_marker-layer *,
.ace_hidden-cursors,
.ace_text-input,
.ace_textarea,
.ace_textarea *,
.ace_tooltip,
.ace_search,
.ace_search * {
  font-family: ${FONT_FAMILY} !important;
  font-variant-ligatures: none !important;
  font-feature-settings: "liga" 0, "calt" 0 !important;
  letter-spacing: 0 !important;
}
.ace_editor .m3e-ace-bracket {
  position: absolute !important;
  box-sizing: border-box !important;
  border: 1px solid rgb(192, 192, 192) !important;
  background: transparent !important;
  pointer-events: none !important;
}
.ace_editor .ace_cursor {
  border-left-color: rgb(228, 228, 231) !important;
  opacity: 0.9 !important;
}
.aicg .message textarea,
.mainMad.aicg .message textarea {
  white-space: pre-wrap !important;
}
`;
  (doc.head || doc.documentElement).appendChild(st);
}

function eachAceEditor(doc, cb) {
  const ace = globalThis.ace;
  if (!ace || typeof ace.edit !== "function") return;
  const seen = new Set();
  const add = (ed) => {
    if (!ed || seen.has(ed)) return;
    seen.add(ed);
    cb(ed);
  };

  try { add(globalThis.vm?.$store?.state?.Editor); } catch {}

  try {
    for (const el of doc.querySelectorAll(".ace_editor[id]")) {
      try { add(ace.edit(el.id)); } catch {}
    }
  } catch {}
}

function forceAceDomFont(doc) {
  try {
    for (const el of doc.querySelectorAll(".ace_editor, .ace_editor *")) {
      el.style.setProperty("font-family", FONT_FAMILY, "important");
      el.style.setProperty("font-variant-ligatures", "none", "important");
      el.style.setProperty("font-feature-settings", "\"liga\" 0, \"calt\" 0", "important");
      el.style.setProperty("letter-spacing", "0", "important");
    }
  } catch {}
}

const OPEN = "([{";
const CLOSE = ")]}";
const MATCH = { "(": ")", "[": "]", "{": "}", ")": "(", "]": "[", "}": "{" };

function rangeFromMarkers(session) {
  try {
    const pools = [session?.getMarkers?.(true), session?.getMarkers?.(false)];
    for (const markers of pools) {
      for (const m of Object.values(markers || {})) {
        const Range = m?.range?.constructor;
        if (typeof Range === "function" && typeof m.range.clipRows === "function") return Range;
      }
    }
  } catch {}
  return null;
}

function getAceRange(session) {
  try {
    const Range = globalThis.ace?.require?.("ace/range")?.Range;
    if (typeof Range === "function") return Range;
  } catch {}
  return rangeFromMarkers(session);
}

function charAt(session, pos) {
  try { return session.getLine(pos.row).charAt(pos.column); } catch { return ""; }
}

function findBracketNearCursor(session, cursor) {
  const line = (() => { try { return session.getLine(cursor.row); } catch { return ""; } })();
  const before = cursor.column > 0 ? line.charAt(cursor.column - 1) : "";
  const after = line.charAt(cursor.column);
  if (MATCH[before]) return { row: cursor.row, column: cursor.column - 1, ch: before };
  if (MATCH[after]) return { row: cursor.row, column: cursor.column, ch: after };
  return null;
}

function findMatchingBracketFallback(session, at) {
  const target = MATCH[at.ch];
  if (!target) return null;
  const forward = OPEN.includes(at.ch);
  const open = forward ? at.ch : target;
  const close = forward ? target : at.ch;
  let depth = 0;
  const rowCount = (() => {
    try { return session.getLength(); } catch { return at.row + 1; }
  })();

  if (forward) {
    for (let row = at.row; row < rowCount; row++) {
      const line = (() => { try { return session.getLine(row); } catch { return ""; } })();
      let col = row === at.row ? at.column + 1 : 0;
      for (; col < line.length; col++) {
        const ch = line.charAt(col);
        if (ch === open) depth++;
        else if (ch === close) {
          if (depth === 0) return { row, column: col };
          depth--;
        }
      }
    }
    return null;
  }

  for (let row = at.row; row >= 0; row--) {
    const line = (() => { try { return session.getLine(row); } catch { return ""; } })();
    let col = row === at.row ? at.column - 1 : line.length - 1;
    for (; col >= 0; col--) {
      const ch = line.charAt(col);
      if (ch === close) depth++;
      else if (ch === open) {
        if (depth === 0) return { row, column: col };
        depth--;
      }
    }
  }
  return null;
}

function findMatchingBracket(session, at) {
  try {
    const m = session.findMatchingBracket?.({ row: at.row, column: at.column + 1 });
    if (m && charAt(session, m) === MATCH[at.ch]) return m;
  } catch {}
  try {
    const m = session.findMatchingBracket?.({ row: at.row, column: at.column });
    if (m && charAt(session, m) === MATCH[at.ch]) return m;
  } catch {}
  return findMatchingBracketFallback(session, at);
}

function hasNativeBracketMarker(session, pos) {
  try {
    const pools = [session?.getMarkers?.(true), session?.getMarkers?.(false)];
    for (const markers of pools) {
      for (const m of Object.values(markers || {})) {
        if (!String(m?.clazz || "").split(/\s+/).includes("ace_bracket")) continue;
        if (m.range?.start?.row === pos.row && m.range.start.column === pos.column) return true;
      }
    }
  } catch {}
  return false;
}

function installTwinBracketHighlight(ed) {
  if (!ed || ed.__m3eTwinBracketHighlight) return;
  const state = { session: null, markerIds: [], timer: null };
  ed.__m3eTwinBracketHighlight = state;

  function clearMarkers() {
    const session = state.session;
    if (session && typeof session.removeMarker === "function") {
      for (const id of state.markerIds) {
        try { session.removeMarker(id); } catch {}
      }
    }
    state.markerIds = [];
  }

  function mark(session, pos) {
    if (!pos || typeof session.addMarker !== "function") return;
    if (hasNativeBracketMarker(session, pos)) return;
    try {
      const Range = getAceRange(session);
      if (!Range) return;
      const range = new Range(pos.row, pos.column, pos.row, pos.column + 1);
      state.markerIds.push(session.addMarker(range, "m3e-ace-bracket", "text", true));
    } catch {}
  }

  function update() {
    state.timer = null;
    const session = ed.session || ed.getSession?.();
    if (state.session !== session) {
      clearMarkers();
      state.session = session;
    } else {
      clearMarkers();
    }
    if (!session) return;
    const cursor = (() => { try { return ed.getCursorPosition(); } catch { return null; } })();
    if (!cursor) return;
    const current = findBracketNearCursor(session, cursor);
    if (!current) return;
    const matching = findMatchingBracket(session, current);
    if (!matching) return;
    mark(session, current);
    mark(session, matching);
  }

  function schedule() {
    if (state.timer) return;
    state.timer = setTimeout(update, 0);
  }

  try { ed.selection?.on?.("changeCursor", schedule); } catch {}
  try { ed.on?.("changeSelection", schedule); } catch {}
  try { ed.on?.("change", schedule); } catch {}
  try { ed.on?.("changeSession", schedule); } catch {}
  update();
}

function refreshAceEditor(ed) {
  try { ed.setOptions({ fontFamily: FONT_FAMILY }); } catch {}
  try { ed.container?.style?.setProperty("font-family", FONT_FAMILY, "important"); } catch {}
  try { ed.textInput?.getElement?.()?.style?.setProperty("font-family", FONT_FAMILY, "important"); } catch {}
  try { ed.renderer?.setStyle?.("m3e-mono"); } catch {}
  try { ed.renderer?.$fontMetrics?.checkForSizeChanges?.(); } catch {}
  try { ed.renderer?.$fontMetrics?.setPolling?.(true); } catch {}
  try { ed.renderer?.updateFontSize?.(); } catch {}
  try { ed.renderer?.onResize?.(true); } catch {}
  try { ed.renderer?.updateFull?.(); } catch {}
  try { ed.resize?.(true); } catch {}
  try { installTwinBracketHighlight(ed); } catch {}
}

function applyAceFont(doc) {
  forceAceDomFont(doc);
  eachAceEditor(doc, (ed) => {
    refreshAceEditor(ed);
  });
}

function afterAcePaint(doc, win = globalThis.window) {
  applyAceFont(doc);
  try { win?.requestAnimationFrame?.(() => applyAceFont(doc)); } catch {}
  try { setTimeout(() => applyAceFont(doc), 0); } catch {}
  try { setTimeout(() => applyAceFont(doc), 120); } catch {}
}

/**
 * Install host-page monospace styling for the original IDE's Agent dialog and
 * Ace editors. It is intentionally selector/instance based, so it survives the
 * minified Vue build and avoids patching reverse-engineered bundles.
 * @param {object} caps detectHost() result
 * @returns {{ heal():void, stop():void }}
 */
export function installHostFontFix(caps = {}) {
  const doc = caps.doc || globalThis.document;
  const win = caps.win || doc?.defaultView || globalThis.window;
  if (!doc) return { heal() {}, stop() {} };

  function heal() {
    try {
      ensureEmbeddedFont(doc);
      ensureStyle(doc);
      afterAcePaint(doc, win);
    } catch {}
  }

  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; heal(); }, 200);
  };

  heal();
  try { ensureEmbeddedFont(doc)?.then(() => afterAcePaint(doc, win), () => {}); } catch {}
  try { doc.fonts?.ready?.then?.(() => afterAcePaint(doc, win), () => {}); } catch {}

  let observer = null;
  try {
    observer = new MutationObserver(schedule);
    observer.observe(doc.body, { childList: true, subtree: true });
  } catch {}

  return {
    heal,
    stop() {
      try { observer?.disconnect(); } catch {}
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
