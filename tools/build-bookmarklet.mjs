// tools/build-bookmarklet.mjs — Assemble the hostable dist/ and emit the loader.
// Copies the COMMITTED data (catalog + knowledge + few-shot seeds) into dist/,
// bundles src/main.mjs → dist/main.min.js, and writes the address-bar loader +
// install page. Needs NO private build-time data — a fresh clone can run this.
//
//   dist/catalog.*.json   — copied from data/ (committed)
//   dist/knowledge/**     — copied from data/ (committed)
//   dist/fewshot-seeds.json — copied from tools/data/ (committed source)
//   dist/main.min.js      — bundled runtime
//   dist/bookmarklet.txt  — the javascript: snippet to paste in the address bar
//   dist/install.html     — drag-to-bookmark install page

import {
  writeFileSync, readFileSync, existsSync, statSync, mkdirSync, cpSync, copyFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DIST_DIR, DATA_DIR, ROOT } from "./lib/paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Where dist/ will be hosted (GitHub Pages / jsDelivr / local server). Override via env.
const BASE = (process.env.M3E_HOST_BASE || "http://localhost:8080").replace(/\/+$/, "");

/** Copy the committed data (catalog + knowledge + seeds) into dist/ for hosting. */
function assembleData() {
  mkdirSync(DIST_DIR, { recursive: true });
  for (const f of ["catalog.index.json", "catalog.full.json", "catalog.meta.json"]) {
    const src = resolve(DATA_DIR, f);
    if (!existsSync(src)) throw new Error(`缺少 ${src}（先运行 build:catalog，或确认已 clone data/）`);
    copyFileSync(src, resolve(DIST_DIR, f));
  }
  cpSync(resolve(DATA_DIR, "knowledge"), resolve(DIST_DIR, "knowledge"), { recursive: true });
  copyFileSync(
    resolve(__dirname, "data/fewshot-seeds.json"),
    resolve(DIST_DIR, "fewshot-seeds.json"),
  );
}

async function bundle() {
  const out = resolve(DIST_DIR, "main.min.js");
  const res = await Bun.build({
    entrypoints: [resolve(ROOT, "src/main.mjs")],
    outdir: DIST_DIR,
    naming: "main.min.js",
    minify: true,
    target: "browser",
    format: "iife",
  });
  if (!res.success) {
    for (const m of res.logs) console.error(m);
    throw new Error("bun build 失败");
  }
  return out;
}

function loader() {
  // tiny bootstrap: guard, set base, inject script
  const src = `(function(){if(window.__m3e__){return;}window.__M3E_BASE__=${JSON.stringify(BASE)};var s=document.createElement('script');s.src=${JSON.stringify(BASE + "/main.min.js")}+'?t='+Date.now();s.onerror=function(){alert('加载 AI 助手失败，请检查托管地址: '+${JSON.stringify(BASE)});};document.body.appendChild(s);})();`;
  return "javascript:" + encodeURI(src);
}

function installPage(bm, base, kb) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>mPython AI 图形化编程 — 安装</title>
<style>body{font:15px/1.6 system-ui;max-width:720px;margin:40px auto;padding:0 16px;color:#1c2530}
a.bm{display:inline-block;background:#2f7df6;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600}
code{background:#f0f3f7;padding:2px 6px;border-radius:6px}pre{background:#0f1722;color:#e6edf3;padding:12px;border-radius:10px;overflow:auto}</style>
<h1>mPython AI 图形化编程助手</h1>
<p>把下面的按钮拖到浏览器书签栏（或新建书签，地址粘贴 <code>bookmarklet.txt</code> 的内容）。然后打开 <code>online.mpython.cn</code>，点击该书签即可唤出 AI 面板。</p>
<p><a class="bm" href="${bm.replace(/"/g, "&quot;")}">⚡ mPython AI</a></p>
<h3>托管</h3>
<p>当前数据基址：<code>${base}</code>（共 ${kb} 个积木）。把整个 <code>dist/</code> 目录托管到该地址即可（本地可 <code>bunx serve dist -l 8080</code> 或 <code>python3 -m http.server 8080 -d dist</code>）。</p>
<h3>首次使用</h3>
<ol><li>点击书签，右侧出现面板。</li><li>点 ⚙ 填入 OpenAI 兼容的 Base URL / API Key / 模型，保存。</li><li>用中文描述需求 → 生成并应用。</li></ol>
</html>`;
}

async function main() {
  assembleData();
  const out = await bundle();
  const size = existsSync(out) ? (statSync(out).size / 1024).toFixed(0) : "?";
  const bm = loader();
  writeFileSync(resolve(DIST_DIR, "bookmarklet.txt"), bm);
  let kb = "?";
  try { kb = JSON.parse(readFileSync(resolve(DIST_DIR, "catalog.index.json"))).length; } catch {}
  writeFileSync(resolve(DIST_DIR, "install.html"), installPage(bm, BASE, kb));
  console.error(`[bookmarklet] main.min.js ${size}KB; base=${BASE}; → dist/{bookmarklet.txt,install.html}`);
}

main();
