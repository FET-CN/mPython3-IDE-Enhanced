// build-catalog.mjs — Keystone build step.
// Produces the typed block catalog the LLM uses as the "standard library" of the
// graphical block language:
//   dist/catalog.index.json      — compact entry per block (retrieval)
//   dist/catalog/<group>.json    — full typed SchemaEntry per block
//   dist/catalog.meta.json       — buildVersion + stats
//
// Base set = union of non-strict/blocks.json (3413, has snippets/slots) and
// blocks-i18n.json (3252, has message0Zh + connection booleans). Standard
// Blockly blocks whose defs live in the vendor bundle (text, math_number,
// logic_compare, controls_if, …) are supplied by a hand-authored supplement
// tools/data/core-blocks.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_BUNDLE,
  BLOCKS_I18N,
  BLOCKS_SNIPPETS,
  EXT_CATALOG,
  DATA_DIR,
} from "./lib/paths.mjs";
import { extractOptionVars, extractMsgStrings } from "./lib/optionVars.mjs";
import { extractMsgRef } from "./lib/scan.mjs";
import { parseSnippet } from "./lib/parseSnippet.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_BLOCKS_FILE = resolve(__dirname, "data/core-blocks.json");

// mPython hardware blocks frequently used (matched by substring on type).
const CORE_TYPE_PATTERNS = [
  /button_[ab]/i,
  /^mpython_.*(oled|display|show|rgb|led|pin|sleep|button|touch)/i,
  /^oled_/i, /_rgb_/i, /digital_(read|write)/i, /analog_(read|write)/i,
];

// Peripheral / other-product sub-families whose names collide with the core
// patterns above (e.g. mpython_AIcamera_set_led, mpython_AMIGO_lcd_display).
// These are accessories or other boards, not 掌控板 core vocabulary — they must
// never auto-claim `core`, or they crowd the real mpython_display_*/set_RGB
// primitives out of the capped core-vocab section shown to the model.
const NON_CORE_FAMILY =
  /(AIcamera|AMIGO|box_and|bluebit|_dog_|siot|blynk|kmeans|article|v831|peripheral|tello|gamebit|matrix_show|mysteam|UAV|mpythonbox|MutualBox)/i;

function ioKind(out, prev, next) {
  if (out) return "value";
  if (!prev) return "hat"; // no upward connection → top-level (event/start)
  return "statement";
}

// zh dictionary over block-type tokens. Used ONLY to synthesize a short card
// title for blocks whose message0 is just `"%1"` (a bare dropdown selector) and
// therefore export with an empty zh — so the card head isn't "(无描述)". The
// dropdown's own (now-labeled) options still carry the exact values; this only
// supplies the noun/role. Conservative: emits a title only when ≥1 token maps.
const ZH_TOKEN = {
  oled: "OLED", lcd: "LCD", display: "显示", show: "显示", pixel: "像素",
  rgb: "RGB灯", led: "LED", neopixel: "RGB灯", pin: "引脚", music: "音乐",
  buzzer: "蜂鸣器", tone: "音调", image: "图像", img: "图像", bmp: "图像",
  list: "列表", row: "行", line: "行", lines: "行", color: "颜色", colour: "颜色",
  option: "选项", value: "值", state: "状态", number: "编号", num: "编号",
  built: "内置", image_list: "图像", font: "字体", char: "字符", text: "文本",
  v2: "V2", v3: "V3", box: "实验箱", select: "选择", brightness: "亮度",
  temperature: "温度", humidity: "湿度", light: "光线", sound: "声音",
};
// type-name prefixes to drop before tokenizing (product/family namespaces)
const ZH_DROP_PREFIX = /^(mpythons?|mpythonbox)$/i;

function synthesizeZh(type) {
  const toks = type.split(/[_\W]+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].toLowerCase();
    if (i === 0 && ZH_DROP_PREFIX.test(t)) continue;
    if (t === "in" || t === "of") continue; // glue words ("built in")
    if (ZH_TOKEN[t]) out.push(ZH_TOKEN[t]);
  }
  // de-dupe consecutive repeats (e.g. show+display → 显示 显示)
  const dedup = out.filter((w, i) => w !== out[i - 1]);
  return dedup.length ? dedup.join(" ") : "";
}

