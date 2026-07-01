// src/host/termFix.mjs — 修复 online.mpython.cn「右下角控制台 / 文件面板不显示」的站点 bug。
//
// 防腐层的一部分：仅此模块触碰 window.vm 的终端(xterm)与 $serial。与串口代理无关，
// 对原生 Chrome 用户同样是净改善。
//
// 逆向确认的三处站点 bug（叠加导致控制台彻底空白 + 文件列表不更新）：
//  1) 孤立：站点用 store mutation `resetTerm` 把 xterm `.open()` 到 #term/#terminal 元素上。
//     切换代码↔图形模式 / 折叠控制台会让 Vue 重建这些 DOM 节点，但站点**不会**在本地串口
//     模式下重挂 xterm，于是 xterm 仍指向已删除的旧节点（element 脱离文档）→ `term.write()`
//     成功却不可见，文件面板的渲染同样吊在这套时序上不更新。
//  2) 崩溃：站点的 `resetTerm` 在重建前会 `$serial.clearFn()`，其实现是 `this.$socket.emit(...)`，
//     而本地串口(Web Serial)模式没有 `$serial.$socket` → 抛 `reading 'emit' of undefined`，
//     所以站点自身也无法重挂。
//  3) 字体：`resetTerm` 建 xterm 时没指定 fontFamily，xterm 用默认 `courier-new,...,monospace`。
//     在某些系统（如 Linux/Firefox）上具名等宽字体会被 fontconfig 替换成比例字体且「匹配成功」，
//     于是字符测量元素按比例字体量出过宽的单元格、canvas 又按另一字体画窄字 → 每个字浮在过宽
//     格子里、字距散开（标点/方括号尤其明显）。实测唯有**裸通用关键字 `monospace`** 拿到真等宽。
//
// 修复：
//  - 孤立：临时 stub 掉会崩的 clearFn，走站点自己的 `resetTerm` 重挂到活节点（保留 onData 键盘绑定）。
//  - 字体：注入持久 `!important` CSS 把裸 `monospace` 钉到 .xterm 与隐藏的字符测量元素（修正单元格
//    宽度测量），同时把 `monospace` 写进 xterm options（canvas 画字依据），再按**真实测量字宽/行高**
//    重排（不用写死的 /8）。挂 MutationObserver 兜底：站点每次重建终端实例都重新套用字体。
//  - 全程 try/catch，绝不影响页面其余功能。
//
// 另加一处永久护栏：把 `$serial.clearFn` 包成「无 $socket 时空操作」。站点自身在夜间模式开关 /
// 模式切换时也会调 `resetTerm`→`clearFn`，本地串口模式下本会崩并把终端 dispose 后无法重建
// （正是「夜间模式常开 → 控制台出生即空白」的根因）；护栏让站点自己的 resetTerm 也不再崩。

// 字体钉死成内嵌的等宽 web 字体（'M3E Mono'，Noto Sans Mono CJK SC），末尾兜底裸 `monospace`。
// 实测（Linux/Firefox）：具名系统等宽字体（Courier New / DejaVu Sans Mono…）会被 fontconfig
// 替换成比例字体且「匹配成功」，于是永远轮不到字体栈末尾的 monospace → 字形窄、单元格宽 → 字散开。
// 内嵌字体（FontFace + data URL）不受 fontconfig 替换影响、canvas 也认，比裸 monospace 更整齐一致。
// 两条腿一起上才生效：① CSS（钉到 .xterm 与隐藏的字符测量元素）决定**单元格宽度**的测量；
// ② options.fontFamily 决定 canvas 渲染器**画字**用的字体（canvas 不读 CSS）。
import { ensureEmbeddedFont, FONT_FAMILY, FONT_SIZE } from "./font.mjs";

const MONO = FONT_FAMILY;
const TERM_TYPES = ["term", "terminal"]; // term=控制台，terminal=REPL 终端
const FONT_CSS_ID = "m3e-term-font";

/** xterm「孤立」判定：实例存在，但其 DOM 已脱离文档（被 Vue 重建挤掉）。 */
function isOrphan(doc, term) {
  if (!term) return false; // 尚未创建：交给站点自己首建，不算孤立
  const el = term.element;
  return !el || !doc.contains(el);
}

/**
 * 幂等装载终端字体：① 用 FontFace API 注册内嵌等宽字体（惯用做法，data URL 不走外链/CSP 友好）；
 * ② 注入最小 CSS 把字体钉到 .xterm 及 xterm 自建的字符测量元素上（只能用 `!important` 压站点样式，
 * 无非 CSS 替代）。返回字体的 load Promise（或 null）供就绪后重建图集。
 */
function ensureFont(doc) {
  const loading = ensureEmbeddedFont(doc);
  if (!doc.getElementById(FONT_CSS_ID)) {
    const st = doc.createElement("style");
    st.id = FONT_CSS_ID;
    st.textContent = ".xterm,.xterm *,.xterm-helper-textarea,.xterm-char-measure-element{font-family:" + MONO + " !important}";
    (doc.head || doc.documentElement).appendChild(st);
  }
  return loading;
}

/** 把等宽字体写进 xterm options（canvas 画字依据），跨版本兼容 options/setOption。 */
function setTermFont(term) {
  try {
    if (term.options) { term.options.fontFamily = MONO; term.options.fontSize = FONT_SIZE; }
    else if (typeof term.setOption === "function") { term.setOption("fontFamily", MONO); term.setOption("fontSize", FONT_SIZE); }
  } catch {}
}

