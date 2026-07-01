// tools/build-fonts.modern.mjs — 生成 src/ui/fontsModern.generated.mjs（modern 主题内嵌
// 字体，纯数据模块，**自动生成，勿手改**）。同 build-term-font.mjs 的理由：书签注入第三方
// HTTPS 页，外链字体会被站点 CSP 拦、离线失效；故把子集化后的 woff2 base64 随包内联，交给
// FontFace 注册。生成物已提交，**不入 `bun run build`**（同 build:term-font）；modern 未激活
// 时根本不加载本模块（走独立 dist/modern.min.js 懒加载）。加载失败时字体栈末尾兜底 system-ui /
// monospace，优雅降级。
//
// 三族两重：
//   - M3E Geist        400/500 ← Geist Regular/Medium（拉丁，vercel/geist-font，OFL）
//   - M3E Sarasa       400/500 ← Sarasa Gothic SC Regular/Medium（中文，be5invis/Sarasa-Gothic，OFL）
//   - M3E Sarasa Mono  400/500 ← Sarasa Mono SC Regular/Medium（等宽中文，同上）
// 按 OFL 对子集/转换版的要求 **重命名 family**（不沿用保留名），OFL 全文随包提交
// （src/ui/OFL.txt / src/ui/OFL-Sarasa.txt）。
//
// 数据来源（择一，缺失则从上游 release 下载）：
//   - M3E_MODERN_GEIST_DIR=/path  ：本地含 Geist-*.ttf 的目录（递归查找）。
//   - M3E_MODERN_SARASA_DIR=/path ：本地含 SarasaGothicSC-*.ttf / SarasaMonoSC-*.ttf 的目录。
// CJK 子集字符集来自 tools/data/cjk-subset.txt（3500 通用规范一级字 + ASCII + CJK 标点，committed）。
//
// 运行：bun run build:fonts:modern

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const SUBSET_TXT = join(ROOT, "tools/data/cjk-subset.txt");
const OUT = join(ROOT, "src/ui/fontsModern.generated.mjs");
const CACHE = join(ROOT, "node_modules/.cache/m3e-fonts");

const SARASA_VER = "1.0.40";
const GEIST_VER = "v1.7.2";

// 下载源：Geist 是 zip；Sarasa 子族是 7z。两个 Sarasa 子族共用 M3E_MODERN_SARASA_DIR。
const SOURCES = {
  geist: {
    env: "M3E_MODERN_GEIST_DIR",
    url: `https://github.com/vercel/geist-font/releases/download/${GEIST_VER}/geist-font-${GEIST_VER}.zip`,
    kind: "zip",
  },
  gothicsc: {
    env: "M3E_MODERN_SARASA_DIR",
    url: `https://github.com/be5invis/Sarasa-Gothic/releases/download/v${SARASA_VER}/SarasaGothicSC-TTF-Unhinted-${SARASA_VER}.7z`,
    kind: "7z",
  },
  monosc: {
    env: "M3E_MODERN_SARASA_DIR",
    url: `https://github.com/be5invis/Sarasa-Gothic/releases/download/v${SARASA_VER}/SarasaMonoSC-TTF-Unhinted-${SARASA_VER}.7z`,
    kind: "7z",
  },
};

// family 保持一致、仅 weight 区分（FontFace 按 weight 描述符匹配）；mode 决定子集范围。
// 只取两重：Regular(400) + 一个较重的字重跨 "500 900"，让 UI 的 font-medium/semibold/bold 都映射
// 到真实较重字形（无合成加粗）。Geist 有 Medium；Sarasa 无 Medium，用 SemiBold 作为较重字重。
const SPECS = [
  { family: "M3E Geist",       weight: "400",     sub: "Regular",  src: "geist",    match: /Geist-?Regular\.[ot]tf$/i,       mode: "latin" },
  { family: "M3E Geist",       weight: "500 900", sub: "Medium",   src: "geist",    match: /Geist-?Medium\.[ot]tf$/i,        mode: "latin" },
  { family: "M3E Sarasa",      weight: "400",     sub: "Regular",  src: "gothicsc", match: /SarasaGothicSC-Regular\.ttf$/i,  mode: "cjk" },
  { family: "M3E Sarasa",      weight: "500 900", sub: "SemiBold", src: "gothicsc", match: /SarasaGothicSC-SemiBold\.ttf$/i, mode: "cjk" },
  { family: "M3E Sarasa Mono", weight: "400",     sub: "Regular",  src: "monosc",   match: /SarasaMonoSC-Regular\.ttf$/i,    mode: "cjk" },
  { family: "M3E Sarasa Mono", weight: "500 900", sub: "SemiBold", src: "monosc",   match: /SarasaMonoSC-SemiBold\.ttf$/i,   mode: "cjk" },
];

