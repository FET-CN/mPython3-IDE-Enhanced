// src/host/serialProxy.mjs — navigator.serial 垫片（polyfill）。
//
// 防腐层的一部分：唯一允许触碰 window.navigator / WebSocket 的串口模块。把网站对
// Web Serial 的调用透明地转发给本地 Python 代理（serial-proxy/，通过 WebSocket），
// 让 Firefox / Safari 等没有 Web Serial 的浏览器也能连接、运行、烧录掌控板。
//
// 与代理的约定：控制消息走「文本帧（JSON）」，串口原始字节走「二进制帧」。
// 仅当成功连上代理后才覆盖 navigator.serial；连不上则抛错、保持页面原状。

// 诊断日志：默认开启，设 window.__M3E_SERIAL_DEBUG__ = false 可关；= "verbose" 打印每帧。
const DBG = (...a) => {
  try {
    if (globalThis.window?.__M3E_SERIAL_DEBUG__ !== false) console.info("[m3e-serial]", ...a);
  } catch {}
};
const VERBOSE = () => { try { return globalThis.window?.__M3E_SERIAL_DEBUG__ === "verbose"; } catch { return false; } };

/** 维护到代理的单条 WebSocket，做控制请求/响应关联与二进制帧分发。 */
class ProxyLink {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.waiters = [];        // 控制响应等待者（按 type 关联）
    this.rxController = null; // 当前 readable 流的 controller
    this.rxBuffer = [];       // controller 就绪前到达的二进制帧
    this.onStatus = null;     // 非请求型 error/事件回调
    this.onClose = null;
    this.rxBytes = 0;         // 串口→浏览器 累计字节（诊断）
    this.txBytes = 0;         // 浏览器→串口 累计字节（诊断）
    this.sniffers = [];       // 临时 rx 旁路（exec 用，不影响站点读取）
  }

  connect(timeout = 6000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try { ws = new WebSocket(this.url); }
      catch (e) { reject(new Error("无法创建到串口代理的连接：" + (e?.message || e))); return; }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const to = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error("连接串口代理超时")); }
      }, timeout);
      ws.onopen = () => { if (!settled) { settled = true; clearTimeout(to); resolve(); } };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error("无法连接串口代理（请确认本地 agent 已启动）")); } };
      ws.onclose = () => {
        if (!settled) { settled = true; clearTimeout(to); reject(new Error("串口代理连接被关闭")); return; }
        this._failWaiters("串口代理连接已关闭");
        this.onClose?.();
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
    });
  }

  _onMessage(data) {
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      const i = this.waiters.findIndex((w) => w.types.has(msg.type));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
      // 非请求型消息（如串口读出错），上报状态
      if (msg.type === "error") this.onStatus?.(msg.message || "串口代理报错", "err");
      return;
    }
    // 二进制帧 = 串口读出的原始字节
    const u8 = new Uint8Array(data);
    const first = this.rxBytes === 0;
    this.rxBytes += u8.length;
    if (first) DBG("◀ 收到串口首批数据", u8.length, "字节（板子→浏览器 链路通）");
    if (VERBOSE()) DBG("◀ rx", u8.length, "字节，累计", this.rxBytes);
    if (this.rxController) {
      try { this.rxController.enqueue(u8); } catch (e) { DBG("enqueue 失败", e?.message); }
    } else {
      this.rxBuffer.push(u8);
    }
    // 旁路：把同一份字节喂给临时 sniffer（exec 抓 REPL 回显），不影响站点读取。
    if (this.sniffers.length) {
      for (const fn of this.sniffers.slice()) { try { fn(u8); } catch {} }
    }
  }

  /**
   * 在板子 REPL 上跑一小段命令并抓回显：直接写串口字节，旁路嗅探 rx 直到出现结束哨兵。
   * 站点照常收到这些字节（终端会显示），我们只是额外拷贝一份解析。
   * @returns {Promise<string>} startMark 与 endMark 之间的文本
   */
  exec(cmdBytes, { startMark, endMark, timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const dec = new TextDecoder();
      let buf = "";
      const sniffer = (u8) => {
        buf += dec.decode(u8, { stream: true });
        const s = buf.indexOf(startMark);
        if (s < 0) { if (buf.length > 65536) buf = buf.slice(-4096); return; }
        const e = buf.indexOf(endMark, s + startMark.length);
        if (e >= 0) { cleanup(); resolve(buf.slice(s + startMark.length, e)); }
      };
      const cleanup = () => {
        clearTimeout(to);
        const i = this.sniffers.indexOf(sniffer);
        if (i >= 0) this.sniffers.splice(i, 1);
      };
      const to = setTimeout(() => { cleanup(); reject(new Error("REPL exec 超时")); }, timeout);
      this.sniffers.push(sniffer);
      try { this.sendBinary(cmdBytes); }
      catch (e) { cleanup(); reject(e); }
    });
  }

  /** 发送一条控制消息并等待某类响应。 */
  request(obj, acceptTypes, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const w = { types: new Set(acceptTypes), resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("串口代理响应超时：" + obj.type));
      }, timeout);
      this.waiters.push(w);
      try { this.ws.send(JSON.stringify(obj)); }
      catch (e) {
        clearTimeout(w.timer);
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(e);
      }
    });
  }

  sendJSON(obj) { try { this.ws.send(JSON.stringify(obj)); } catch {} }
  sendBinary(u8) {
    const first = this.txBytes === 0;
    this.txBytes += u8.length;
    if (first) DBG("▶ 首次写入串口", u8.length, "字节（浏览器→板子 链路通）");
    if (VERBOSE()) DBG("▶ tx", u8.length, "字节，累计", this.txBytes);
    try { this.ws.send(u8); } catch (e) { DBG("ws.send 失败", e?.message); }
  }

  attachReader(controller) {
    this.rxController = controller;
    if (this.rxBuffer.length) {
      for (const u8 of this.rxBuffer) { try { controller.enqueue(u8); } catch {} }
      this.rxBuffer = [];
    }
  }
  detachReader() { this.rxController = null; }

  _failWaiters(reason) {
    const ws = this.waiters.splice(0);
    for (const w of ws) { clearTimeout(w.timer); w.reject(new Error(reason)); }
  }
}

