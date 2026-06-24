// src/ctx/fewshot.mjs — L5 few-shot examples (intent → IR). Static seeds teach
// the language's idioms; a dynamic seed reflects the user's current workspace
// back as IR so the model can edit in-language.

/** Render static seed examples as <example> blocks (Claude-Code style). */
export function renderSeeds(seeds) {
  if (!seeds?.length) return "";
  const blocks = seeds.map((s, i) => {
    const ir = JSON.stringify(s.ir);
    return `<example>\n需求: ${s.intent}\n输出:\n\`\`\`json\n${ir}\n\`\`\`\n</example>`;
  });
  return "# 示例 (few-shot)\n" + blocks.join("\n");
}

/**
 * Render the user's current workspace (already decompiled to IR) as context,
 * so the model edits in-language rather than from scratch.
 */
export function renderCurrent(currentProgram) {
  if (!currentProgram || (Array.isArray(currentProgram) && currentProgram.length === 0)) {
    return "# 当前工作区\n(空工作区)";
  }
  return "# 当前工作区 (IR)\n```json\n" + JSON.stringify(currentProgram) + "\n```";
}

/**
 * Render the id-annotated current workspace plus the menu of valid insertion
 * anchors, so the model can target edits precisely by id.
 * @param withIds  annotateIds(program) — each node carries an `id`
 * @param anchors  enumerateAnchors(withIds, catalog) — [{key,label,...}]
 */
export function renderCurrentWithAnchors(withIds, anchors) {
  const parts = [];
  if (!withIds || (Array.isArray(withIds) && withIds.length === 0)) {
    parts.push("# 当前工作区\n(空工作区)");
  } else {
    parts.push("# 当前工作区 (IR，每块带 id)\n```json\n" + JSON.stringify(withIds) + "\n```");
  }
  if (anchors && anchors.length) {
    const lines = anchors.map((a) => `- \`${a.key}\` — ${a.label}`);
    parts.push("# 可选落点 (anchor.key → 含义)\n" + lines.join("\n"));
  }
  return parts.join("\n\n");
}