const walk = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

/** Resolve a source to a directory of extracted font files (env dir, or download+extract to cache). */
const resolvedSources = new Map();
function resolveSource(key) {
  if (resolvedSources.has(key)) return resolvedSources.get(key);
  const src = SOURCES[key];
  const envDir = process.env[src.env];
  if (envDir && existsSync(envDir)) {
    console.log(`[fonts:modern] ${key}: 使用本地目录 ${envDir}`);
    resolvedSources.set(key, envDir);
    return envDir;
  }
  const dir = join(CACHE, key);
  if (existsSync(dir) && walk(dir).length) {
    console.log(`[fonts:modern] ${key}: 命中缓存 ${dir}`);
    resolvedSources.set(key, dir);
    return dir;
  }
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, "archive." + src.kind);
  console.log(`[fonts:modern] ${key}: 下载 ${src.url}`);
  const buf = execFileSync("curl", ["-fsSL", src.url], { maxBuffer: 1 << 30 });
  writeFileSync(archive, buf);
  if (src.kind === "zip") execFileSync("unzip", ["-oq", archive, "-d", dir]);
  else execFileSync("7z", ["x", "-y", "-o" + dir, archive], { stdio: "ignore" });
  rmSync(archive, { force: true });
  resolvedSources.set(key, dir);
  return dir;
}

function findFont(spec) {
  const dir = resolveSource(spec.src);
  const hit = walk(dir).find((p) => spec.match.test(p));
  if (!hit) throw new Error(`未找到字体 ${spec.family} ${spec.sub}（源 ${spec.src}，正则 ${spec.match}）。请设置 ${SOURCES[spec.src].env}`);
  return hit;
}

