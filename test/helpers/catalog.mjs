// Test helper: load the built catalog from dist/ into a Map<type, schema>.
// Reads the combined catalog.full.json (the same artifact the runtime fetches),
// so the test suite runs on a fresh clone from committed data — without the
// per-group dist/catalog/ split (a build byproduct that is not committed).
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = resolve(ROOT, "data");
const FULL = resolve(DATA, "catalog.full.json");

export const catalogBuilt = existsSync(FULL);

export function loadCatalogMap() {
  const arr = JSON.parse(readFileSync(FULL, "utf8"));
  const map = new Map();
  for (const b of arr) map.set(b.type, b);
  return map;
}
