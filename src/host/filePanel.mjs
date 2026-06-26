// src/host/filePanel.mjs — 在 online.mpython.cn **网页版**启用并补全站点的「文件管理面板」，
// 让掌控板（ESP32/MicroPython）设备文件可在浏览器里完整读写。
//
// 防腐层的一部分：仅此模块为「文件面板」目的触碰 window.vm / $serial / window.routerDesk。
// 所有「驯服站点」的 monkey-patch 都收纳在这一处，与既有代码隔离，便于将来持续 patch。
//
// 站点 bug / 设计（逆向确认，56d7.js）：
//  - 整块文件面板 `#mNoteCatalog`（含「电脑文件 / 掌控板文件」两 tab + ref=CElist）与开关
//    `drag-mNote` 都被 `isElectron ? <div…> : e._e()` 门控；`isElectron` 在浏览器恒 false，
//    故网页版**根本不渲染**——这是站点有意把文件管理只给桌面 Electron 版，并非数据为空。
//  - 设备文件操作在 web 版要么是空桩（getFileList→{data:[]}、getFileData→{data:""}），
//    要么委托 `window.routerDesk.*`（网页版 undefined → 崩）。
//
// 本模块四段（install 时按序）：
//  1) 集中护栏：window.routerDesk 设为「任意属性→no-op 函数」的 Proxy，一举中和所有（含将来新增）
//     routerDesk 崩溃点；再对少数不走 routerDesk 的 $serial Electron-only 方法装空操作护栏。
//  2) 启用渲染 + 接管导入（**实例级**补丁 mNoteBox 组件，不动全局）：
//     - isElectron computed 覆盖为恒 true（让面板渲染）；**不翻全局 state.isElectron**——顶部
//       「连接设备」按钮渲染条件为 `isElectron||connectName?隐藏`，翻全局会连带隐藏连接入口
//       （实测回归）；连接按钮与文件面板分属不同实例，故只补 mNoteBox 一个即两全。
//     - uploadFile 覆盖（站点原版依赖 Electron `$router.isDirectory/fileHandUpload`，网页版 $router
//       undefined 会崩）：改用原生 <input type=file> 选本机文件 → 写到设备目标目录 → 刷新列表。
//  3) 设备文件 $serial 覆盖（注册表驱动）：按第二参 mode==="mPythonList" 分流到串口、否则透传 orig。
//  4) 串口 REPL helpers + 互斥：经 serialProxy.link.exec 跑 MicroPython 单行命令，chr(2)/chr(3)
//     运行期哨兵框定输出，操作串行化且仅在 REPL 空闲（已连接 & 未跑程序）时执行。
//
// 「电脑文件 / project」tab 网页版已能用（站点走 $axios 后端），本模块不接管，仅在 mode 不是
// "mPythonList" 时透传站点原实现。

// ── 哨兵（运行期由 chr(2)/chr(3) 拼出，命令源码回显里不含完整哨兵、不会误匹配自身回显） ──
export const START = "\x02M3EFL"; // 运行期 chr(2)+'M3EFL'
export const END = "M3EFL\x03"; //   运行期 'M3EFL'+chr(3)
const DEVICE_MODE = "mPythonList"; // 站点用第二参区分「设备文件」vs 云端 "project"
const DIR_FLAG = 0x4000; //          os.ilistdir 的 type 位：& 0x4000 为目录
const WRITE_CHUNK = 256; //          每次写串口的原始字节数（base64 后约 344 字符/行）

// ───────────────────────── 纯函数（独立导出，便于 T0 单测） ─────────────────────────

export function normPath(p) {
  if (!p) return "/";
  return p.startsWith("/") ? p : "/" + p;
}
export function joinPath(base, name) {
  if (!base || base === "/") return "/" + name;
  return base.replace(/\/+$/, "") + "/" + name;
}
/** 转义成 Python 单引号字符串字面量（命令里统一用单引号包路径）。 */
export function pyStr(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}
/** 把一帧 print 输出包成命令：print(chr(2)+'M3EFL'+EXPR+'M3EFL'+chr(3))。 */
function framed(expr) {
  return "print(chr(2)+'M3EFL'+" + expr + "+'M3EFL'+chr(3))";
}
const OS = "__import__('os')";
const UB = "__import__('ubinascii')";