function keywords(type, group) {
  const kw = new Set();
  for (const t of type.split(/[_\W]+/)) if (t) kw.add(t.toLowerCase());
  if (group) kw.add(group.toLowerCase());
  return [...kw];
}

const groupKey = (group) => (group && group.length ? group : "_ungrouped");

// Groups that clearly belong to OTHER boards (not 掌控板) — force-excluded even
// if not present in the extension masters table.
const FOREIGN_GROUPS = new Set([
  "1956", "1956v2", "new1956", "labplus", "educore", "hunan", "Carbit",
  "microbit", "LEDONG", "Le_Dong", "tello", "gamebit", "mysteam",
]);

/** Build Map<blockType, Set<master>> from the extension catalog. */
function buildMasterMap(extPath) {
  const map = new Map();
  if (!existsSync(extPath)) return map;
  const items = JSON.parse(readFileSync(extPath, "utf8")).items || [];
  for (const it of items) {
    const ms = [].concat(it.masters || it.master || []);
    for (const t of it.block_types || []) {
      if (!map.has(t)) map.set(t, new Set());
      for (const m of ms) map.get(t).add(m);
    }
  }
  return map;
}

/**
 * Board-compatibility code for one block (only the two 掌控板 boards matter):
 *   '23' both | '2' mPython(v2) only | '3' mPython_V3(v3) only
 *   'u' universal/built-in (not board-specific) | '' other-board-only
 */
function boardCode(type, group, masterMap) {
  if (FOREIGN_GROUPS.has(group)) return "";
  const ms = masterMap.get(type);
  if (!ms) return "u"; // built-in / not an extension block → universal
  const v2 = ms.has("mPython");
  const v3 = ms.has("mPython_V3");
  if (v2 && v3) return "23";
  if (v2) return "2";
  if (v3) return "3";
  return ""; // belongs only to other boards
}