/** 构造一个符合 Web Serial 形状的 SerialPort，绑定到代理的一块串口。 */
function makeSerialPort(link, info) {
  let readable = null;
  let writable = null;
  const hex = (s) => (typeof s === "string" && s ? parseInt(s, 16) : undefined);

  return {
    get readable() { return readable; },
    get writable() { return writable; },

    async open({ baudRate = 115200 } = {}) {
      DBG("open", info.path, "@", baudRate);
      const res = await link.request(
        { type: "open", path: info.path, baudRate },
        ["opened", "error"],
      );
      if (res.type === "error") { DBG("open 失败:", res.message); throw new Error(res.message || "打开串口失败"); }
      DBG("opened", info.path);

      let pulls = 0;
      readable = new ReadableStream({
        start: (controller) => link.attachReader(controller),
        pull: () => { pulls++; if (pulls <= 2) DBG("readable.pull #" + pulls, "（站点已在读取串口流）"); },
        cancel: () => { DBG("readable.cancel（站点取消了读取）"); link.detachReader(); },
      });
      writable = new WritableStream({
        write: (chunk) => {
          // 网站用 TextEncoder().encode(...) → Uint8Array；esptool 也写 Uint8Array/ArrayBuffer。
          link.sendBinary(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        },
      });
      // 决定性诊断：1.5s 后看站点是否真的锁定/读取了我们的 readable。
      setTimeout(() => DBG(
        "诊断：readable.locked =", readable?.locked,
        "· pull 次数 =", pulls,
        "· 已收", link.rxBytes, "字节 · 已发", link.txBytes, "字节",
        readable?.locked ? "→ 站点在读，问题在显示侧" : "→ 站点没读我们的流（读循环没起来）",
      ), 1500);
    },

    async close() {
      DBG("close", info.path, "（rx", link.rxBytes, "tx", link.txBytes, "字节）");
      try { await link.request({ type: "close" }, ["closed"], 2000); } catch {}
      link.detachReader();
      readable = null;
      writable = null;
    },

    // 烧录固件必需：DTR/RTS（及可选 break）透传给 pyserial。
    async setSignals(signals = {}) {
      const m = { type: "setSignals" };
      if ("dataTerminalReady" in signals) m.dataTerminalReady = !!signals.dataTerminalReady;
      if ("requestToSend" in signals) m.requestToSend = !!signals.requestToSend;
      if ("break" in signals) m.break = !!signals.break;
      DBG("setSignals", JSON.stringify(signals), "（板子复位/进 bootloader 靠它）");
      link.sendJSON(m);
    },
    async getSignals() { return { clearToSend: false, dataCarrierDetect: false, dataSetReady: false, ringIndicator: false }; },

    getInfo() { return { usbVendorId: hex(info.vid), usbProductId: hex(info.pid) }; },
    async forget() { link.detachReader(); readable = null; writable = null; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  };
}

/** 构造 navigator.serial 替身对象。 */
function makeSerial(link, { pickPort }) {
  const granted = [];
  return {
    async requestPort() {
      const res = await link.request({ type: "listPorts" }, ["ports"]);
      const ports = res.ports || [];
      DBG("requestPort：代理报告", ports.length, "个串口", ports.map((p) => `${p.path}${p.isBoard ? "(板)" : ""}`));
      const boards = ports.filter((p) => p.isBoard);
      let chosen;
      if (boards.length === 1) chosen = boards[0];
      else if (!boards.length && ports.length === 1) chosen = ports[0];
      else chosen = await pickPort?.(ports);
      if (!chosen) throw new DOMException("未选择串口", "NotFoundError");
      DBG("requestPort：选中", chosen.path);
      const port = makeSerialPort(link, chosen);
      granted.push(port);
      return port;
    },
    async getPorts() { return granted.slice(); },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  };
}

/**
 * 连接本地串口代理；成功后用垫片覆盖 navigator.serial。
 * @param {object} o
 * @param {string} o.url        代理 WebSocket 地址，如 ws://127.0.0.1:8765
 * @param {(msg:string,kind?:string)=>void} [o.onStatus]  状态回调
 * @param {(ports:Array)=>Promise<object|null>} [o.pickPort]  多串口时让用户选择
 * @returns {Promise<{serial, link, close():void}>}
 */
export async function installSerialProxy({ url, onStatus, pickPort, win = globalThis.window } = {}) {
  if (!url) throw new Error("未配置串口代理地址");
  const link = new ProxyLink(url);
  link.onStatus = onStatus;
  link.onClose = () => onStatus?.("串口代理已断开", "err");
  await link.connect();

  const serial = makeSerial(link, { pickPort });
  Object.defineProperty(win.navigator, "serial", { value: serial, configurable: true });
  onStatus?.("串口代理已连接", "ok");

  return { serial, link, close: () => { try { link.ws?.close(); } catch {} } };
}