/** 列目录：os.ilistdir(path) → repr。 */
export function cmdList(path) {
  return "\r" + framed("repr([(n,t)for n,t,*_ in " + OS + ".ilistdir(" + pyStr(path) + ")])") + "\r";
}
/** 读文件：整文件 → base64（b2a_base64 末尾带换行，JS 侧 trim 后解码）。 */
export function cmdRead(path) {
  return "\r" + framed(UB + ".b2a_base64(open(" + pyStr(path) + ",'rb').read()).decode()") + "\r";
}
/** 写一块：首块 'wb' 截断、其后 'ab' 追加；回 OK 哨兵。 */
export function cmdWriteChunk(path, b64, first) {
  const mode = first ? "'wb'" : "'ab'";
  return (
    "\r" +
    "f=open(" + pyStr(path) + "," + mode + ");f.write(" + UB + ".a2b_base64('" + b64 + "'));f.close();" +
    framed("'OK'") +
    "\r"
  );
}
export function cmdRemove(path) { return "\r" + OS + ".remove(" + pyStr(path) + ");" + framed("'OK'") + "\r"; }
export function cmdRmdir(path) { return "\r" + OS + ".rmdir(" + pyStr(path) + ");" + framed("'OK'") + "\r"; }
export function cmdMkdir(path) { return "\r" + OS + ".mkdir(" + pyStr(path) + ");" + framed("'OK'") + "\r"; }
export function cmdRename(a, b) {
  return "\r" + OS + ".rename(" + pyStr(a) + "," + pyStr(b) + ");" + framed("'OK'") + "\r";
}

/** 解析 repr([('boot.py',32768),('lib',16384)]) → [{name,path,type}]。 */
export function parseList(text, path) {
  const out = [];
  const re = /\('((?:[^'\\]|\\.)*)',\s*(\d+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].replace(/\\(.)/g, "$1");
    const isDir = (parseInt(m[2], 10) & DIR_FLAG) !== 0;
    out.push({ name, path: joinPath(path, name), type: isDir ? "directory" : "file" });
  }
  return out;
}