/** 重测真实字宽/行高，按之 resize（不再用写死的 /8），并重绘以重建字形图集。 */
function applyGeometry(term, el) {
  try { term._core._charSizeService.measure(); } catch {}
  const css = term._core && term._core._charSizeService;
  const cw = (css && css.width) || 8;
  const chh = (css && css.height) || 18;
  const cols = Math.max(2, Math.floor(el.offsetWidth / cw) - 1);
  const rows = Math.max(2, Math.floor(el.offsetHeight / chh));
  try { term.resize(cols, rows); } catch {}
  try { term.refresh(0, rows - 1); } catch {}
}

/**
 * 永久护栏：让 `$serial.clearFn` 在无 `$socket` 时安全空操作。
 * 站点实现是 `this.$socket.emit("clearFn")`，`$socket` 仅云端 socket.io 模式存在；
 * 浏览器 Web Serial（USB 直连）模式下会抛 `reading 'emit' of undefined`，使站点自身的
 * `resetTerm`（夜间模式开关 / 模式切换触发）在 dispose 终端后中断、无法重建。幂等。
 */
function guardClearFn(vm) {
  const ser = vm.$serial;
  if (!ser || typeof ser.clearFn !== "function" || ser.__m3eClearGuarded) return;
  const orig = ser.clearFn;
  ser.clearFn = function (...a) {
    if (!this.$socket) return; // 无 socket：空操作而非抛错
    return orig.apply(this, a);
  };
  ser.__m3eClearGuarded = true;
}

/** 套用等宽字体 + 真实尺寸重排；仅当 xterm 孤立时才按站点方式重建到活节点。 */
function remount(vm, doc, termType) {
  const store = vm.$store;
  const el = doc.getElementById(termType);
  if (!el) return null; // 目标容器还没出现，等下次 observer 触发

  ensureFont(doc); // 测量元素的字体（决定单元格宽度）由这条全局 CSS + 内嵌字体持久钉住

  let term = store.state[termType];
  // 孤立（xterm 指向已删除的 DOM）才需要重建：临时屏蔽会崩的 clearFn，走站点自己的 resetTerm。
  if (!term || isOrphan(doc, term)) {
    const ser = vm.$serial;
    const origClear = ser && ser.clearFn;
    if (ser) ser.clearFn = function () {};
    try { store.commit("resetTerm", { termType }); }
    catch { /* resetTerm 内部异常不外抛 */ }
    finally { if (ser) ser.clearFn = origClear; }
    term = store.state[termType];
  }
  if (!term) return null;

  setTermFont(term);       // canvas 画字用等宽
  applyGeometry(term, el); // 按真实字宽重排 + 重建图集
  return term;
}

/**
 * 安装控制台自愈。检测到任一终端孤立（或首次强制套用等宽字体）就重挂。
 * @param {object} caps detectHost() 返回的能力对象（含 vm/store/doc）
 * @returns {{ heal():void, stop():void }}
 */
export function installTerminalFix(caps) {
  const vm = caps?.vm;
  const doc = caps?.doc || globalThis.document;
  if (!vm || !vm.$store || typeof vm.$Terminal !== "function") {
    return { heal() {}, stop() {} }; // 站点结构不符：安静降级
  }

  let healedFont = false; // 首次无论是否孤立，都重挂一遍以套用等宽字体

  // 记录每个终端「被我们强制过等宽字体的那个 xterm 实例」。站点自身的 resetTerm
  // （连接握手 / 夜间模式 / 模式切换触发，且现在因 clearFn 护栏会成功重建）会换上一个
  // 新实例并丢回默认比例字体；只要 state[t] 不再是我们记录的实例，就重挂一次。
  const forced = new Map(); // termType → 上次强制过等宽字体的 xterm 实例

  // 永久护栏：先让站点自身的 resetTerm 在本地串口模式下不再崩（夜间模式/模式切换路径）。
  try { guardClearFn(vm); } catch {}

  // 需要重挂：未建→否；孤立→是；或与我们强制过的不是同一实例（站点重建了，字体被换回比例字体）→是。
  function needsHeal(t, term) {
    if (!term) return false;
    if (isOrphan(doc, term)) return true;
    return !healedFont || forced.get(t) !== term;
  }

  function heal() {
    try {
      const state = vm.$store.state;
      for (const t of TERM_TYPES) {
        if (needsHeal(t, state[t])) {
          const inst = remount(vm, doc, t);
          if (inst) forced.set(t, inst);
        }
      }
      healedFont = true;
    } catch {
      /* 自愈失败不影响其余功能 */
    }
  }

  // 内嵌字体就绪后，对当前在用的终端重测字宽并重建图集（data URL 通常瞬时，但 FontFace 就绪是
  // 异步：首次测量可能用兜底 monospace，加载完需按真实字形重排，否则 canvas 图集留着兜底字形）。
  function reapplyFont() {
    try {
      const state = vm.$store.state;
      for (const t of TERM_TYPES) {
        const term = state[t], el = doc.getElementById(t);
        if (term && el && !isOrphan(doc, term)) { setTermFont(term); applyGeometry(term, el); }
      }
    } catch {}
  }

  // 防抖：DOM 抖动（模式切换会触发大量 mutation）后只跑一次。
  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; heal(); }, 200);
  };

  // 首次：等布局稳定后套用等宽字体并确保已挂载。
  schedule();
  // 内嵌字体就绪后再重排一次（确保 canvas 图集按真实字形重建）。
  try { ensureFont(doc)?.then(() => reapplyFont(), () => {}); } catch {}

  // 兜底：监听 DOM 变化，一旦终端被挤成孤立就自动重挂。
  let observer = null;
  try {
    observer = new MutationObserver(() => {
      const state = vm.$store.state;
      if (TERM_TYPES.some((t) => needsHeal(t, state[t]))) schedule();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  } catch {
    /* 无 MutationObserver 时退化为仅首次修复 */
  }

  return {
    heal,
    stop() {
      try { observer?.disconnect(); } catch {}
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
