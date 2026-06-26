// e2e/filepanel.e2e.mjs — 文件面板 T2 验证。
//
// Part B（必跑，权威退出码 / 无需真板/网络/python）：
//   真 serialProxy 垫片(ProxyLink) ←WS→ 假设备(Bun.serve + 内存 MicroPython FS)，叠上真 filePanel
//   $serial 覆盖层，跑设备文件「列→新建→写→读→重命名→下载→删→建夹→递归删」全链路往返。
//   验证 T0 测不到的**真实串口帧框定**（chr(2)/chr(3) 哨兵跨 WebSocket 二进制帧、TextDecoder 流式拼接）。
//
// Part A（M3E_E2E_SITE=1 才跑，需联网真站）：渲染机制冒烟——在真站 routerDesk no-op Proxy + 翻
//   isElectron，断言 #mNoteCatalog 进入 DOM 且无未捕获异常 / 无 "routerDesk is undefined"。
//
// 运行：bun e2e/filepanel.e2e.mjs        （仅 Part B）
//      M3E_E2E_SITE=1 bun e2e/filepanel.e2e.mjs  （含真站冒烟）

import { installSerialProxy } from "../src/host/serialProxy.mjs";
import { installFilePanel } from "../src/host/filePanel.mjs";
import { startFakeDevice } from "./helpers/fakeDevice.mjs";

const assert = (cond, msg) => { if (!cond) throw new Error("ASSERT FAILED: " + msg); };
const td = new TextDecoder();

async function partB() {
  console.log("[e2e:filepanel] Part B — 假设备全链路往返");
  const dev = startFakeDevice({ "/boot.py": "print('boot')", "/lib": null });
  const win = { navigator: {} };
  let proxy;
  try {
    proxy = await installSerialProxy({ url: dev.url, win, onStatus: () => {}, pickPort: () => null });
    const exec = () => proxy.link.exec.bind(proxy.link);
    const ser = {};
    // 假 Vue 树：根 vm + 一个 mNoteBox 组件实例（供实例级 isElectron 覆盖）。
    const fileComp = { _uid: 2, $options: { name: "mNoteBox" }, $children: [], isElectron: false, $forceUpdate() {} };
    const caps = {
      vm: { _uid: 1, $serial: ser, $store: { state: { isElectron: false } }, $children: [fileComp] },
      state: () => ({ connectName: "fake", pyRunState: false }),
    };
    const fp = installFilePanel({ caps, getExec: exec, win });
    assert(fileComp.isElectron === true, "mNoteBox 实例 isElectron 覆盖为 true");
    assert(caps.vm.$store.state.isElectron === false, "全局 isElectron 保持 false（连接按钮不受影响）");
    assert(typeof win.routerDesk === "object", "routerDesk Proxy 安装");

    // 列目录（种子）—— getFileList 返回文件名字符串数组（站点 P.e 期望）
    let r = await ser.getFileList("/", "mPythonList");
    const names0 = r.data.slice().sort();
    assert(names0.join(",") === "boot.py,lib", "初始列表 = boot.py,lib（实=" + names0 + "）");
    assert(r.data.every((x) => typeof x === "string"), "data 是字符串数组（非对象）");
    // 目录判定走 isDirectory（dirCache，getJsonData 据此补 type）
    assert((await ser.isDirectory("/lib", "mPythonList")).data === true, "lib 识别为目录");
    assert((await ser.isDirectory("/boot.py", "mPythonList")).data === false, "boot.py 非目录");

    // 新建 → 写 → 读
    await ser.addFile("/app.py", "mPythonList");
    await ser.saveFile("/app.py", "print('hello 世界')", "mPythonList");
    r = await ser.getFileData("/app.py", "mPythonList");
    assert(r.data === "print('hello 世界')", "读回内容含中文（实=" + JSON.stringify(r.data) + "）");

    // 下载（字节）
    r = await ser.downFile("/app.py", "mPythonList");
    assert(td.decode(r.data) === "print('hello 世界')", "downFile 返回字节内容");

    // 重命名
    await ser.renameFile("/app.py", "main2.py", "mPythonList");
    r = await ser.getFileList("/", "mPythonList");
    assert(r.data.includes("main2.py"), "重命名后出现 main2.py");
    assert(!r.data.includes("app.py"), "旧名 app.py 消失");

    // 删除文件
    await ser.delFile("/main2.py", "mPythonList");
    r = await ser.getFileList("/", "mPythonList");
    assert(!r.data.includes("main2.py"), "删除后 main2.py 消失");

    // 建夹 + 子文件 + 递归删
    await ser.addFolder("/d", "mPythonList");
    await ser.saveFile("/d/x.py", "x", "mPythonList");
    await ser.delFolder("/d", "mPythonList");
    assert(!dev.fs.exists("/d") && !dev.fs.exists("/d/x.py"), "递归删目录及子文件");

    // 大文件分块写读（跨多 base64 块）
    const big = "A".repeat(1000);
    await ser.saveFile("/big.txt", big, "mPythonList");
    r = await ser.getFileData("/big.txt", "mPythonList");
    assert(r.data === big, "大文件分块写后读回一致（len=" + r.data.length + "）");

    // project 模式不接管：无 orig → 安静空（不抛）
    r = await ser.getFileList("/", "project");
    assert(Array.isArray(r.data), "project 模式返回数组（透传/降级）");

    fp.stop();
    assert(fileComp.isElectron !== true, "stop() 还原实例 isElectron 覆盖");
    assert(win.routerDesk === undefined, "stop() 还原 routerDesk");

    console.log("[e2e:filepanel] Part B PASS");
  } finally {
    try { proxy?.close(); } catch {}
    dev.stop();
  }
}