/** base64 编码（浏览器 btoa 仅认 latin1，先把字节铺成二进制串）。 */
export function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return (typeof btoa === "function" ? btoa : (s) => Buffer.from(s, "binary").toString("base64"))(bin);
}
/** base64 解码为字节。 */
export function b64ToBytes(b64) {
  const s = String(b64).replace(/\s+/g, "");
  const bin = (typeof atob === "function" ? atob : (x) => Buffer.from(x, "base64").toString("binary"))(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** 把字节切成多块 base64（每块 WRITE_CHUNK 原始字节）。空内容 → 单个空块（用于建空文件）。 */
export function chunkBase64(bytes, size = WRITE_CHUNK) {
  if (!bytes.length) return [""];
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytesToB64(bytes.subarray(i, i + size)));
  return chunks;
}

// ───────────────────────── 串口 REPL 设备文件原语 ─────────────────────────

/**
 * 设备文件操作的执行器：串行化 + REPL 空闲判断 + 经 exec 跑命令。
 * 把副作用收敛到注入的 getExec / state，纯逻辑（上面那些）独立可测。
 */
function makeDeviceFs({ getExec, getState }) {
  let chain = Promise.resolve(); // promise-chain 互斥：我们的操作串行执行
  const dirCache = new Map(); // 完整路径 → 是否目录（供 isDirectory 复用）

  function ready() {
    const exec = getExec?.();
    const st = getState?.() || {};
    if (typeof exec !== "function") return null; // 未接管串口代理
    if (!st.connectName || st.pyRunState) return null; // 未连接 / 正在跑程序
    return exec;
  }
  /** 串行排队执行 fn(exec)；未就绪则 reject。 */
  function run(fn) {
    const task = chain.then(async () => {
      const exec = ready();
      if (!exec) throw new Error("设备未就绪（未连接或正在运行）");
      return fn(exec);
    });
    chain = task.catch(() => {}); // 链不因单次失败而中断
    return task;
  }
  const enc = (s) => new TextEncoder().encode(s);

  return {
    dirCache,
    async list(path) {
      const p = normPath(path);
      return run(async (exec) => {
        const text = await exec(enc(cmdList(p)), { startMark: START, endMark: END, timeout: 5000 });
        const entries = parseList(text, p);
        for (const e of entries) dirCache.set(e.path, e.type === "directory");
        return entries;
      });
    },
    async read(path) {
      const p = normPath(path);
      return run(async (exec) => {
        const text = await exec(enc(cmdRead(p)), { startMark: START, endMark: END, timeout: 8000 });
        return b64ToBytes(text);
      });
    },
    async write(path, bytes) {
      const p = normPath(path);
      const chunks = chunkBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      return run(async (exec) => {
        for (let i = 0; i < chunks.length; i++) {
          await exec(enc(cmdWriteChunk(p, chunks[i], i === 0)), { startMark: START, endMark: END, timeout: 6000 });
        }
        return true;
      });
    },
    async mkdir(path) {
      const p = normPath(path);
      return run(async (exec) => {
        await exec(enc(cmdMkdir(p)), { startMark: START, endMark: END, timeout: 5000 });
        dirCache.set(p, true);
        return true;
      });
    },
    async remove(path) {
      const p = normPath(path);
      return run(async (exec) => {
        await exec(enc(cmdRemove(p)), { startMark: START, endMark: END, timeout: 5000 });
        dirCache.delete(p);
        return true;
      });
    },
    async rmdir(path) {
      const p = normPath(path);
      return run(async (exec) => {
        await exec(enc(cmdRmdir(p)), { startMark: START, endMark: END, timeout: 5000 });
        dirCache.delete(p);
        return true;
      });
    },
    async rename(a, b) {
      const pa = normPath(a), pb = normPath(b);
      return run(async (exec) => {
        await exec(enc(cmdRename(pa, pb)), { startMark: START, endMark: END, timeout: 5000 });
        return true;
      });
    },
    // 递归删目录：JS 侧 list + 逐个删（避免脆弱的多行 exec）。注意 list/remove 各自再排队，
    // 故这里不包在单个 run() 里，直接顺序 await 这些已串行化的原语。
    async rmtree(path) {
      const p = normPath(path);
      const entries = await this.list(p);
      for (const e of entries) {
        if (e.type === "directory") await this.rmtree(e.path);
        else await this.remove(e.path);
      }
      await this.rmdir(p);
      return true;
    },
  };
}

// ───────────────────────── Vue 组件实例级 isElectron 覆盖 ─────────────────────────

const FILE_PANEL_COMPONENT = "mNoteBox"; // 渲染 #mNoteCatalog 的组件名（实测）

/** 在 Vue 组件树里广度优先找第一个满足 pred 的实例。 */
function findComponent(vm, pred) {
  const seen = new Set();
  const q = [vm];
  while (q.length) {
    const c = q.shift();
    if (!c || seen.has(c._uid)) continue;
    seen.add(c._uid);
    try { if (pred(c)) return c; } catch {}
    for (const ch of c.$children || []) q.push(ch);
  }
  return null;
}

/**
 * 把文件面板组件实例的 isElectron 覆盖为恒 true（不动全局 state，保住「连接设备」按钮）。
 * 组件可能延迟挂载（用户切模式才建），故返回是否成功；失败由调用方用 observer/轮询重试。
 * @returns {{ done:boolean, restore?:()=>void }}
 */
/**
 * 在文件面板组件实例（mNoteBox）上打补丁，返回 { done, restore? }：
 *  - isElectron 覆盖为恒 true（让面板渲染，不动全局 → 保住「连接设备」按钮）；
 *  - uploadFile 覆盖为我们自己的实现（站点原版依赖 Electron 的 `$router.isDirectory`/`fileHandUpload`，
 *    网页版 `$router` undefined 会崩）：用 <input type=file> 选本机文件 → 写到设备目标目录 → 刷新列表。
 * 组件可能延迟挂载，故返回 done 供调用方用 observer/轮询重试。
 * @param {object} fs makeDeviceFs 实例（写文件 + 列目录）
 */
function patchFilePanelComponent(vm, fs, win) {
  const c = findComponent(vm, (x) => x.$options && x.$options.name === FILE_PANEL_COMPONENT);
  if (!c) return { done: false };
  if (c.__m3eFilePanelPatched) return { done: true };
  try {
    Object.defineProperty(c, "isElectron", { get() { return true; }, configurable: true });

    const origUpload = c.uploadFile;
    c.uploadFile = function () { uploadViaInput(c, fs, win); };

    c.__m3eFilePanelPatched = true;
    c.$forceUpdate();
    return {
      done: true,
      restore() {
        try {
          delete c.isElectron;
          if (origUpload !== undefined) c.uploadFile = origUpload; else { try { delete c.uploadFile; } catch {} }
          c.__m3eFilePanelPatched = false;
          c.$forceUpdate();
        } catch {}
      },
    };
  } catch {
    return { done: false };
  }
}

/**
 * 接管「导入文件」：弹原生 <input type=file>（可多选）→ 读字节 → 写到设备目标目录 → 刷新 CElist。
 * 目标目录取 pySelectFile[0]（选中项；若是文件取其父目录），未选则根目录。
 */
function uploadViaInput(comp, fs, win) {
  const doc = (win && win.document) || globalThis.document;
  const store = comp.$store;
  const sel = (comp.pySelectFile && comp.pySelectFile[0]) || "";
  // 目标目录：选中项是目录则用之，否则取其父目录；空则根。
  let dir = "/";
  if (sel) {
    const isDir = fs.dirCache.has(normPath(sel)) ? fs.dirCache.get(normPath(sel)) : false;
    dir = isDir ? normPath(sel) : (normPath(sel).replace(/\/[^/]*$/, "") || "/");
  }
  const input = doc.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    try { input.remove(); } catch {}
    if (!files.length) return;
    try { store?.commit?.("progressBar", { text: "导入中…", progress: 0 }); } catch {}
    let okCount = 0;
    for (const f of files) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        await fs.write(joinPath(dir, f.name), bytes);
        okCount++;
      } catch {}
    }
    try { store?.commit?.("messageTips", { text: `已导入 ${okCount}/${files.length} 个文件`, type: okCount ? "success" : "error" }); } catch {}
    try { comp.pySelectFile = []; } catch {}
    try { store?.commit?.("progressFlash"); } catch {}
    // 复刷新：走站点 refreshPyList（→ getComputerData → 我们的 getFileList）。
    try { if (typeof comp.refreshPyList === "function") comp.refreshPyList(); } catch {}
  }, { once: true });
  (doc.body || doc.documentElement).appendChild(input);
  input.click();
}


