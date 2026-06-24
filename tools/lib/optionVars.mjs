// Resolve module-scoped dropdown option variables (e.g. `W_=[["P0","0"],...]`)
// from the main app bundle. ~92 such vars are referenced by `options:VAR` or
// `new FieldDropdown(VAR)` in block definitions but their values live in the
// bundle, not the per-block snippet export.

import { balancedSlice, parseOptionPairs } from "./scan.mjs";

/**
 * Scan bundle text for `IDENT=[[ ... ]]` assignments and return
 * Map<ident, Array<{label,value}>>. Only keeps arrays whose first element is a
 * 2+ element array (i.e. looks like dropdown options), to avoid matching
 * unrelated nested arrays.
 */
export function extractOptionVars(bundleText) {
  const map = new Map();
  // Match `<ident>=[[` where ident is a minified var, not preceded by an
  // identifier char (so we don't match `foo.bar`). Allow $ and _ in idents.
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)=(\[\[)/g;
  let m;
  while ((m = re.exec(bundleText)) !== null) {
    const ident = m[1];
    const arrStart = m.index + m[0].length - 2; // points at first `[`
    const slice = balancedSlice(bundleText, arrStart);
    if (!slice) continue;
    const pairs = parseOptionPairs(slice);
    if (pairs.length === 0) continue;
    // Keep the first definition seen; minified scope may redefine idents, but
    // option tables are typically defined once at module top level.
    if (!map.has(ident)) map.set(ident, pairs);
  }
  return map;
}

/**
 * Build Map<msgKey, zhText> from the bundle's i18n message assignments
 * (`<locale>.Msg.<KEY>="..."`). The bundle lists locales in order with zh first,
 * so we keep the FIRST value seen per key. Used to resolve dropdown option
 * labels that are `Msg` references (e.g. the pen-color `state` dropdown whose
 * options render as bare `1`/`0` without this → 绘制/擦除).
 */
export function extractMsgStrings(bundleText) {
  const map = new Map();
  const re = /\.Msg\.([\w$]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(bundleText)) !== null) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}
