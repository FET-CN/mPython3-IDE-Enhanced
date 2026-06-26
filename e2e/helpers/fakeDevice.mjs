// e2e/helpers/fakeDevice.mjs — 假掌控板：一个讲「串口代理协议」的 WebSocket server（Bun.serve），
// 字节层挂内存版 MicroPython FS（复用 test/helpers/microFs.mjs）。
//
// 用途：让 filePanel 的设备文件读写在**无真板/无 python 代理**下也能端到端自测——
// 跑的是真 serialProxy 垫片(ProxyLink) + 真 WebSocket + 真 exec 哨兵框定 + 真 $serial 覆盖，
// 只有物理板换成了这个假设备。与真板共用同一套单行 REPL 命令协议（见 microFs）。
//
// 协议（与 serial-proxy/m3e_serial_proxy.py 对齐）：
//   文本帧(JSON)：{type:"listPorts"} → {type:"ports",ports:[…]}；{type:"open"} → {type:"opened"}；
//                 {type:"close"} → {type:"closed"}；{type:"setSignals"} → 忽略。
//   二进制帧：= 写给板子的串口字节（filePanel 的一条命令）。假设备求值后，把输出按
//             chr(2)+'M3EFL'+payload+'M3EFL'+chr(3) 编码成二进制帧发回（喂给 exec 的 sniffer）。

import { makeMicroFs } from "../../test/helpers/microFs.mjs";

const START = "\x02M3EFL";
const END = "M3EFL\x03";

/**
 * 起一个假设备 WS server。
 * @param {object} [seed] microFs 播种（{ "/main.py":"...", "/lib":null }）
 * @returns {{ url:string, port:number, fs:object, stop:()=>void }}
 */
export function startFakeDevice(seed = {}) {
  if (typeof Bun === "undefined") throw new Error("fakeDevice 需要 Bun 运行（bun e2e/...）");
  const fs = makeMicroFs(seed);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const server = Bun.serve({
    port: 0, // 临时端口
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("fake-device", { status: 200 }); },
    websocket: {
      message(ws, message) {
        if (typeof message === "string") {
          let msg; try { msg = JSON.parse(message); } catch { return; }
          if (msg.type === "listPorts") {
            ws.send(JSON.stringify({ type: "ports", ports: [
              { path: "/dev/fake-mpython", vid: "303a", pid: "1001", manufacturer: "M3E Fake", isBoard: true },
            ] }));
          } else if (msg.type === "open") {
            ws.send(JSON.stringify({ type: "opened" }));
          } else if (msg.type === "close") {
            ws.send(JSON.stringify({ type: "closed" }));
          }
          return; // setSignals 等忽略
        }
        // 二进制帧 = 一条串口命令
        const text = dec.decode(message instanceof Uint8Array ? message : new Uint8Array(message));
        let payload;
        try { payload = fs.exec(text); } catch (e) { payload = "ERR:" + (e?.message || e); }
        if (payload === null) return; // 非本协议（握手探针等）：不回
        ws.send(enc.encode(START + payload + END));
      },
    },
  });

  const url = `ws://127.0.0.1:${server.port}`;
  return { url, port: server.port, fs, stop: () => { try { server.stop(true); } catch {} } };
}