// ───────────────────────── 安装：四段 ─────────────────────────

/**
 * 云端-电脑同步桥护栏：synchroFn / uploadToMPUF / synchroHand / delList(批量) 在站点里全是
 * 「project」语义——走 $axios 打 /api/* 后端桥（桌面端有后端 agent 连着板代为推送），与掌控板
 * 设备文件（mPythonList 串口）无关；网页版**根本没有那条后端桥**，且这些组件方法的失败路径常漏
 * progressFlash（progressBar 后若 $axios reject 不收进度 → 卡死 0%）。设备文件的删/存/传实际走
 * 已接管的 $serial.delFile/saveFile(...,"mPythonList")，故这批方法对设备文件是空转。
 * 护栏策略：不假装实现不存在的桥——返回「让调用组件干净收尾」的安全值，必收进度条 + 友好提示，
 * 提示用户网页版用右键直接操作设备文件。表驱动（GUARDS_CLOUD），新增桥方法只加一行。
 * @param {string} tip messageTips 文案；为空则不提示
 * @param {*} data 返回 { data } 形状（按各组件方法读取约定造形）
 */
function cloudBridgeStub(vm, { tip, data } = {}) {
  try { vm.$store?.commit?.("progressFlash"); } catch {} // 必收进度条，绝不卡 0%
  if (tip) { try { vm.$store?.commit?.("messageTips", { text: tip, type: "warning" }); } catch {} }
  return Promise.resolve({ data });
}

