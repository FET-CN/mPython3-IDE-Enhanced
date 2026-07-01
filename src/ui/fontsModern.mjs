// src/ui/fontsModern.mjs — modern 主题内嵌字体激活器。
//
// 书签注入的是第三方 HTTPS 页面，外链字体会被站点 CSP 拦、离线失效，故字体随包 base64 内联
// （见 fontsModern.generated.mjs，由 tools/build-fonts.modern.mjs 生成）。这里用 FontFace API 把
// 它们注册进 panel 所在 document（Shadow DOM 复用 document 字体）。加载失败/无字体数据时**优雅降级**：
// tailwind.modern.css 的 --font-sans/--font-mono 末尾兜底 system-ui / 等宽，观感退化但不报错。

import { FONTS } from "./fontsModern.generated.mjs";

/** 幂等地把内嵌 modern 字体注册进 doc。空数据或不支持 FontFace 时安静 no-op。 */
export function activateModernFonts(doc = globalThis.document) {
  try {
    if (!doc || doc.__m3eModernFonts) return;
    if (typeof FontFace !== "function" || !doc.fonts || typeof doc.fonts.add !== "function") return;
    if (!Array.isArray(FONTS) || !FONTS.length) return;
    doc.__m3eModernFonts = true;
    for (const f of FONTS) {
      if (!f?.b64 || !f?.family) continue;
      try {
        const ff = new FontFace(
          f.family,
          "url(data:font/woff2;base64," + f.b64 + ") format('woff2')",
          { style: f.style || "normal", weight: String(f.weight || "400"), display: "swap" },
        );
        doc.fonts.add(ff);
        ff.load().catch(() => {});
      } catch {}
    }
  } catch {}
}
