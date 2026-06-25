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
//  3) 字体：`resetTerm` 建 xterm 时没指定 fontFamily，xterm 继承页面全局「思源黑体 16px」
//     （比例字体）→ 西文被撑开、字偏大、标点出格被截。canvas/dom 两种渲染器都中招。
//
// 修复：检测到终端孤立时，临时 stub 掉 clearFn、用包装的构造器强制等宽字体，走站点自己的
// `resetTerm` 重挂（保留 onData 键盘绑定），再重测字宽 + resize。挂 MutationObserver 兜底，
// 之后每次模式切换/面板重建都自动自愈。全程 try/catch，绝不影响页面其余功能。

// 站点全局是比例字体（思源黑体），这里钉死一组跨平台等宽字体，xterm 才能按固定单元格正确排版。
const MONO = "'DejaVu Sans Mono', 'Cascadia Mono', 'Consolas', 'Menlo', 'Courier New', monospace";
const FONT_SIZE = 14;
const TERM_TYPES = ["term", "terminal"]; // term=控制台，terminal=REPL 终端

/** xterm「孤立」判定：实例存在，但其 DOM 已脱离文档（被 Vue 重建挤掉）。 */
function isOrphan(doc, term) {
  if (!term) return false; // 尚未创建：交给站点自己首建，不算孤立
  const el = term.element;
  return !el || !doc.contains(el);
}

/** 用站点自己的 resetTerm 重挂某个终端，并强制等宽字体 + 重测字宽。 */
function remount(vm, doc, termType) {
  const store = vm.$store;
  const ser = vm.$serial;
  const OrigTerm = vm.$Terminal;
  if (typeof OrigTerm !== "function") return null;

  const el = doc.getElementById(termType);
  if (!el) return null; // 目标容器还没出现，等下次 observer 触发

  const origClear = ser && ser.clearFn;
  // 1) 本地串口模式没有 $socket，clearFn 会崩 → 临时屏蔽。
  if (ser) ser.clearFn = function () {};
  // 2) 包构造器：强制等宽字体 + 固定字号，避免继承页面比例字体。
  vm.$Terminal = function (opts) {
    return new OrigTerm(Object.assign({}, opts, { fontFamily: MONO, fontSize: FONT_SIZE }));
  };
  try {
    store.commit("resetTerm", { termType });
  } catch {
    /* resetTerm 内部异常不外抛 */
  } finally {
    vm.$Terminal = OrigTerm;
    if (ser) ser.clearFn = origClear;
  }

  // 3) 重测字宽 + 按真实尺寸 resize，确保字形图集按新字体重建。
  const term = store.state[termType];
  if (term && el) {
    try { term._core._charSizeService.measure(); } catch {}
    const r = el.offsetWidth / 8;
    const cols = Math.max(2, Math.floor(r > 170 ? r - 18 : r > 130 ? r - 16 : r > 100 ? r - 12 : r > 60 ? r - 8 : r - 4));
    const rows = Math.max(2, Math.floor(30 / (577 / el.offsetHeight)));
    try { term.resize(cols, rows); } catch {}
    try { term.refresh(0, rows - 1); } catch {}
  }
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

  function heal() {
    try {
      const state = vm.$store.state;
      for (const t of TERM_TYPES) {
        const term = state[t];
        if (!healedFont || isOrphan(doc, term)) remount(vm, doc, t);
      }
      healedFont = true;
    } catch {
      /* 自愈失败不影响其余功能 */
    }
  }

  // 防抖：DOM 抖动（模式切换会触发大量 mutation）后只跑一次。
  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; heal(); }, 200);
  };

  // 首次：等布局稳定后套用等宽字体并确保已挂载。
  schedule();

  // 兜底：监听 DOM 变化，一旦终端被挤成孤立就自动重挂。
  let observer = null;
  try {
    observer = new MutationObserver(() => {
      const state = vm.$store.state;
      if (TERM_TYPES.some((t) => isOrphan(doc, state[t]))) schedule();
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
