// tools/build-term-font.mjs — 生成 src/host/termFont.mjs（内嵌终端等宽 web 字体，纯数据模块）。
//
// 为什么内嵌：书签注入的是第三方 HTTPS 页面，外链字体会被站点 CSP(font-src) 拦、离线失效，
// 且不应依赖外部 URL。故把字体 base64 随包内联（@font-face/FontFace 的 data URL），加载失败时
// termFix 仍兜底裸 monospace。生成物已提交，本脚本提供可复现的再生成路径。
//
// 字体：JetBrains Mono 的 Latin 子集（为代码/终端设计，括号、0/O、1/l/I 区分度高），SIL OFL 1.1。
// 按 OFL 对「修改版（含子集化）」的要求，family 重命名为 'M3E Mono'，不沿用保留名 'JetBrains Mono'。
//
// 数据来源（择一）：
//   - 默认：联网从 Google Fonts 解析并下载 JetBrains Mono 的 latin 子集 woff2。
//   - 离线：设 M3E_TERM_FONT_WOFF2=/path/to.woff2 指向本地已子集化的 woff2。
//
// 运行：bun run build:term-font   （见 package.json）

import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";

const FAMILY = "M3E Mono"; // 重命名后的 family（不含引号）
const OUT = new URL("../src/host/termFont.mjs", import.meta.url);
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";

/** 取得 woff2 字节：优先本地路径，否则联网解析 Google Fonts 的 latin 子集。 */
async function getWoff2() {
  const local = process.env.M3E_TERM_FONT_WOFF2;
  if (local) {
    console.log("[term-font] 使用本地 woff2：" + local);
    return new Uint8Array(await readFile(local));
  }
  console.log("[term-font] 联网解析 Google Fonts（JetBrains Mono latin 子集）…");
  const cssUrl = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&display=swap";
  const css = await (await fetch(cssUrl, { headers: { "User-Agent": UA } })).text();
  // 取 `/* latin */` 区块（仅基础拉丁 + Latin-1）后的 woff2 URL。
  const block = css.split("/* latin */")[1] || "";
  const m = block.match(/url\((https:\/\/[^)]+\.woff2)\)/);
  if (!m) throw new Error("未能从 css2 响应里解析出 latin 子集的 woff2 URL");
  console.log("[term-font] 下载 " + m[1]);
  const buf = await (await fetch(m[1], { headers: { "User-Agent": UA } })).arrayBuffer();
  return new Uint8Array(buf);
}

const bytes = await getWoff2();
const b64 = Buffer.from(bytes).toString("base64");
console.log(`[term-font] woff2 ${bytes.length}B → base64 ${b64.length} 字符`);

const out = `// src/host/termFont.mjs — 内嵌终端等宽 web 字体（纯数据模块，**自动生成，勿手改**）。
//
// 由 tools/build-term-font.mjs 生成（见其注释：为何内嵌、字体来源、再生成方式）。
// 字体：JetBrains Mono 的 Latin 子集，SIL OFL 1.1（见 src/host/JetBrainsMono-OFL.txt）。
// 按 OFL 对子集化版本的要求，family 重命名为 'M3E Mono'。termFix 用 FontFace API 注册它，
// 并以 \`.xterm{font-family:FONT_FAMILY !important}\` 压站点样式；末尾兜底裸 monospace。

// 含引号、带 monospace 兜底的字体栈（写进 CSS / xterm options.fontFamily）。
export const FONT_FAMILY = "'${FAMILY}', monospace";

// 纯字体名（不含引号）：FontFace 构造器与 document.fonts.load() 用。
export const FONT_FACE_NAME = "${FAMILY}";

// Latin 子集 woff2，base64。termFix 拼成 data URL 交给 FontFace。
export const FONT_WOFF2_B64 =
  "${b64}";
`;

await writeFile(OUT, out);
console.log("[term-font] 已写入 " + OUT.pathname + ` (${out.length} 字符)`);
