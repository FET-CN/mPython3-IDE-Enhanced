// Parse a minified Blockly block definition snippet to enrich the i18n metadata
// with: output value-type, per-field kind + dropdown enum values, and per-value
// input check-type. The i18n export already provides slot NAMES (fields/values/
// statements); this module fills in the typed details the LLM needs to fill them.

import {
  enclosingObject,
  balancedSlice,
  parseOptionPairs,
  splitTopLevel,
  asStringLiteral,
} from "./scan.mjs";
import { extractOptionVars } from "./optionVars.mjs";

const FIELD_KIND_RE = /type:"(field_\w+)"/;

/** Find the value-type a block outputs, or null (statement block / untyped). */
export function parseOutputType(snippet) {
  // jsonInit / defineBlocksWithJsonArray: output:"Type" | output:null
  let m = snippet.match(/[,{]output:(?:"([A-Za-z]+)"|null)/);
  if (m) return m[1] || "ANY";
  // imperative: setOutput(!0,"Type") | setOutput(true,"Type") | setOutput(!0)
  m = snippet.match(/setOutput\((?:!0|true)\s*(?:,\s*"([A-Za-z]+)")?\)/);
  if (m) return m[1] || "ANY";
  return null;
}

/**
 * Extract field detail for a single field `name` from the snippet.
 * Returns {kind, enum?, enumUnresolved?, default?, min?, max?} or null.
 */
function parseField(name, snippet, varMap) {
  // Style A: jsonInit args0 object containing name:"<name>"
  const nameIdx = snippet.indexOf(`name:"${name}"`);
  if (nameIdx !== -1) {
    const obj = enclosingObject(snippet, nameIdx);
    if (obj) {
      const km = obj.match(FIELD_KIND_RE);
      const kind = km ? km[1] : "field_unknown";
      const info = { kind };
      if (kind === "field_dropdown") {
        const oi = obj.indexOf("options:");
        if (oi !== -1) {
          const after = obj.slice(oi + 8).trimStart();
          if (after[0] === "[") {
            const bracketIdx = obj.indexOf("[", oi + 8);
            const pairs = parseOptionPairs(balancedSlice(obj, bracketIdx) || "");
            if (pairs.length) info.enum = pairs;
            else info.enumUnresolved = true; // dynamic/empty dropdown
          } else {
            const id = after.match(/^[A-Za-z_$][\w$]*/);
            if (id && varMap.has(id[0])) info.enum = varMap.get(id[0]);
            else info.enumUnresolved = true;
          }
        }
      } else if (kind === "field_number") {
        const v = obj.match(/value:(-?\d+(?:\.\d+)?)/);
        const mn = obj.match(/min:(-?\d+(?:\.\d+)?)/);
        const mx = obj.match(/max:(-?\d+(?:\.\d+)?)/);
        if (v) info.default = Number(v[1]);
        if (mn) info.min = Number(mn[1]);
        if (mx) info.max = Number(mx[1]);
      } else if (kind === "field_input") {
        const t = obj.match(/text:"([^"]*)"/);
        if (t) info.default = t[1];
      }
      return info;
    }
  }
  // Style B: imperative appendField(new …FieldDropdown(X),"name")
  const fdRe = new RegExp(
    `FieldDropdown\\(([^)]*)\\)\\s*,\\s*"${name}"`,
  );
  const fm = snippet.match(fdRe);
  if (fm) {
    const arg = fm[1].trim();
    const info = { kind: "field_dropdown" };
    if (arg[0] === "[") {
      const idx = snippet.indexOf(arg);
      const pairs = parseOptionPairs(balancedSlice(snippet, idx) || arg);
      if (pairs.length) info.enum = pairs;
      else info.enumUnresolved = true;
    } else if (varMap.has(arg)) {
      info.enum = varMap.get(arg);
    } else {
      info.enumUnresolved = true;
    }
    return info;
  }
  return null;
}

/**
 * Discover input slots and fields declared anywhere in the snippet — both
 * jsonInit `args0` objects AND imperative `append*Input/appendField` calls
 * (the i18n export misses the imperative ones, e.g. `.appendStatementInput("DO")`).
 * Returns {statements:[], values:[], fields:[]} (names, de-duplicated, ordered).
 */
export function discoverSlots(snippet) {
  const statements = new Set();
  const values = new Set();
  const fields = new Set();
  let m;
  // imperative append calls
  const appendStmt = /appendStatementInput\("([^"]+)"\)/g;
  while ((m = appendStmt.exec(snippet))) statements.add(m[1]);
  const appendVal = /appendValueInput\("([^"]+)"\)/g;
  while ((m = appendVal.exec(snippet))) values.add(m[1]);
  const appendFieldNamed = /appendField\([^,]*,\s*"([^"]+)"\)/g;
  while ((m = appendFieldNamed.exec(snippet))) fields.add(m[1]);
  // jsonInit args0 objects: match `type:"input_statement"…name:"X"` (either order)
  const typedName = /\{[^{}]*\}/g;
  while ((m = typedName.exec(snippet))) {
    const obj = m[0];
    const nm = obj.match(/name:"([^"]+)"/);
    if (!nm) continue;
    if (/input_statement/.test(obj)) statements.add(nm[1]);
    else if (/input_value/.test(obj)) values.add(nm[1]);
    else if (/type:"field_/.test(obj)) fields.add(nm[1]);
  }
  return {
    statements: [...statements],
    values: [...values],
    fields: [...fields],
  };
}

