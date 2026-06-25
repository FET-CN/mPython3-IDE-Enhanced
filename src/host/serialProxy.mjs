// src/host/serialProxy.mjs — navigator.serial 垫片（polyfill）。
//
// 防腐层的一部分：唯一允许触碰 window.navigator / WebSocket 的串口模块。把网站对
// Web Serial 的调用透明地转发给本地 Python 代理（serial-proxy/，通过 WebSocket），
// 让 Firefox / Safari 等没有 Web Serial 的浏览器也能连接、运行、烧录掌控板。
//
// 与代理的约定：控制消息走「文本帧（JSON）」，串口原始字节走「二进制帧」。
// 仅当成功连上代理后才覆盖 navigator.serial；连不上则抛错、保持页面原状。

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
    if (this.rxController) {
      try { this.rxController.enqueue(u8); } catch {}
    } else {
      this.rxBuffer.push(u8);
    }
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
  sendBinary(u8) { try { this.ws.send(u8); } catch {} }

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
      const res = await link.request(
        { type: "open", path: info.path, baudRate },
        ["opened", "error"],
      );
      if (res.type === "error") throw new Error(res.message || "打开串口失败");

      readable = new ReadableStream({
        start: (controller) => link.attachReader(controller),
        cancel: () => link.detachReader(),
      });
      writable = new WritableStream({
        write: (chunk) => {
          // 网站用 TextEncoder().encode(...) → Uint8Array；esptool 也写 Uint8Array/ArrayBuffer。
          link.sendBinary(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        },
      });
    },

    async close() {
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
      const boards = ports.filter((p) => p.isBoard);
      let chosen;
      if (boards.length === 1) chosen = boards[0];
      else if (!boards.length && ports.length === 1) chosen = ports[0];
      else chosen = await pickPort?.(ports);
      if (!chosen) throw new DOMException("未选择串口", "NotFoundError");
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