function main() {
  const i18nArr = JSON.parse(readFileSync(BLOCKS_I18N, "utf8"));
  const nsArr = JSON.parse(readFileSync(BLOCKS_SNIPPETS, "utf8"));
  const i18nMap = new Map(i18nArr.map((b) => [b.type, b]));
  const nsMap = new Map(nsArr.map((b) => [b.type, b]));
  const coreBlocks = existsSync(CORE_BLOCKS_FILE)
    ? JSON.parse(readFileSync(CORE_BLOCKS_FILE, "utf8"))
    : [];
  const coreMap = new Map(coreBlocks.map((b) => [b.type, b]));

  console.error("[catalog] reading app bundle for option vars…");
  const bundle = readFileSync(APP_BUNDLE, "utf8");
  const globalVars = extractOptionVars(bundle);
  console.error(`[catalog] resolved ${globalVars.size} option vars from bundle`);
  const msgMap = extractMsgStrings(bundle);
  console.error(`[catalog] resolved ${msgMap.size} i18n Msg strings from bundle`);

  const masterMap = buildMasterMap(EXT_CATALOG);
  console.error(`[catalog] master table covers ${masterMap.size} block types`);

  const allTypes = new Set([...i18nMap.keys(), ...nsMap.keys(), ...coreMap.keys()]);
  const index = [];
  const byGroup = new Map();
  const stats = {
    total: allTypes.size, fromI18n: i18nMap.size, fromNonStrict: nsMap.size,
    coreSupplement: coreMap.size, withSnippet: 0, withOutputType: 0,
    dropdowns: 0, dropdownsResolved: 0, dropdownsUnresolved: 0, core: 0,
  };

  for (const type of allTypes) {
    const i18n = i18nMap.get(type) || null;
    const ns = nsMap.get(type) || null;
    const snippet = ns ? (ns.snippets || []).join("\n") : "";
    if (snippet) stats.withSnippet++;
    const enr = parseSnippet(snippet, i18n, globalVars, ns);

    const group = (i18n?.group ?? ns?.group ?? "") || "";
    const bd = boardCode(type, group, masterMap);
    // The i18n export leaves message0Zh empty when the block's message0 is a
    // `Msg` reference (e.g. mysteam OLED string), or just "%1" (a bare dropdown
    // selector). Resolve from the Msg table, else synthesize a short token title.
    const msgRefKey = extractMsgRef(i18n?.message0Ref || "");
    const zh =
      i18n?.message0Zh ||
      (msgRefKey ? msgMap.get(msgRefKey) : "") ||
      synthesizeZh(type) ||
      "";
    // Auto-core only for 掌控板-usable blocks (bd ≠ other-board-only) that aren't
    // peripheral/other-product families — keeps the capped core vocab focused.
    const autoCore =
      bd !== "" &&
      !NON_CORE_FAMILY.test(type) &&
      CORE_TYPE_PATTERNS.some((re) => re.test(type));

    let schema = {
      type,
      group,
      zh,
      colour: i18n?.colourRef || "",
      output: enr.outputType,
      prev: enr.prev,
      next: enr.next,
      fields: enr.fields,
      values: enr.values,
      statements: enr.statements,
      core: autoCore,
    };

    // Hand-authored supplement is authoritative (overrides extracted schema).
    if (coreMap.has(type)) {
      const c = coreMap.get(type);
      schema = { ...schema, ...c, core: c.core ?? true, zh: c.zh || schema.zh };
    }

    // Resolve dropdown option labels that were left null because the label was a
    // `Msg` reference in the minified def (e.g. the pen-color `state` dropdown →
    // 绘制/擦除, the OLED `display_fill` dropdown → 清空/全亮/黑底/白底). Without a
    // label the model only sees opaque values like `1`/`0` and omits the color.
    for (const f of schema.fields || []) {
      if (!Array.isArray(f.enum)) continue;
      for (const e of f.enum) {
        if (e.label == null && e.labelRef && msgMap.has(e.labelRef)) {
          e.label = msgMap.get(e.labelRef);
        }
        if (e.labelRef) delete e.labelRef; // keep the shipped catalog compact
      }
    }

    if (schema.core) stats.core++;
    if (schema.output) stats.withOutputType++;
    for (const f of schema.fields) {
      if (f.kind === "field_dropdown") {
        stats.dropdowns++;
        if (f.enum) stats.dropdownsResolved++;
        else stats.dropdownsUnresolved++;
      }
    }

    const gk = groupKey(schema.group);
    if (!byGroup.has(gk)) byGroup.set(gk, []);
    byGroup.get(gk).push(schema);

    schema.bd = bd;

    index.push({
      type,
      group: schema.group,
      zh: schema.zh,
      io: ioKind(schema.output, schema.prev, schema.next),
      bd,
      nF: schema.fields.length,
      nV: schema.values.length,
      nS: schema.statements.length,
      core: schema.core,
      kw: keywords(type, schema.group),
    });
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(resolve(DATA_DIR, "catalog.index.json"), JSON.stringify(index));
  // Combined schema file the runtime fetches + tests load (one fetch → full
  // validator correctness). The per-group split is no longer emitted; nothing
  // reads it (tests + runtime use catalog.full.json).
  const allSchemas = [];
  for (const [, blocks] of byGroup) allSchemas.push(...blocks);
  writeFileSync(resolve(DATA_DIR, "catalog.full.json"), JSON.stringify(allSchemas));
  const meta = {
    buildVersion: "mpython-0.8.7-alpha.3.20260511017",
    builtFrom: { blocksI18n: BLOCKS_I18N, snippets: BLOCKS_SNIPPETS, bundle: APP_BUNDLE },
    groups: [...byGroup.keys()].sort(),
    groupCounts: Object.fromEntries([...byGroup.entries()].map(([k, v]) => [k, v.length])),
    stats,
  };
  writeFileSync(resolve(DATA_DIR, "catalog.meta.json"), JSON.stringify(meta, null, 2));

  console.error("[catalog] stats:", JSON.stringify(stats));
  console.error(`[catalog] wrote catalog.{index,full,meta}.json to data/ (${index.length} blocks)`);
}

main();
