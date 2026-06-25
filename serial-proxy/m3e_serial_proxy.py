# /// script
# requires-python = ">=3.9"
# dependencies = ["pyserial>=3.5", "websockets>=12"]
# ///
"""m3e-serial-proxy — 本地串口代理。

把浏览器里 `navigator.serial` 垫片（src/host/serialProxy.mjs）通过 WebSocket 转发来的
串口操作，落到真实的 USB 串口上（pyserial 持有）。让 Firefox / Safari 等没有 Web Serial
的浏览器也能用 online.mpython.cn / 掌控板 IDE 连接、运行、烧录。

协议（与垫片约定）：
  - 控制消息走「文本帧（JSON）」：
      浏览器 → 代理：
        {"type":"listPorts"}
        {"type":"open", "path":<可空>, "baudRate":115200}
        {"type":"close"}
        {"type":"setSignals", "dataTerminalReady":bool, "requestToSend":bool, "break":bool}
      代理 → 浏览器：
        {"type":"ports", "ports":[{path,vid,pid,manufacturer,isBoard}, ...]}
        {"type":"opened", "path":..., "baudRate":...}
        {"type":"closed"}
        {"type":"error", "message":...}
  - 串口原始字节走「二进制帧」，双向直通（写：浏览器→串口；读：串口→浏览器）。

快速运行（推荐，无需安装）：
  uv run serial-proxy/m3e_serial_proxy.py
或作为已安装的命令：
  cd serial-proxy && uv run m3e-serial-proxy
"""

import argparse
import asyncio
import json
import logging
import threading

import serial
from serial.tools import list_ports
import websockets

log = logging.getLogger("m3e-serial-proxy")

# 掌控板常见 USB-UART 芯片的厂商 ID：303A=Espressif(原生USB)，1A86=CH340/CH9102。
BOARD_VIDS = {0x303A, 0x1A86}


def list_serial_ports():
    """枚举系统串口，按掌控板 VID 标注 isBoard。"""
    out = []
    for p in list_ports.comports():
        vid, pid = p.vid, p.pid
        out.append({
            "path": p.device,
            "vid": f"{vid:04X}" if vid is not None else None,
            "pid": f"{pid:04X}" if pid is not None else None,
            "manufacturer": p.manufacturer or p.description or "",
            "isBoard": (vid in BOARD_VIDS) if vid is not None else False,
        })
    return out


def pick_default_path(explicit):
    """未指定端口时：优先掌控板，其次第一个可用串口。"""
    if explicit:
        return explicit
    ports = list_serial_ports()
    board = next((p["path"] for p in ports if p["isBoard"]), None)
    if board:
        return board
    return ports[0]["path"] if ports else None