/** Detect previousStatement / nextStatement connections from a snippet. */
export function parseConnections(snippet) {
  const prev =
    /[,{]previousStatement:/.test(snippet) ||
    /setPreviousStatement\((?:!0|true)/.test(snippet);
  const next =
    /[,{]nextStatement:/.test(snippet) ||
    /setNextStatement\((?:!0|true)/.test(snippet);
  return { prev, next };
}

/** Extract the check-type for a value input `name`. */
function parseValueCheck(name, snippet) {  // jsonInit args0: {type:"input_value",name:"X",check:"Number"}
  const nameIdx = snippet.indexOf(`name:"${name}"`);
  if (nameIdx !== -1) {
    const obj = enclosingObject(snippet, nameIdx);
    if (obj && /type:"input_value"/.test(obj)) {
      const c = obj.match(/check:(?:"([A-Za-z]+)"|\[([^\]]*)\])/);
      if (c) {
        if (c[1]) return c[1];
        if (c[2]) {
          const first = splitTopLevel(c[2], ",")[0];
          return asStringLiteral(first) || "ANY";
        }
      }
      return "ANY";
    }
  }
  // imperative: appendValueInput("X").setCheck("Number") | .setCheck(["A","B"])
  const re = new RegExp(
    `appendValueInput\\("${name}"\\)(?:\\.[\\w$]+\\([^)]*\\))*?\\.setCheck\\((?:"([A-Za-z]+)"|\\[([^\\]]*)\\])`,
  );
  const m = snippet.match(re);
  if (m) {
    if (m[1]) return m[1];
    if (m[2]) return asStringLiteral(splitTopLevel(m[2], ",")[0]) || "ANY";
  }
  // value input present but no explicit check
  if (new RegExp(`appendValueInput\\("${name}"\\)`).test(snippet)) return "ANY";
  return "ANY";
}

/**
 * Enrich one block. `i18n` provides authoritative connection booleans +
 * message0Zh + some slot names; `nonstrict` (non-strict/blocks.json entry) and
 * the snippet itself supply the rest. Returns a normalized enrichment with the
 * UNION of slot names and per-slot typing.
 */
export function parseSnippet(snippet, i18n, globalVars, nonstrict = null) {
  const base = {
    fields: unionNames(i18n?.fields, nonstrict?.fields),
    values: unionNames(i18n?.values, nonstrict?.values),
    statements: unionNames(i18n?.statements, nonstrict?.statements),
  };
  if (!snippet) {
    return {
      outputType: i18n?.output ? "ANY" : null,
      prev: !!i18n?.previousStatement,
      next: !!i18n?.nextStatement,
      fields: base.fields.map((name) => ({ name, kind: "field_unknown" })),
      values: base.values.map((name) => ({ name, check: "ANY" })),
      statements: base.statements,
      parsed: false,
    };
  }
  // Local vars defined inside this snippet (imperative blocks) take precedence.
  const localVars = extractOptionVars(snippet);
  const varMap = new Map(globalVars);
  for (const [k, v] of localVars) varMap.set(k, v);

  // Union i18n/nonstrict names with everything discovered in the snippet, BUT
  // let the snippet's args0 parse be the authoritative classifier: the i18n /
  // non-strict name lists routinely mis-file a slot (e.g. the pen-color `state`
  // dropdown and the x/y coordinate inputs land in both fields and values). A
  // name the snippet positively types as value/statement must not also surface
  // as a field, and vice-versa — otherwise the same slot renders twice on the
  // card and the model fills it in the wrong place (or omits it).
  const disc = discoverSlots(snippet);
  const discFields = new Set(disc.fields);
  const discValues = new Set(disc.values);
  const discStatements = new Set(disc.statements);

  const fieldNames = unionNames(base.fields, disc.fields).filter(
    (n) => !discValues.has(n) && !discStatements.has(n),
  );
  const valueNames = unionNames(base.values, disc.values).filter(
    (n) => !discFields.has(n) && !discStatements.has(n),
  );
  const statementNames = unionNames(base.statements, disc.statements).filter(
    (n) => !discFields.has(n) && !discValues.has(n),
  );

  const fields = fieldNames.map((name) => {
    const info = parseField(name, snippet, varMap) || { kind: "field_unknown" };
    return { name, ...info };
  });
  const values = valueNames.map((name) => ({
    name,
    check: parseValueCheck(name, snippet),
  }));

  const conn = parseConnections(snippet);
  return {
    outputType: parseOutputType(snippet) ?? (i18n?.output ? "ANY" : null),
    prev: i18n?.previousStatement ?? conn.prev,
    next: i18n?.nextStatement ?? conn.next,
    fields,
    values,
    statements: statementNames,
    parsed: true,
  };
}

/** Order-preserving union of two name arrays. */
function unionNames(a, b) {
  const out = [];
  const seen = new Set();
  for (const arr of [a || [], b || []]) {
    for (const n of arr) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}
