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
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
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
  // Optional: per-board toolbox visibility snapshot (refresh via `dump:toolbox`).
  const vis = resolve(DATA_DIR, "toolbox.visible.json");
  if (existsSync(vis)) copyFileSync(vis, resolve(DIST_DIR, "toolbox.visible.json"));
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

/** The address-bar bootstrap, frozen into the user's bookmark at install time.
 *  Re-clicking a bookmark for an already-open panel just refocuses it (no dead
 *  return); otherwise it pins the data base, a loader version, and the build rev,
 *  then injects the runtime. `version`/`rev` are baked in so the runtime can spot
 *  a stale bookmark and show which build it came from. */
function bootstrapSrc(base, version, rev) {
  return `(function(){if(window.__m3e__){try{window.__m3e__.focus&&window.__m3e__.focus()}catch(e){}return}window.__M3E_BASE__=${JSON.stringify(base)};window.__M3E_BOOT_VERSION__=${JSON.stringify(version)};window.__M3E_BOOT_REV__=${JSON.stringify(rev)};var s=document.createElement('script');s.src=${JSON.stringify(base + "/main.min.js")}+'?t='+Date.now();s.onerror=function(){alert('加载 AI 助手失败，请检查托管地址: '+${JSON.stringify(base)})};document.body.appendChild(s)})();`;
}

/** Short commit hash (with a `+` suffix when the tree is dirty) for human-readable
 *  versioning — shown in build/runtime logs and the stale-bookmark notice. Falls
 *  back to "dev" outside a git checkout. NOTE: the rev intentionally does NOT feed
 *  LOADER_VERSION (below), so ordinary commits don't falsely flag bookmarks. */
function gitRev() {
  try {
    const rev = execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (!rev) return "dev";
    let dirty = "";
    try { execSync("git diff --quiet && git diff --cached --quiet", { cwd: ROOT, stdio: "ignore" }); }
    catch { dirty = "+"; }
    return rev + dirty;
  } catch { return "dev"; }
}
const BUILD_REV = gitRev();

// LOADER_VERSION = hash of the bootstrap LOGIC ONLY (base/version/rev blanked
// out), so it bumps exactly when the loader template itself changes — i.e. when
// an installed bookmark goes stale and needs re-dragging. main.min.js is stamped
// with this same value; the runtime compares the two and nudges on a mismatch.
const LOADER_VERSION = createHash("sha256")
  .update(bootstrapSrc("__BASE__", "__VER__", "__REV__"))
  .digest("hex").slice(0, 10);

function loader() {
  return "javascript:" + encodeURI(bootstrapSrc(BASE, LOADER_VERSION, BUILD_REV));
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
<p>面板已打开时再次点击书签 = 唤回 / 聚焦面板（不会重复加载）。日后若提示「书签为旧版本」，回到本页重新拖拽一次即可更新。</p>
</html>`;
}

async function main() {
  assembleData();
  const out = await bundle();
  // Stamp the runtime with the current loader version + build rev so it can detect
  // a stale bookmark (whose baked __M3E_BOOT_VERSION__ predates LOADER_VERSION).
  writeFileSync(out, `window.__M3E_LOADER_VERSION__=${JSON.stringify(LOADER_VERSION)};window.__M3E_BUILD_REV__=${JSON.stringify(BUILD_REV)};\n` + readFileSync(out, "utf8"));
  const size = existsSync(out) ? (statSync(out).size / 1024).toFixed(0) : "?";
  const bm = loader();
  writeFileSync(resolve(DIST_DIR, "bookmarklet.txt"), bm);
  let kb = "?";
  try { kb = JSON.parse(readFileSync(resolve(DIST_DIR, "catalog.index.json"))).length; } catch {}
  writeFileSync(resolve(DIST_DIR, "install.html"), installPage(bm, BASE, kb));
  console.error(`[bookmarklet] main.min.js ${size}KB; base=${BASE}; rev=${BUILD_REV}; loader=${LOADER_VERSION}; → dist/{bookmarklet.txt,install.html}`);
}

main();
