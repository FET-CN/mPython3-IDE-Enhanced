import { describe, it, expect, beforeEach } from "vitest";
import {
  installFilePanel, START, END,
  pyStr, normPath, joinPath, parseList,
  cmdList, cmdRead, cmdWriteChunk, cmdMkdir, cmdRemove, cmdRmdir, cmdRename,
  bytesToB64, b64ToBytes, chunkBase64,
} from "../../src/host/filePanel.mjs";
import { makeMicroFs } from "../helpers/microFs.mjs";

// ───────────────────────── 纯函数 ─────────────────────────

describe("filePanel 纯函数", () => {
  it("normPath / joinPath", () => {
    expect(normPath("")).toBe("/");
    expect(normPath("a/b")).toBe("/a/b");
    expect(normPath("/x")).toBe("/x");
    expect(joinPath("/", "f.py")).toBe("/f.py");
    expect(joinPath("/lib", "a.py")).toBe("/lib/a.py");
    expect(joinPath("/lib/", "a.py")).toBe("/lib/a.py");
  });

  it("pyStr 转义单引号字符串", () => {
    expect(pyStr("/a.py")).toBe("'/a.py'");
    expect(pyStr("o'clock")).toBe("'o\\'clock'");
    expect(pyStr("a\\b")).toBe("'a\\\\b'");
  });

  it("parseList 解析 repr，含目录位与转义/中文名", () => {
    const out = parseList("[('boot.py', 32768), ('lib', 16384), ('中文.py', 32768)]", "/");
    expect(out).toEqual([
      { name: "boot.py", path: "/boot.py", type: "file" },
      { name: "lib", path: "/lib", type: "directory" },
      { name: "中文.py", path: "/中文.py", type: "file" },
    ]);
  });

  it("base64 往返 + 分块", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 65, 66]);
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
    expect(chunkBase64(new Uint8Array(0))).toEqual([""]); // 空 → 单空块（建空文件）
    const big = new Uint8Array(700).map((_, i) => i % 256);
    const chunks = chunkBase64(big, 256);
    expect(chunks.length).toBe(3); // 256+256+188
    const round = chunks.flatMap((c) => [...b64ToBytes(c)]);
    expect(new Uint8Array(round)).toEqual(big);
  });

  it("命令构造器带哨兵框架且可被 microFs 求值", () => {
    expect(cmdList("/")).toContain("ilistdir('/')");
    expect(cmdRead("/a.py")).toContain("b2a_base64");
    expect(cmdWriteChunk("/a.py", "QQ==", true)).toContain("'wb'");
    expect(cmdWriteChunk("/a.py", "QQ==", false)).toContain("'ab'");
    expect(cmdMkdir("/d")).toContain(".mkdir('/d')");
    expect(cmdRemove("/a")).toContain(".remove('/a')");
    expect(cmdRmdir("/d")).toContain(".rmdir('/d')");
    expect(cmdRename("/a", "/b")).toContain(".rename('/a','/b')");
  });
});

// ─────────────── microFs 自洽（确保测试替身按协议求值） ───────────────

describe("microFs 命令求值", () => {
  it("列目录返回 Python repr", () => {
    const fs = makeMicroFs({ "/boot.py": "x", "/lib": null });
    const payload = fs.exec(cmdList("/").trim());
    const entries = parseList(payload, "/");
    expect(entries.map((e) => e.name).sort()).toEqual(["boot.py", "lib"]);
    expect(entries.find((e) => e.name === "lib").type).toBe("directory");
  });
  it("写后读往返", () => {
    const fs = makeMicroFs();
    fs.exec(cmdWriteChunk("/a.py", bytesToB64(new TextEncoder().encode("hi")), true).trim());
    const b64 = fs.exec(cmdRead("/a.py").trim());
    expect(new TextDecoder().decode(b64ToBytes(b64))).toBe("hi");
  });
  it("非本协议命令返回 null", () => {
    expect(makeMicroFs().exec("print('hello world')")).toBeNull();
  });
});

// ───────────── 覆盖层：以 mock exec 驱动 $serial 覆盖（无硬件闭环） ─────────────