// 一次性用 fontTools 子集化 + 改名 + 转 woff2，产出所有 face 的 woff2 到临时目录。
function buildAll(jobs) {
  const dir = mkdtempSync(join(tmpdir(), "m3e-fonts-"));
  const py = join(dir, "build.py");
  const manifest = join(dir, "jobs.json");
  writeFileSync(manifest, JSON.stringify(jobs.map((j, i) => ({ ...j, out: join(dir, `f${i}.woff2`) }))));
  writeFileSync(py, `
import json, sys
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

jobs = json.load(open(sys.argv[1]))
subset_text = open(sys.argv[2], encoding="utf-8").read()

for j in jobs:
    font = TTFont(j["input"])
    opts = Options()
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.recalc_bounds = True
    opts.drop_tables = []
    # 关 hinting：丢掉 fpgm/prep/cvt/gasp 及 glyf 指令。web 字体不需要 TrueType 指令，
    # 且源本就是 Unhinted 构建；保留会让子集产物残留畸形 gasp（末尾缺 0xFFFF 哨兵）与
    # maxp.maxZones，被 Firefox OTS 丢表 → 整字体加载失败。
    opts.hinting = False
    opts.layout_features = ["*"] if j["mode"] == "latin" else ["ccmp", "locl", "calt", "liga", "kern", "vert", "vrt2"]
    opts.glyph_names = False
    opts.notdef_outline = True
    ss = Subsetter(options=opts)
    if j["mode"] == "latin":
        # 全拉丁：Basic Latin + Latin-1 + Latin Ext-A/B + 常用标点/符号 + 制表。
        ranges = list(range(0x0020, 0x0250)) + list(range(0x2010, 0x2050)) + list(range(0x2190, 0x2200))
        ss.populate(unicodes=ranges)
    else:
        ss.populate(text=subset_text)
    ss.subset(font)
    # 保险：即便 hinting 关了，也显式清掉 TrueType 指令表（glyf 字体才有；CFF 的 Geist 无此表）
    # 并把 maxp 指令相关字段归零 —— 杜绝 OTS 报 "Bad maxZones" / "gasp last record" 而丢表。
    if "glyf" in font:
        for t in ("gasp", "fpgm", "prep", "cvt "):
            if t in font:
                del font[t]
        mp = font["maxp"]
        # maxZones 合法值为 1（不使用 Twilight Zone）或 2；0 会被 OTS 判非法而丢 maxp。
        if hasattr(mp, "maxZones"):
            mp.maxZones = 1
        for attr in ("maxTwilightPoints", "maxStorage",
                     "maxFunctionDefs", "maxInstructionDefs",
                     "maxStackElements", "maxSizeOfInstructions"):
            if hasattr(mp, attr):
                setattr(mp, attr, 0)
    # 重命名 family（OFL 要求），weight 由 FontFace 描述符区分。
    fam, sub = j["family"], j["sub"]
    name = font["name"]
    name.setName(fam, 1, 3, 1, 0x409)
    name.setName(sub, 2, 3, 1, 0x409)
    name.setName(f"{fam} {sub}", 4, 3, 1, 0x409)
    name.setName(f"{fam}-{sub}".replace(" ", ""), 6, 3, 1, 0x409)
    name.setName(fam, 16, 3, 1, 0x409)
    name.setName(sub, 17, 3, 1, 0x409)
    font.flavor = "woff2"
    font.save(j["out"])
    print(f"[fonts:modern] {fam} {sub}: {j['mode']} 子集 -> woff2")
`);
  try {
    execFileSync("uv", ["run", "--with", "fonttools", "--with", "brotli", "python", py, manifest, SUBSET_TXT], { stdio: "inherit" });
    return jobs.map((j, i) => new Uint8Array(readFileSync(join(dir, `f${i}.woff2`))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (!existsSync(SUBSET_TXT)) throw new Error("缺少 " + SUBSET_TXT);
const jobs = SPECS.map((s) => ({ input: findFont(s), family: s.family, sub: s.sub, mode: s.mode }));
const woff2s = buildAll(jobs);

const faces = SPECS.map((s, i) => {
  const b64 = Buffer.from(woff2s[i]).toString("base64");
  console.log(`[fonts:modern] ${s.family} ${s.weight}: woff2 ${(woff2s[i].length / 1024).toFixed(0)}KB -> base64 ${b64.length}`);
  return { family: s.family, weight: s.weight, b64 };
});
const total = woff2s.reduce((a, b) => a + b.length, 0);
console.log(`[fonts:modern] 合计 woff2 ${(total / 1024 / 1024).toFixed(2)}MB`);

const banner =
  "// src/ui/fontsModern.generated.mjs — GENERATED by tools/build-fonts.modern.mjs. 勿手改。\n" +
  "// modern 主题内嵌字体（Geist + Sarasa Gothic SC + Sarasa Mono SC，子集化 woff2 base64）。\n" +
  "// 均为 SIL OFL 1.1；按 OFL 对子集/转换版要求已重命名 family。见 src/ui/OFL.txt / OFL-Sarasa.txt。\n" +
  "// FONTS: [{ family, weight, b64 }]；由 src/ui/fontsModern.mjs 经 FontFace 注册，失败优雅降级。\n";
const body = faces
  .map((f) => `  { family: ${JSON.stringify(f.family)}, weight: ${JSON.stringify(String(f.weight))}, b64:\n    ${JSON.stringify(f.b64)} },`)
  .join("\n");
writeFileSync(OUT, `${banner}export const FONTS = [\n${body}\n];\n`);
console.log(`[fonts:modern] 已写入 ${OUT}`);

