// src/pipeline.mjs — End-to-end generation brain (host-agnostic; the browser
// runtime and Node tests both drive it with an injected LLM client + loaders).
//
// retrieve → select board docs → id-annotate current workspace + enumerate
// anchors → assemble L0–L7 → generate edit-ops + repair → apply ops → compile.

import { retrieve, coreTypes } from "./kb/retriever.mjs";
import { selectBoardDocs, resolveVersion, boardFromMaster } from "./kb/knowledge.mjs";
import { assembleMessages } from "./ctx/assemble.mjs";
import { generateWithRepair } from "./llm/repair.mjs";
import { annotateIds, enumerateAnchors } from "./host/ops.mjs";
import { compile } from "./xml/compile.mjs";

/**
 * @param o {
 *   request, master='',
 *   index, catalog, seeds,
 *   knowledge: { core, antipatterns, triggers, loadDoc },
 *   currentProgram=[], client, maxRepairs=2,
 *   topN=80, onProgress?
 * }
 * @returns { ok, ops, ir, xml, report, attempts, version, retrieved, anchors, withIds }
 */
export async function generateProgram(o) {
  const onProgress = o.onProgress || (() => {});
  const boardInfo = boardFromMaster(o.master);
  const version =
    boardInfo.version !== "unknown"
      ? boardInfo.version
      : resolveVersion({ request: o.request, master: o.master, triggers: o.knowledge?.triggers });
  onProgress({ phase: "version", version, board: boardInfo.label });

  onProgress({ phase: "retrieve" });
  const retrieved = retrieve(o.request, o.index, { topN: o.topN ?? 80, board: boardInfo.board });
  const core = coreTypes(o.index, boardInfo.board);

  let boardDocs = [];
  if (o.knowledge?.loadDoc) {
    boardDocs = await selectBoardDocs(o.request, version, {
      triggers: o.knowledge.triggers,
      loadDoc: o.knowledge.loadDoc,
    });
  }
  onProgress({ phase: "context", retrieved: retrieved.types.length, boardDocs: boardDocs.length });

  // current workspace → id-annotated IR + valid insertion anchors
  const withIds = annotateIds(o.currentProgram || []);
  const anchors = enumerateAnchors(withIds, o.catalog);

  const messages = assembleMessages({
    request: o.request,
    catalog: o.catalog,
    coreTypes: core,
    retrievedTypes: retrieved.types,
    seeds: o.seeds,
    core: o.knowledge?.core,
    antipatterns: o.knowledge?.antipatterns,
    withIds,
    anchors,
    boardDocs,
    version,
  });

  const result = await generateWithRepair({
    baseMessages: messages,
    current: withIds,
    catalog: o.catalog,
    client: o.client,
    maxRepairs: o.maxRepairs ?? 2,
    onProgress,
    signal: o.signal,
  });

  const ir = result.ok ? result.result : null;
  const xml = ir ? compile(ir, { catalog: o.catalog }) : null;
  onProgress({ phase: "done", ok: result.ok, attempts: result.attempts });
  return {
    ok: result.ok,
    ops: result.ops,
    ir,
    xml,
    report: result.report,
    attempts: result.attempts,
    version,
    retrieved: retrieved.types,
    anchors,
    withIds,
  };
}
