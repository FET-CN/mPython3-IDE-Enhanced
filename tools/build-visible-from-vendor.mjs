#!/usr/bin/env bun
// Build data/toolbox.visible.json from the reverse/live toolbox dump.
//
// This is the offline counterpart to `dump:toolbox`: when the live site is not
// accessible in CI/dev, use the reverse artifact captured from the real running
// Blockly toolbox (`ws.options.languageTree`). It intentionally consumes the
// authoritative live dump, not the full block export: block definitions say what
// exists, while this file says what users can actually find in the side palette.
//
// Env:
//   M3E_REVERSE_DIR=/mnt/dev-cold/handpy-research/reverse-online-mpython-cn
//   (defaults to that path if present)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DATA_DIR = resolve(ROOT, "data");
const DEFAULT_REVERSE = "/mnt/dev-cold/handpy-research/reverse-online-mpython-cn";
const reverseDir = process.env.M3E_REVERSE_DIR || DEFAULT_REVERSE;
const authoritative = resolve(reverseDir, "toolbox-dump/authoritative.json");
const catalogIndexPath = resolve(DATA_DIR, "catalog.index.json");
const outPath = resolve(DATA_DIR, "toolbox.visible.json");

if (!existsSync(authoritative)) {
  throw new Error(`缺少 authoritative toolbox dump: ${authoritative}`);
}
if (!existsSync(catalogIndexPath)) {
  throw new Error(`缺少 catalog.index.json: ${catalogIndexPath}`);
}

const raw = JSON.parse(readFileSync(authoritative, "utf8"));
const index = JSON.parse(readFileSync(catalogIndexPath, "utf8"));
const catalogTypes = new Set(index.map((e) => e.type));
const boards = ["mPython", "mPython_V3"];
const byBoard = {};
const counts = {};
const dropped = {};

for (const b of boards) {
  const list = Array.isArray(raw.byBoard?.[b]) ? raw.byBoard[b] : [];
  const kept = [];
  const seen = new Set();
  dropped[b] = [];
  for (const t of list) {
    if (!catalogTypes.has(t)) { dropped[b].push(t); continue; }
    if (!seen.has(t)) { seen.add(t); kept.push(t); }
  }
  kept.sort();
  byBoard[b] = kept;
  counts[b] = kept.length;
}

const payload = {
  _comment: "侧边积木栏(默认工具箱)里真实可见的 block type，按板分。由 reverse/live languageTree authoritative dump 离线生成；可用 `bun run dump:toolbox` 联网刷新。",
  schema: 2,
  source: raw.source || "live online.mpython.cn toolbox-dump/authoritative.json",
  method: raw.method || null,
  capturedAt: raw.capturedAt || null,
  counts,
  byBoard,
  categories: raw.categories || null,
  droppedNotInCatalog: dropped,
};

writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
console.error(`[visible] wrote ${outPath}: mPython=${counts.mPython}, mPython_V3=${counts.mPython_V3}`);
for (const b of boards) {
  if (dropped[b].length) console.error(`[visible] dropped ${b}: ${dropped[b].length} not in catalog`);
}
