// src/host/font.mjs — shared embedded monospace font registration.
//
// The bookmarklet runs on a third-party HTTPS page, so external font URLs are
// brittle: host CSP may block them and offline/local mirrors cannot fetch them.
// Keep the font as a data module and register it through FontFace. Host-page
// CSS, xterm canvas options, Ace, and the Shadow DOM panel all use this same
// family name so glyph metrics stay consistent.

import { FONT_FAMILY, FONT_FACE_NAME, FONT_WOFF2_B64 } from "./termFont.mjs";

export { FONT_FAMILY, FONT_FACE_NAME, FONT_WOFF2_B64 };

export const FONT_SIZE = 14;

/** Idempotently register the embedded font in a document. */
export function ensureEmbeddedFont(doc = globalThis.document) {
  try {
    if (!doc) return null;
    if (doc.__m3eFontLoading) return doc.__m3eFontLoading;
    if (doc.__m3eFontFace && doc.__m3eFontFace.status === "loaded") {
      doc.__m3eFontLoading = Promise.resolve(doc.__m3eFontFace);
      return doc.__m3eFontLoading;
    }
    if (typeof FontFace === "function" && doc.fonts && typeof doc.fonts.add === "function" && !doc.__m3eFontFace) {
      const ff = new FontFace(
        FONT_FACE_NAME,
        "url(data:font/woff2;base64," + FONT_WOFF2_B64 + ") format('woff2')",
        { style: "normal", weight: "400", display: "block" },
      );
      doc.fonts.add(ff);
      doc.__m3eFontFace = ff;
    }
    if (doc.__m3eFontFace && typeof doc.__m3eFontFace.load === "function") {
      doc.__m3eFontLoading = doc.__m3eFontFace.load();
      try { doc.__m3eFontLoading.catch(() => {}); } catch {}
      return doc.__m3eFontLoading;
    }
    if (doc.fonts?.ready && typeof doc.fonts.ready.then === "function") return doc.fonts.ready;
  } catch {}
  return null;
}