async function partA() {
  if (process.env.M3E_E2E_SITE !== "1") {
    console.log("[e2e:filepanel] Part A SKIP（设 M3E_E2E_SITE=1 且联网真站可跑渲染冒烟）");
    return;
  }
  console.log("[e2e:filepanel] Part A — 真站渲染机制冒烟");
  const { chromium } = await import("playwright");
  const URL = process.env.M3E_URL || "https://online.mpython.cn/";
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));
  try {
    await page.goto(URL, { waitUntil: "commit", timeout: 90000 });
    await page.waitForFunction(() => !!(window.vm && window.vm.$store), null, { timeout: 90000 });
    await page.waitForTimeout(4000);
    const res = await page.evaluate(() => {
      if (!window.routerDesk) Object.defineProperty(window, "routerDesk", { value: new Proxy({}, { get: () => () => undefined }), configurable: true });
      // 实例级覆盖 mNoteBox.isElectron（不动全局），保住「连接设备」按钮。
      function findComp(pred) { const seen = new Set(), q = [window.vm]; while (q.length) { const c = q.shift(); if (!c || seen.has(c._uid)) continue; seen.add(c._uid); try { if (pred(c)) return c; } catch {} for (const ch of c.$children || []) q.push(ch); } return null; }
      const c = findComp((x) => x.$options && x.$options.name === "mNoteBox");
      const before = !!document.querySelector(".web-connect");
      if (c) { Object.defineProperty(c, "isElectron", { get() { return true; }, configurable: true }); c.$forceUpdate(); }
      return new Promise((resolve) => setTimeout(() => resolve({
        foundComp: !!c,
        hasCatalog: !!document.querySelector("#mNoteCatalog"),
        connectBefore: before,
        connectAfter: !!document.querySelector(".web-connect"),
        globalIsEl: window.vm.$store.state.isElectron,
      }), 1200));
    });
    assert(res.foundComp, "找到 mNoteBox 组件实例");
    assert(res.hasCatalog, "#mNoteCatalog 进入 DOM");
    assert(res.connectAfter, "「连接设备」按钮仍在（实例级覆盖未波及）");
    assert(res.globalIsEl === false, "全局 isElectron 未被改动");
    const fatal = errors.filter((e) => /routerDesk|isElectron|Cannot read/.test(e));
    assert(fatal.length === 0, "无致命异常（" + fatal.join(" | ") + "）");
    console.log("[e2e:filepanel] Part A PASS", JSON.stringify(res));
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  try {
    await partB();
    await partA();
    console.log("[e2e:filepanel] ALL PASS");
    process.exit(0);
  } catch (e) {
    console.error("[e2e:filepanel] FAIL —", e.message);
    process.exit(1);
  }
})();
