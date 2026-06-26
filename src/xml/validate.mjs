// src/xml/validate.mjs — Typed checker for the block language.
// Validates an IR Program against the catalog BEFORE compiling/injecting, so the
// repair loop can feed precise errors back to the LLM. This is the "type checker"
// of the new language.

/** Levenshtein distance (small inputs). */
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[m];
}

/** Top-N closest candidates to `term` from `pool`. */
function suggest(term, pool, n = 3) {
  return pool
    .map((c) => [c, lev(String(term), String(c))])
    .sort((a, b) => a[1] - b[1])
    .slice(0, n)
    .filter(([, d]) => d <= Math.max(3, String(term).length))
    .map(([c]) => c);
}

const isValueBlock = (s) => s && s.output != null;
const isStatementBlock = (s) => s && (s.prev || s.next);

/**
 * @param program IR program (Stack[] or single Stack)
 * @param catalog Map<type, schema>
 * @param opts { allTypes?: string[] } — pool for unknown-type suggestions
 * @returns { ok, errors: [{path, kind, detail, suggestions}] }
 */
export function validate(program, catalog, opts = {}) {
  const errors = [];
  const allTypes = opts.allTypes || [...catalog.keys()];
  const push = (path, kind, detail, suggestions = []) =>
    errors.push({ path, kind, detail, suggestions });

  const stacks =
    Array.isArray(program) && program.every((e) => Array.isArray(e))
      ? program
      : [program];

  const visit = (node, path, position) => {
    if (!node || typeof node !== "object" || !node.type) {
      push(path, "malformed_node", "节点缺少 type 字段");
      return;
    }
    const schema = catalog.get(node.type);
    if (!schema) {
      push(path, "unknown_type", `未知积木类型 "${node.type}"`, suggest(node.type, allTypes));
      return; // can't type-check children against a missing schema
    }

    // position compatibility
    if (position === "value" && !isValueBlock(schema)) {
      push(path, "misplaced_statement",
        `"${node.type}" 不是值积木(无 output)，不能放入值插槽`);
    }
    if (position === "statement" && isValueBlock(schema) && !isStatementBlock(schema)) {
      push(path, "misplaced_value",
        `"${node.type}" 是值积木，不能作为语句放入序列`);
    }

    // fields
    const fieldNames = (schema.fields || []).map((f) => f.name);
    for (const [name, val] of Object.entries(node.fields || {})) {
      const f = (schema.fields || []).find((x) => x.name === name);
      if (!f) {
        push(`${path}.fields.${name}`, "unknown_field",
          `"${node.type}" 没有字段 "${name}"`, suggest(name, fieldNames));
        continue;
      }
      if (f.kind === "field_dropdown" && f.enum) {
        const allowed = f.enum.map((e) => e.value);
        if (!allowed.includes(String(val))) {
          push(`${path}.fields.${name}`, "bad_enum_value",
            `字段 "${name}" 的值 "${val}" 不在可选项中`, allowed);
        }
      }
    }

    // value inputs
    const valueNames = (schema.values || []).map((v) => v.name);
    for (const [name, child] of Object.entries(node.inputs || {})) {
      const spec = (schema.values || []).find((v) => v.name === name);
      if (!spec) {
        push(`${path}.inputs.${name}`, "unknown_input",
          `"${node.type}" 没有值插槽 "${name}"`, suggest(name, valueNames));
      } else {
        const childSchema = child && catalog.get(child.type);
        if (childSchema && spec.check && spec.check !== "ANY") {
          const co = childSchema.output;
          if (co && co !== "ANY" && co !== spec.check) {
            push(`${path}.inputs.${name}`, "type_mismatch",
              `插槽 "${name}" 需要 ${spec.check}，但填入的 "${child.type}" 输出 ${co}`);
          }
        }
      }
      visit(child, `${path}.inputs.${name}`, "value");
    }

    // statement slots
    const stmtNames = schema.statements || [];
    for (const [name, seq] of Object.entries(node.statements || {})) {
      if (!stmtNames.includes(name)) {
        // 新一代事件帽子块（无插槽、可 next 顺接）被误塞进 statements.DO 是高频错误。
        // 此时给正向指引（顺接其后）而非干巴巴的「没有插槽」，让修复循环一次到位。
        const isNextHat = !stmtNames.length && !schema.prev && schema.next !== false;
        const detail = isNextHat
          ? `事件积木 "${node.type}" 没有语句插槽，事件体请直接顺接其后（锚点 at:"after"），不要放进 "${name}"`
          : `"${node.type}" 没有语句插槽 "${name}"`;
        push(`${path}.statements.${name}`, "unknown_statement", detail, suggest(name, stmtNames));
      }
      if (Array.isArray(seq)) {
        seq.forEach((n, i) => visit(n, `${path}.statements.${name}[${i}]`, "statement"));
      }
    }
  };

  stacks.forEach((stack, si) => {
    if (!Array.isArray(stack)) {
      push(`stack[${si}]`, "malformed_stack", "顶层栈必须是节点数组");
      return;
    }
    stack.forEach((node, i) => visit(node, `stack[${si}][${i}]`, "statement"));
  });

  return { ok: errors.length === 0, errors };
}

/** Build a Map<type,schema> catalog from an array of schema entries. */
export function catalogFromArray(arr) {
  return new Map(arr.map((s) => [s.type, s]));
}
