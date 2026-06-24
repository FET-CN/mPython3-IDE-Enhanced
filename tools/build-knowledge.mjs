// build-knowledge.mjs — Assemble the board-knowledge layer.
// Always-on L1 (core.json) + on-demand L4 docs (verbatim HandPy markdown) +
// trigger maps + a best-effort catalog-group → board-version mapping.
//
//   data/knowledge/core.json        — L1 always-on facts
//   data/knowledge/triggers.json    — keyword → doc routing
//   data/knowledge/antipatterns.json
//   data/knowledge/<doc>.md         — common/v2/v3/patterns + modules/*.md
//   data/knowledge/group-version.json — catalog group → v2|v3|both|other
//   data/knowledge/index.json       — manifest

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDPY_SKILL_DIR, DATA_DIR } from "./lib/paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "data");
const KN = resolve(DATA_DIR, "knowledge");
const REF = resolve(HANDPY_SKILL_DIR, "references");

// Heuristic mapping from catalog group / type-prefix to board version.
// mPython (v2) & mPython_V3 (v3) share most `mpython_*` blocks → "both".
// `esp32s3*` are v3-only; `_1956*` / `1956*` are the labplus 1956 board family
// (a different master, surfaced in this IDE) → "other".
function groupVersion(group) {
  if (!group) return "both";
  const g = group.toLowerCase();
  if (/esp32s3|^s3/.test(g)) return "v3";
  if (/^1956|^_?1956|labplus/.test(g)) return "other";
  if (/^lvgl|^lv_|^gui$/.test(g)) return "v3";
  return "both";
}

function main() {
  mkdirSync(resolve(KN, "modules"), { recursive: true });

  // 1. Curated L1 + triggers + antipatterns
  for (const f of ["knowledge-core.json", "knowledge-triggers.json", "antipatterns.json"]) {
    const dst = f.replace(/^knowledge-/, "");
    copyFileSync(resolve(DATA, f), resolve(KN, dst));
  }

  // 2. Verbatim L4 docs (on-demand)
  const topDocs = ["common.md", "v2.md", "v3.md", "patterns.md", "tool.md"];
  const copiedDocs = [];
  for (const d of topDocs) {
    const src = resolve(REF, d);
    if (existsSync(src)) { copyFileSync(src, resolve(KN, d)); copiedDocs.push(d); }
  }
  const modDir = resolve(REF, "modules");
  const copiedModules = [];
  if (existsSync(modDir)) {
    for (const m of readdirSync(modDir)) {
      if (m.endsWith(".md")) {
        copyFileSync(resolve(modDir, m), resolve(KN, "modules", m));
        copiedModules.push(m);
      }
    }
  }

  // 3. Catalog group → version map (best-effort)
  const groupVer = {};
  const metaPath = resolve(DATA_DIR, "catalog.meta.json");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    for (const g of meta.groups) groupVer[g] = groupVersion(g);
  }
  writeFileSync(resolve(KN, "group-version.json"), JSON.stringify(groupVer, null, 2));

  // 4. Manifest
  const manifest = {
    builtFrom: HANDPY_SKILL_DIR,
    core: "core.json",
    triggers: "triggers.json",
    antipatterns: "antipatterns.json",
    docs: copiedDocs,
    modules: copiedModules,
    groupVersion: "group-version.json",
  };
  writeFileSync(resolve(KN, "index.json"), JSON.stringify(manifest, null, 2));

  console.error(
    `[knowledge] core+triggers+antipatterns, ${copiedDocs.length} docs, ${copiedModules.length} modules, ${Object.keys(groupVer).length} groups mapped`,
  );
}

main();
