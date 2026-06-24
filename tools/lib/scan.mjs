// Low-level text scanning helpers for parsing minified Blockly block definitions.
// These operate on already-JSON-parsed snippet strings (so quotes are real `"`,
// not escaped). Pure functions — unit-tested in test/unit/scan.spec.mjs.

/**
 * Split `text` on `sep` only at bracket/brace/paren depth 0 and outside strings.
 * Returns array of trimmed segments.
 */
export function splitTopLevel(text, sep = ",") {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/**
 * Given `str` and an index pointing at an opening bracket char (one of [ { (),
 * return the [startIdx, endIdxInclusive] of the balanced region, respecting
 * strings. Returns null if unbalanced.
 */
export function balancedRange(str, openIdx) {
  const open = str[openIdx];
  const close = { "[": "]", "{": "}", "(": ")" }[open];
  if (!close) return null;
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return [openIdx, i];
    }
  }
  return null;
}

/** Return the balanced substring (including delimiters) starting at openIdx. */
export function balancedSlice(str, openIdx) {
  const r = balancedRange(str, openIdx);
  return r ? str.slice(r[0], r[1] + 1) : null;
}

/**
 * Find the object literal `{...}` that contains the character at `needleIdx`,
 * by scanning backward to the enclosing unbalanced `{` then taking its balanced
 * slice. Returns substring or null.
 */
export function enclosingObject(str, needleIdx) {
  let depth = 0;
  let quote = null;
  // Scan backward; track quotes naively by scanning forward is hard, so we do a
  // simple backward scan that ignores quote escaping (block defs don't put
  // braces inside option labels at this level).
  for (let i = needleIdx; i >= 0; i--) {
    const c = str[i];
    if (c === "}" || c === "]" || c === ")") depth++;
    else if (c === "{" || c === "[" || c === "(") {
      if (depth === 0) {
        if (c === "{") return balancedSlice(str, i);
        return null; // hit an array/paren boundary first → not directly in an object
      }
      depth--;
    }
  }
  return null;
}

/**
 * Strip one layer of matching surrounding quotes from a token, returning the
 * inner string, or null if the token is not a simple string literal.
 */
export function asStringLiteral(tok) {
  tok = tok.trim();
  const q = tok[0];
  if ((q === '"' || q === "'" || q === "`") && tok[tok.length - 1] === q) {
    return tok.slice(1, -1);
  }
  return null;
}

/**
 * Extract the i18n Msg key from a dropdown label token that is a `Msg` lookup,
 * e.g. `Me["Msg"].mpython_display_hline_1` or `r.Msg["foo"]` → the trailing key.
 * Returns null when the token isn't a Msg reference. Resolved to Chinese text
 * later against the bundle's Msg table.
 */
export function extractMsgRef(tok) {
  if (!tok || !/\bMsg\b/.test(tok)) return null;
  let m = tok.match(/\.\s*([\w$]+)\s*$/); // …Msg"].KEY  or  …Msg.KEY
  if (m) return m[1];
  m = tok.match(/\[\s*["']([\w$]+)["']\s*\]\s*$/); // …Msg["KEY"]
  return m ? m[1] : null;
}

/**
 * Parse a Blockly dropdown options array literal text like
 *   [["P0","0"],[Me["Msg"].X,"down"],["lbl",1]]
 * into [{label, value, labelRef?}] where value is a string (numbers stringified).
 * `label` is the literal label when available, else null; when the label is a
 * `Msg` reference, `labelRef` carries its key for later resolution.
 */
export function parseOptionPairs(arrText) {
  arrText = arrText.trim();
  if (arrText[0] !== "[") return [];
  const inner = arrText.slice(1, -1);
  const elems = splitTopLevel(inner, ",").filter((s) => s.length);
  const pairs = [];
  for (const el of elems) {
    if (el[0] !== "[") continue;
    const parts = splitTopLevel(el.slice(1, -1), ",");
    if (parts.length < 2) continue;
    const valueTok = parts[parts.length - 1].trim();
    const labelTok = parts.slice(0, -1).join(",").trim();
    let value = asStringLiteral(valueTok);
    if (value === null) {
      // numeric or identifier value
      if (/^-?\d+(\.\d+)?$/.test(valueTok)) value = valueTok;
      else continue; // unresolvable (rare) — skip
    }
    const label = asStringLiteral(labelTok);
    const pair = { label, value };
    if (label === null) {
      const ref = extractMsgRef(labelTok);
      if (ref) pair.labelRef = ref;
    }
    pairs.push(pair);
  }
  return pairs;
}