function makeHarness(seed, { connectName = "COM3", pyRunState = false } = {}) {
  const micro = makeMicroFs(seed);
  // mock exec：解码命令字节 → microFs 求值 → 返回 payload（即真 exec 的「哨兵之间」返回值）。
  const exec = (bytes, opts) => {
    expect(opts.startMark).toBe(START);
    expect(opts.endMark).toBe(END);
    const text = new TextDecoder().decode(bytes);
    const payload = micro.exec(text);
    if (payload === null) return Promise.reject(new Error("unknown cmd"));
    return Promise.resolve(payload);
  };
  // 站点原 $serial：project / 云端方法返回可辨识标记（断言透传未被接管）。
  const ser = {
    getFileList: async (p, m) => ({ data: [{ name: "CLOUD", path: "/CLOUD", type: "file", _orig: m }] }),
    getFileData: async () => ({ data: "CLOUD_CONTENT" }),
    addFile: async () => ({ data: "CLOUD_ADD" }),
    delFile: async () => ({ data: "CLOUD_DEL" }),
    renameFile: async () => ({ data: "CLOUD_REN" }),
    isDirectory: async () => ({ data: false }),
  };
  // 假 window + 极简 document：用于上传接管的 <input type=file>。
  const lastInput = { el: null };
  const win = {
    document: {
      body: { appendChild() {} },
      createElement() {
        const listeners = {};
        const el = {
          type: "", multiple: false, style: {}, files: [],
          addEventListener(ev, fn) { listeners[ev] = fn; },
          remove() {},
          click() {}, // 测试里手动触发 change
          _fire(ev) { return listeners[ev]?.(); },
        };
        lastInput.el = el;
        return el;
      },
    },
  };
  // 假 Vue 组件树：根 vm 下挂一个 mNoteBox（带 isElectron + setHandPyDir + refreshPyList + pySelectFile）。
  let uid = 0;
  const handDir = []; // setHandPyDir 收到的文件名数组
  const commits = []; // store.commit 记录（progressFlash 等）
  let refreshed = 0;  // refreshPyList 调用次数
  const fileComp = {
    _uid: ++uid, $options: { name: "mNoteBox" }, $children: [],
    isElectron: false, $forceUpdate() {},
    pySelectFile: [],
    setHandPyDir(names) { handDir.length = 0; handDir.push(...names); },
    refreshPyList() { refreshed++; },
    get $store() { return vm.$store; },
  };
  const vm = {
    _uid: ++uid, $serial: ser,
    $store: { state: { isElectron: false }, commit: (t, p) => commits.push([t, p]) },
    $children: [fileComp],
  };
  const caps = { vm, state: () => ({ connectName, pyRunState }) };
  const handle = installFilePanel({ caps, getExec: () => exec, win });
  return { micro, ser, win, caps, fileComp, handDir, commits, lastInput, getRefreshed: () => refreshed, handle };
}