/**
 * reloadPyList 兜底：真列设备根目录，把文件名数组交给 mNoteBox.setHandPyDir 回灌 CElist，
 * 并 commit progressFlash 收掉「资源加载中 0%」进度条。站点原本靠 Electron 的 mPythonList +
 * routerDesk 推送完成这条；我们没有那条链，故在 mPythonList 护栏里自己补上。
 * 失败也务必 progressFlash，否则进度条永卡。
 */
function loadDeviceListInto(vm, fs) {
  const finish = () => { try { vm.$store?.commit?.("progressFlash"); } catch {} };
  fs.list("/")
    .then((entries) => {
      const comp = findComponent(vm, (x) => x.$options && x.$options.name === FILE_PANEL_COMPONENT);
      // setHandPyDir 期望「文件名字符串数组」（平铺当前目录，渲染为文件项）。
      const names = entries.map((e) => e.name);
      if (comp && typeof comp.setHandPyDir === "function") {
        try { comp.setHandPyDir(names); } catch {}
      }
    })
    .catch(() => {})
    .finally(finish);
}


/**
 * @param {object} o
 * @param {object} o.caps detectHost() 能力对象（含 vm，state()）
 * @param {() => (null | ((bytes:Uint8Array, opts:object)=>Promise<string>))} o.getExec
 *        返回「当前」串口代理 link.exec（代理可能重连，每次取最新）；未接管时返回 null。
 * @param {object} [o.win] 注入 window（测试用）
 * @returns {{ stop():void, fs:object }}
 */