async def handle(ws, args):
    """单个 WebSocket 连接：一次服务一块板。"""
    loop = asyncio.get_running_loop()
    state = {"ser": None, "reader": None, "running": False, "rx": 0, "tx": 0}

    def stop_reader():
        state["running"] = False
        t = state["reader"]
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=1)
        state["reader"] = None

    def close_serial():
        stop_reader()
        ser = state["ser"]
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass
        state["ser"] = None

    def reader_loop(ser):
        """后台线程：阻塞读串口，把字节作为二进制帧发回浏览器。"""
        while state["running"]:
            try:
                n = ser.in_waiting
                data = ser.read(n or 1)  # timeout=0.05 → 无数据时最多阻塞 50ms，避免空转
            except Exception as e:
                log.warning("串口读取失败：%s", e)
                _schedule(ws.send(json.dumps({"type": "error", "message": f"串口读取失败：{e}"})))
                break
            if not data:
                continue
            if state["rx"] == 0:
                log.info("◀ 串口首批数据 %d 字节（板子→浏览器 通）", len(data))
            state["rx"] += len(data)
            log.debug("◀ rx %dB 累计 %d: %r", len(data), state["rx"], data[:40])
            fut = _schedule(ws.send(data))
            if fut is None:
                break
            try:
                fut.result()  # 背压：等这帧发完再读下一批
            except Exception:
                break

    def _schedule(coro):
        try:
            return asyncio.run_coroutine_threadsafe(coro, loop)
        except Exception:
            return None

    async def open_serial(path, baud):
        close_serial()
        path = pick_default_path(path or args.port_path)
        if not path:
            await ws.send(json.dumps({"type": "error", "message": "未找到可用串口"}))
            return
        try:
            ser = serial.Serial(
                path,
                baudrate=int(baud or args.baud),
                timeout=0.05,
                write_timeout=3,
            )
        except Exception as e:
            log.warning("打开串口失败：%s", e)
            await ws.send(json.dumps({"type": "error", "message": f"打开串口失败：{e}"}))
            return
        state["ser"] = ser
        state["running"] = True
        t = threading.Thread(target=reader_loop, args=(ser,), daemon=True)
        state["reader"] = t
        t.start()
        await ws.send(json.dumps({"type": "opened", "path": path, "baudRate": ser.baudrate}))
        log.info("opened %s @ %d", path, ser.baudrate)

    try:
        async for msg in ws:
            # 二进制帧 = 串口原始写
            if isinstance(msg, (bytes, bytearray)):
                ser = state["ser"]
                if ser is not None:
                    try:
                        ser.write(msg)
                        if state["tx"] == 0:
                            log.info("▶ 首次写入串口 %d 字节（浏览器→板子 通）", len(msg))
                        state["tx"] += len(msg)
                        log.debug("▶ tx %dB 累计 %d: %r", len(msg), state["tx"], bytes(msg[:40]))
                    except Exception as e:
                        await ws.send(json.dumps({"type": "error", "message": f"串口写入失败：{e}"}))
                else:
                    log.warning("收到写数据但串口未打开，已丢弃 %d 字节", len(msg))
                continue

            # 文本帧 = 控制 JSON
            try:
                m = json.loads(msg)
            except Exception:
                continue
            t = m.get("type")
            if t == "listPorts":
                await ws.send(json.dumps({"type": "ports", "ports": list_serial_ports()}))
            elif t == "open":
                await open_serial(m.get("path"), m.get("baudRate"))
            elif t == "close":
                close_serial()
                await ws.send(json.dumps({"type": "closed"}))
            elif t == "setSignals":
                ser = state["ser"]
                if ser is None:
                    continue
                try:
                    if "dataTerminalReady" in m:
                        ser.dtr = bool(m["dataTerminalReady"])
                    if "requestToSend" in m:
                        ser.rts = bool(m["requestToSend"])
                    if "break" in m:
                        ser.break_condition = bool(m["break"])
                    log.info("⚙ setSignals DTR=%s RTS=%s（板子复位脉冲）",
                             getattr(ser, "dtr", None), getattr(ser, "rts", None))
                except Exception as e:
                    log.warning("setSignals 失败：%s", e)
                    await ws.send(json.dumps({"type": "error", "message": f"设置信号失败：{e}"}))
            else:
                log.debug("未知控制消息：%s", t)
    except websockets.ConnectionClosed:
        pass
    finally:
        close_serial()
        log.info("连接关闭（本次会话 rx=%d tx=%d 字节）", state["rx"], state["tx"])


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="mPython3 IDE 本地串口代理（Web Serial 替身）")
    ap.add_argument("--host", default="127.0.0.1", help="WebSocket 监听地址（默认 127.0.0.1）")
    ap.add_argument("--port", type=int, default=8765, help="WebSocket 监听端口（默认 8765）")
    ap.add_argument("--port-path", default=None, help="固定串口路径（如 /dev/ttyUSB0、COM3）；缺省则自动识别")
    ap.add_argument("--baud", type=int, default=115200, help="默认波特率（默认 115200）")
    ap.add_argument("-v", "--verbose", action="store_true", help="打印每一帧串口收发（调试用）")
    return ap.parse_args(argv)


async def main_async(args):
    # max_size=None：允许大二进制帧（烧录固件分块可能较大）。
    async with websockets.serve(
        lambda ws, *_: handle(ws, args), args.host, args.port, max_size=None
    ):
        log.info("listening on ws://%s:%d", args.host, args.port)
        log.info("在书签设置里把「串口代理地址」填成上面这个地址即可。")
        await asyncio.Future()  # run forever


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        log.info("bye")


if __name__ == "__main__":
    main()
