// Centralized paths to the build-time source data (reverse-engineered app bundle,
// block-definition export, HandPy skill). These exports are NOT redistributed in
// this repo — only the DERIVED catalog/knowledge data under dist/ is committed
// (it is built from CC0 upstream block data). You only need these paths if you
// want to REGENERATE the catalog/knowledge (`bun run build:catalog|build:knowledge`).
//
// Configure via env vars (see .env.example); the defaults point at a local
// ./vendor/ folder so nothing is hardcoded to a particular machine.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..", ".."); // tools/lib → project root
const VENDOR = resolve(ROOT, "vendor");

export const REVERSE_DIR =
  process.env.M3E_REVERSE_DIR || resolve(VENDOR, "reverse-online-mpython-cn");
export const BLOCK_EXPORT_DIR =
  process.env.M3E_BLOCK_EXPORT_DIR || resolve(VENDOR, "mpython-block-export");
export const HANDPY_SKILL_DIR =
  process.env.M3E_HANDPY_SKILL_DIR || resolve(VENDOR, "handpy-skill");

export const DIST_DIR = resolve(ROOT, "dist");
// data/ holds the COMMITTED derived block catalog + board knowledge (the tool's
// standard library). `build:catalog`/`build:knowledge` write here; `build:bookmarklet`
// assembles dist/ for hosting from data/ + the JS bundle (no private data needed).
export const DATA_DIR = resolve(ROOT, "data");
export const APP_BUNDLE = resolve(REVERSE_DIR, "site/js/app.64f8b4d9.js");
export const BLOCKS_I18N = resolve(BLOCK_EXPORT_DIR, "i18n/blocks-i18n.json");
export const BLOCKS_SNIPPETS = resolve(BLOCK_EXPORT_DIR, "non-strict/blocks.json");
export const GROUPS_I18N = resolve(BLOCK_EXPORT_DIR, "i18n/groups-i18n.json");
export const EXT_CATALOG = resolve(REVERSE_DIR, "extension_catalog_all.json");