export function installFilePanel({ caps, getExec, win = globalThis.window } = {}) {
  const vm = caps?.vm;
  const ser = vm?.$serial;
  if (!vm || !ser || ser.__m3eFilePanel) return { stop() {}, fs: null };

  const restores = []; // 还原栈
  const fs = makeDeviceFs({ getExec, getState: () => caps?.state?.() || {} });

  // ── 1) 集中护栏 ──
  // window.routerDesk no-op Proxy：任何 routerDesk.X(...) 返回 no-op（含将来新增的调用点）。
  try {
    if (win && !win.routerDesk) {
      const proxy = new Proxy({}, { get: () => () => undefined });
      Object.defineProperty(win, "routerDesk", { value: proxy, configurable: true, writable: true });
      restores.push(() => { try { delete win.routerDesk; } catch {} });
    }
  } catch {}

  // 少数不走 routerDesk 的 $serial Electron-only 方法：装安全护栏（表驱动，新增只加一行）。
  // 注意 connectNum/mPythonList 不是单纯 no-op——它们参与「掌控板文件」tab 的加载分支：
  //   changeFileType(1)：`0==connectNum() ? reloadPyList() : refreshPyList()`
  //   reloadPyList → progressBar(0%) + resetNum() + mPythonList()（Electron 专属枚举，靠 routerDesk
  //     推进度并最终回灌 setHandPyDir）。我们没有那条链，若 no-op 则进度条永卡 0%。
  // 故：① connectNum 返回非 0，把分支导向 refreshPyList → getComputerData → 我们已覆盖的 getFileList；
  //     ② mPythonList 仍实现成真兜底（列目录→setHandPyDir 回灌→progressFlash 收进度），防站点别处
  //        直接调 reloadPyList 时卡住。
  const GUARDS = [
    ["getFaceImg", () => Promise.resolve({ data: [] })],
    ["getIPAdress", () => Promise.resolve({ data: "" })],
    ["connectOnce", () => undefined],
    ["openFiler", () => undefined],
    ["openFolder", () => undefined],
    ["installJupyter", () => undefined],
    ["resetNum", () => undefined],
    ["connectNum", () => 1], // 非 0 → changeFileType 走 refreshPyList（我们的 getFileList），不进 reloadPyList 死路
    ["mPythonList", () => { loadDeviceListInto(vm, fs); }], // reloadPyList 兜底：真列目录并回灌+收进度
    // ── 云端-电脑同步桥（无桥护栏，见 cloudBridgeStub）：返回让调用组件干净收尾的安全值 ──
    // synchroFn: await delList(synchroRemove) → await synchroHand(connectName,master)，读返回 t.data.type；
    //   type==="success" 则清空 import/remove + refreshPyList + 收进度。故 synchroHand 回 success 形状，
    //   delList 回真值（不读其 .data 细节）；提示只在 synchroHand 给一次，避免双弹。
    ["delList", () => cloudBridgeStub(vm, { data: true })],
    ["synchroHand", () => cloudBridgeStub(vm, {
      tip: "网页版无云端同步桥；请用右键直接对掌控板文件增删改",
      data: { type: "success" },
    })],
    // uploadToMPUF(组件「传运行」): 读 r.data（||""===r.data 即收尾 refreshPyList+progressFlash）。
    //   网页版无「上传并运行」后端桥；运行代码请用面板的运行/终端路径。
    ["uploadToMPUF", () => cloudBridgeStub(vm, {
      tip: "网页版无「上传并运行」桥；请用运行按钮或终端执行代码",
      data: "",
    })],
  ];
  for (const [name, fn] of GUARDS) {
    const orig = ser[name];
    ser[name] = fn;
    restores.push(() => { if (orig === undefined) { try { delete ser[name]; } catch {} } else ser[name] = orig; });
  }

  // ── 3) 设备文件 $serial 覆盖（注册表驱动；mode==="mPythonList" 才走串口，否则透传 orig） ──
  const isDevice = (mode) => mode === DEVICE_MODE || (mode && typeof mode === "object" && mode.project === DEVICE_MODE);
  const wrap = (name, handler) => {
    const orig = typeof ser[name] === "function" ? ser[name].bind(ser) : null;
    ser[name] = async function (...args) {
      try { return await handler(args, orig); }
      catch { return { data: name === "getFileList" ? [] : "" }; } // 失败安静降级，绝不崩面板
    };
    restores.push(() => { if (orig) ser[name] = orig; else { try { delete ser[name]; } catch {} } });
  };

  wrap("getFileList", async (args, orig) => {
    const [path, mode] = args;
    if (!isDevice(mode)) return orig ? orig(...args) : { data: [] };
    // 站点 getComputerData 期望 data 是**文件名字符串数组**：它先 P.e(data)（按「第X课」排序，对
    // 每个元素调 .match → 必须是字符串），再 getJsonData() 逐个 isDirectory 补 type 重建对象。
    // 故这里只返回文件名；type 信息已由 fs.list 写进 dirCache，供随后 isDirectory 覆盖命中。
    const entries = await fs.list(path);
    return { data: entries.map((e) => e.name) };
  });
  wrap("isDirectory", async (args, orig) => {
    const [path, mode] = args;
    if (isDevice(mode) && fs.dirCache.has(normPath(path))) return { data: fs.dirCache.get(normPath(path)) };
    return orig ? orig(...args) : { data: false };
  });
  wrap("getFileData", async (args, orig) => {
    const [path, mode] = args;
    if (!isDevice(mode)) return orig ? orig(...args) : { data: "" };
    const bytes = await fs.read(path);
    return { data: new TextDecoder().decode(bytes) }; // 编辑器要文本
  });
  wrap("downFile", async (args, orig) => {
    const [path, mode] = args;
    if (!isDevice(mode)) return orig ? orig(...args) : { data: "" };
    return { data: await fs.read(path) }; // 站点侧 new Blob([data]) → saveAs（字节最安全）
  });
  wrap("addFile", async (args, orig) => {
    const [name, mode] = args;
    if (!isDevice(mode)) return orig ? orig(...args) : { data: "" };
    await fs.write(name, new Uint8Array(0)); // 新建空文件
    return { data: "OK" };
  });
  wrap("saveFile", async (args, orig) => {
    // 站点 saveFile 签名多变：可能是 (path, content, mode, ms) 或 ({url/path, data/code, project})。
    const a0 = args[0];
    let path, content, mode;
    if (a0 && typeof a0 === "object") {
      path = a0.url || a0.path; content = a0.data ?? a0.code ?? ""; mode = a0.project;
    } else {
      path = a0; content = args[1] ?? ""; mode = args[2];
    }
    if (!isDevice(mode)) return orig ? orig(...args) : { data: "" };
    const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(String(content));
    await fs.write(path, bytes);
    return { data: "OK" };
  });
  wrap("addFolder", async (args, orig) => {
    const [name, mode] = args;
    if (!isDevice(mode)) return orig ? orig(...args) : { data: "" };
    await fs.mkdir(name);
    return { data: "OK" };
  });
  wrap("delFile", async (args, orig) => {
    const [path, mode] = args;
    if (!isDevice(mode)) return orig ? orig(...args) : { data: "" };
    await fs.remove(path);
    return { data: "OK" };
  });
  wrap("delFolder", async (args, orig) => {
    const [path, mode] = args;
    if (!isDevice(mode)) return orig ? orig(...args) : { data: "" };
    await fs.rmtree(path);
    return { data: "OK" };
  });
  wrap("renameFile", async (args, orig) => {
    const [oldPath, newName, mode] = args;
    if (!isDevice(mode)) return orig ? orig(...args) : { data: "" };
    // 站点传「旧全路径 + 新文件名」；新路径 = 旧路径同目录 + 新名。
    const dir = normPath(oldPath).replace(/\/[^/]*$/, "") || "/";
    await fs.rename(oldPath, joinPath(dir, newName));
    return { data: "OK" };
  });

  // ── 2) 启用渲染 + 接管导入（实例级补丁 mNoteBox：isElectron 覆盖 + uploadFile 重写，不动全局） ──
  // 组件可能尚未挂载：先试一次，未成则用 MutationObserver + 轮询兜底，挂载后补打补丁。
  let compPatch = null; // { restore() }
  let healTimer = null;
  let observer = null;
  const tryOverride = () => {
    if (compPatch) return true;
    const r = patchFilePanelComponent(vm, fs, win);
    if (r.done && r.restore) { compPatch = r; return true; }
    return r.done; // done 但无 restore = 已被别处补丁过，停止重试
  };
  if (!tryOverride()) {
    const schedule = () => {
      if (healTimer) return;
      healTimer = setTimeout(() => { healTimer = null; if (tryOverride()) cleanup(); }, 300);
    };
    const cleanup = () => {
      try { observer?.disconnect(); } catch {}
      if (healTimer) { clearTimeout(healTimer); healTimer = null; }
      observer = null;
    };
    try {
      observer = new MutationObserver(schedule);
      observer.observe((win?.document || globalThis.document).body, { childList: true, subtree: true });
    } catch {}
    restores.push(cleanup);
  }
  restores.push(() => { try { compPatch?.restore?.(); } catch {} });

  ser.__m3eFilePanel = true;
  return {
    fs,
    stop() {
      try { while (restores.length) restores.pop()(); ser.__m3eFilePanel = false; } catch {}
    },
  };
}