describe("installFilePanel 覆盖层（设备 mPythonList 走串口）", () => {
  let h;
  beforeEach(() => { h = makeHarness({ "/boot.py": "print(1)", "/lib": null }); });

  it("实例级覆盖 mNoteBox.isElectron=true（不动全局）+ 装 routerDesk no-op Proxy", () => {
    expect(h.fileComp.isElectron).toBe(true); // 组件实例被覆盖
    expect(h.caps.vm.$store.state.isElectron).toBe(false); // 全局保持 false（保住连接按钮）
    expect(typeof h.win.routerDesk.anything).toBe("function"); // get → no-op 函数
    expect(h.win.routerDesk.installPyAndJupyter("x")).toBeUndefined(); // 任意调用 no-op，不抛
  });

  it("getFileList: 设备列目录走串口（返回文件名字符串数组），project 透传站点原实现", async () => {
    const dev = await h.ser.getFileList("/", "mPythonList");
    // 站点 P.e(data) 期望字符串数组（对每元素 .match），故 data 是文件名而非对象。
    expect(dev.data.slice().sort()).toEqual(["boot.py", "lib"]);
    expect(dev.data.every((x) => typeof x === "string")).toBe(true);
    const cloud = await h.ser.getFileList("/", "project");
    expect(cloud.data[0].name).toBe("CLOUD");
  });

  it("getFileList 后 dirCache 已填好，isDirectory 据此判类型（getJsonData 补 type 用）", async () => {
    await h.ser.getFileList("/", "mPythonList");
    expect((await h.ser.isDirectory("/lib", "mPythonList")).data).toBe(true);
    expect((await h.ser.isDirectory("/boot.py", "mPythonList")).data).toBe(false);
  });

  it("新建→写入→读取→重命名→删除 全链路（设备）", async () => {
    await h.ser.addFile("/n.py", "mPythonList");
    expect(h.micro.exists("/n.py")).toBe(true);

    await h.ser.saveFile("/n.py", "print('hi')", "mPythonList");
    expect((await h.ser.getFileData("/n.py", "mPythonList")).data).toBe("print('hi')");

    await h.ser.renameFile("/n.py", "m.py", "mPythonList");
    expect(h.micro.exists("/n.py")).toBe(false);
    expect(h.micro.readText("/m.py")).toBe("print('hi')");

    await h.ser.delFile("/m.py", "mPythonList");
    expect(h.micro.exists("/m.py")).toBe(false);
  });

  it("saveFile 接受对象签名 {url,data,project}", async () => {
    await h.ser.saveFile({ url: "/o.py", data: "X=1", project: "mPythonList" });
    expect(h.micro.readText("/o.py")).toBe("X=1");
  });

  it("delFolder 递归删目录（rmtree）", async () => {
    await h.ser.addFolder("/d", "mPythonList");
    await h.ser.saveFile("/d/a.py", "a", "mPythonList");
    await h.ser.saveFile("/d/b.py", "b", "mPythonList");
    await h.ser.delFolder("/d", "mPythonList");
    expect(h.micro.exists("/d")).toBe(false);
    expect(h.micro.exists("/d/a.py")).toBe(false);
  });

  it("project 模式各写方法透传站点原实现", async () => {
    expect((await h.ser.getFileData("/x", "project")).data).toBe("CLOUD_CONTENT");
    expect((await h.ser.addFile("/x", "project")).data).toBe("CLOUD_ADD");
    expect((await h.ser.delFile("/x", "project")).data).toBe("CLOUD_DEL");
    expect((await h.ser.renameFile("/x", "y", "project")).data).toBe("CLOUD_REN");
  });

  it("设备未就绪（未连接）时安静降级为空，不抛", async () => {
    const h2 = makeHarness({ "/a.py": "1" }, { connectName: "" });
    const r = await h2.ser.getFileList("/", "mPythonList");
    expect(r).toEqual({ data: [] });
  });

  it("connectNum 护栏返回非 0（导向 refreshPyList，不进 reloadPyList 死路）", () => {
    expect(h.ser.connectNum()).not.toBe(0);
  });

  it("云端桥护栏（无桥）：synchroHand/delList/uploadToMPUF 必收进度条且不卡，让组件干净收尾", async () => {
    const before = h.commits.filter(([t]) => t === "progressFlash").length;
    // synchroFn 调用序：await delList(...) → await synchroHand(...)；synchroHand 须回 {data:{type:"success"}}
    const del = await h.ser.delList(["/a", "/b"]);
    expect(del.data).toBe(true);
    const syn = await h.ser.synchroHand("COM3", "mPython");
    expect(syn.data.type).toBe("success"); // 让 synchroFn 走成功分支清空 + refreshPyList
    // uploadAndRun/uploadToMPUF 读 r.data（||""===r.data 即收尾）；回空串满足
    const up = await h.ser.uploadToMPUF("/x.py", true);
    expect(up.data).toBe("");
    // 三次都 commit 了 progressFlash（绝不卡 0%）
    const after = h.commits.filter(([t]) => t === "progressFlash").length;
    expect(after - before).toBe(3);
    // 给了友好提示（synchroHand + uploadToMPUF 各一次 messageTips）
    expect(h.commits.filter(([t]) => t === "messageTips").length).toBeGreaterThanOrEqual(2);
  });

  it("mPythonList 兜底：列目录→setHandPyDir 回灌→progressFlash 收进度", async () => {
    h.ser.mPythonList("COM3", "mPython");
    // 等内部 fs.list + finally 跑完
    await new Promise((r) => setTimeout(r, 20));
    expect(h.handDir.sort()).toEqual(["boot.py", "lib"]); // 回灌的文件名
    expect(h.commits.some(([t]) => t === "progressFlash")).toBe(true); // 收掉进度条
  });

  it("uploadFile 接管：选本机文件 → 写到目标目录 → 刷新（绕开 $router）", async () => {
    // 先列目录，建好 dirCache（决定目标目录用）
    await h.ser.getFileList("/", "mPythonList");
    h.fileComp.pySelectFile = ["/lib"]; // 选中目录 → 上传进 /lib
    h.fileComp.uploadFile(); // 触发我们覆盖的实现，创建 <input>
    const input = h.lastInput.el;
    expect(input.type).toBe("file");
    // 模拟用户选了一个文件
    input.files = [{
      name: "up.py",
      arrayBuffer: async () => new TextEncoder().encode("X=1").buffer,
    }];
    await input._fire("change");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.micro.readText("/lib/up.py")).toBe("X=1"); // 写进目标目录
    expect(h.getRefreshed()).toBeGreaterThan(0); // 刷新被调
  });

  it("幂等：二次 install 直接返回，不重复包裹", () => {
    const again = installFilePanel({ caps: h.caps, getExec: () => null, win: h.win });
    expect(again.fs).toBeNull();
  });

  it("stop() 还原实例覆盖与 routerDesk", () => {
    h.handle.stop();
    expect(h.fileComp.isElectron).not.toBe(true); // 实例覆盖已撤销
    expect(h.fileComp.__m3eFilePanelPatched).toBe(false);
    expect(h.win.routerDesk).toBeUndefined();
    expect(h.caps.vm.$serial.__m3eFilePanel).toBe(false);
  });
});
