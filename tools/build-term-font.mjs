// tools/build-term-font.mjs — 生成 src/host/termFont.mjs（内嵌等宽 web 字体，纯数据模块）。
//
// 为什么内嵌：书签注入的是第三方 HTTPS 页面，外链字体会被站点 CSP(font-src) 拦、离线失效，
// 且不应依赖外部 URL。故把字体 base64 随包内联（FontFace 的 data URL）。加载失败时仍兜底
// 裸 monospace。生成物已提交，本脚本提供可复现的再生成路径。
//
// 字体：Noto Sans Mono CJK SC Regular（覆盖代码、西文符号、中文注释/串口输出），SIL OFL 1.1。
// 按 OFL 对「修改版（含格式转换/子集化）」的要求，family 重命名为 'M3E Mono'，不沿用保留名。
//
// 数据来源（择一）：
//   - M3E_TERM_FONT_WOFF2=/path/to.woff2：直接使用本地已转换/子集化的 woff2。
//   - M3E_TERM_FONT_INPUT=/path/to.otf|ttf|ttc：用 fontTools 转 woff2；TTC 默认抽取
//     "Noto Sans Mono CJK SC"（可用 M3E_TERM_FONT_FACE 覆盖）。
//   - 默认：尝试系统 Noto CJK TTC（/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc）。
//
// 运行：bun run build:term-font   （见 package.json）

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FAMILY = "M3E Mono"; // 重命名后的 family（不含引号）
const OUT = new URL("../src/host/termFont.mjs", import.meta.url);
const DEFAULT_INPUT = "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc";
const DEFAULT_FACE = "Noto Sans Mono CJK SC";

function convertWithFontTools(input, face) {
  const dir = mkdtempSync(join(tmpdir(), "m3e-term-font-"));
  const py = join(dir, "convert.py");
  const out = join(dir, "font.woff2");
  writeFileSync(py, `
from fontTools.ttLib import TTFont, TTCollection
from pathlib import Path
import sys

src = Path(sys.argv[1])
face = sys.argv[2]
out = Path(sys.argv[3])

def font_names(font):
    vals = set()
    for n in font["name"].names:
        if n.nameID in (1, 4, 16):
            try:
                vals.add(n.toUnicode())
            except Exception:
                pass
    return vals

if src.suffix.lower() == ".ttc":
    ttc = TTCollection(str(src))
    font = None
    for candidate in ttc.fonts:
        names = font_names(candidate)
        if face in names or (face + " Regular") in names:
            font = candidate
            break
    if font is None:
        raise SystemExit("TTC face not found: " + face)
else:
    font = TTFont(str(src))

font["name"].setName("${FAMILY}", 1, 3, 1, 0x409)
font["name"].setName("Regular", 2, 3, 1, 0x409)
font["name"].setName("${FAMILY} Regular", 4, 3, 1, 0x409)
font["name"].setName("${FAMILY}", 6, 3, 1, 0x409)
font.flavor = "woff2"
font.save(str(out))
`);
  try {
    execFileSync("uv", ["run", "--with", "fonttools", "--with", "brotli", "python", py, input, face, out], { stdio: "inherit" });
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function getWoff2() {
  const local = process.env.M3E_TERM_FONT_WOFF2;
  if (local) {
    console.log("[term-font] 使用本地 woff2：" + local);
    return new Uint8Array(await readFile(local));
  }
  const input = process.env.M3E_TERM_FONT_INPUT || (existsSync(DEFAULT_INPUT) ? DEFAULT_INPUT : "");
  if (!input) {
    throw new Error("缺少字体输入：设置 M3E_TERM_FONT_WOFF2=/path/to/font.woff2 或 M3E_TERM_FONT_INPUT=/path/to/NotoSansMonoCJKsc-Regular.otf");
  }
  const face = process.env.M3E_TERM_FONT_FACE || DEFAULT_FACE;
  console.log("[term-font] 使用 fontTools 转换：" + input + (input.endsWith(".ttc") ? " / " + face : ""));
  return convertWithFontTools(input, face);
}

const bytes = await getWoff2();
const b64 = Buffer.from(bytes).toString("base64");
console.log(`[term-font] woff2 ${bytes.length}B → base64 ${b64.length} 字符`);

const out = `// src/host/termFont.mjs — 内嵌等宽 web 字体（纯数据模块，**自动生成，勿手改**）。
//
// 由 tools/build-term-font.mjs 生成（见其注释：为何内嵌、字体来源、再生成方式）。
// 字体：Noto Sans Mono CJK SC Regular，SIL OFL 1.1（见 src/host/NotoSansCJK-OFL.txt）。
// 按 OFL 对格式转换/子集化版本的要求，family 重命名为 'M3E Mono'。宿主修复与面板
// 共用这个 family；末尾兜底裸 monospace。

// 含引号、带 monospace 兜底的字体栈（写进 CSS / xterm options.fontFamily / Ace）。
export const FONT_FAMILY = "'${FAMILY}', monospace";

// 纯字体名（不含引号）：FontFace 构造器与 document.fonts.load() 用。
export const FONT_FACE_NAME = "${FAMILY}";

// WOFF2，base64。host/font.mjs 拼成 data URL 交给 FontFace。
export const FONT_WOFF2_B64 =
  "${b64}";
`;

await writeFile(OUT, out);
console.log("[term-font] 已写入 " + OUT.pathname + ` (${out.length} 字符)`);
