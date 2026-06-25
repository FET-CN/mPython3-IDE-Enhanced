# /// script
# requires-python = ">=3.9"
# dependencies = ["pyserial>=3.5", "websockets>=12"]
# ///
"""m3e-serial-proxy 端到端测试。

用 Linux pty（伪终端）伪造一个真实串口，对 WebSocket 代理跑一遍完整协议：
listPorts → open → 浏览器→串口字节 → 串口→浏览器字节 → setSignals → close。

运行（无需 pytest）：
  uv run serial-proxy/test_proxy.py        # 直接跑脚本
或：
  cd serial-proxy && uv run python test_proxy.py

非 Linux（无 os.openpty）会自动跳过串口收发部分，仅测 listPorts 往返。
"""

import asyncio
import json
import os
import select
import sys

import websockets

from m3e_serial_proxy import handle, list_serial_ports, parse_args


def _ok(msg):
    print(f"  \033[32mPASS\033[0m {msg}")


def _fail(msg):
    print(f"  \033[31mFAIL\033[0m {msg}")
    raise SystemExit(1)


async def recv_json(ws, timeout=3):
    raw = await asyncio.wait_for(ws.recv(), timeout)
    assert isinstance(raw, str), f"期望文本帧(JSON)，收到二进制 {raw!r}"
    return json.loads(raw)


async def recv_binary(ws, timeout=3):
    raw = await asyncio.wait_for(ws.recv(), timeout)
    assert isinstance(raw, (bytes, bytearray)), f"期望二进制帧，收到文本 {raw!r}"
    return bytes(raw)


def read_master(fd, n=128, timeout=2.0):
    r, _, _ = select.select([fd], [], [], timeout)
    if not r:
        return b""
    return os.read(fd, n)


async def run():
    args = parse_args([])

    async with websockets.serve(
        lambda ws, *_: handle(ws, args), "127.0.0.1", 0, max_size=None
    ) as server:
        port = server.sockets[0].getsockname()[1]
        uri = f"ws://127.0.0.1:{port}"

        # 1) listPorts 往返
        async with websockets.connect(uri) as ws:
            await ws.send(json.dumps({"type": "listPorts"}))
            msg = await recv_json(ws)
            assert msg["type"] == "ports" and isinstance(msg["ports"], list)
            _ok(f"listPorts 返回 {len(msg['ports'])} 个串口")

        # 同时验证内部枚举不抛异常
        assert isinstance(list_serial_ports(), list)
        _ok("list_serial_ports() 正常")

        if not hasattr(os, "openpty"):
            print("  (跳过串口收发：当前平台无 os.openpty)")
            return

        # 2) 用 pty 伪造串口，测 open + 双向字节 + setSignals + close
        master_fd, slave_fd = os.openpty()
        slave_path = os.ttyname(slave_fd)
        try:
            async with websockets.connect(uri) as ws:
                await ws.send(json.dumps({"type": "open", "path": slave_path, "baudRate": 115200}))
                msg = await recv_json(ws)
                assert msg["type"] == "opened", f"open 失败：{msg}"
                _ok(f"open {slave_path} @ {msg['baudRate']}")

                # 浏览器 → 串口：二进制帧应原样落到 pty master
                await ws.send(b"hello-board")
                got = await asyncio.get_event_loop().run_in_executor(
                    None, read_master, master_fd, 128, 2.0
                )
                assert got == b"hello-board", f"串口收到 {got!r}"
                _ok("浏览器→串口 字节直通")

                # 串口 → 浏览器：写 pty master，应作为二进制帧收到
                os.write(master_fd, b"hello-host")
                got = b""
                while len(got) < len(b"hello-host"):
                    got += await recv_binary(ws)
                assert got == b"hello-host", f"浏览器收到 {got!r}"
                _ok("串口→浏览器 字节直通")

                # setSignals：pty 可能不支持调制解调器信号，代理须不崩溃（错误以 JSON 回传）
                await ws.send(json.dumps({
                    "type": "setSignals", "dataTerminalReady": False, "requestToSend": True,
                }))
                # 连接仍存活：再发一次 listPorts 应有回应
                await ws.send(json.dumps({"type": "listPorts"}))
                # 可能先收到一条 setSignals 的 error，跳过非 ports 文本帧
                for _ in range(3):
                    raw = await asyncio.wait_for(ws.recv(), 3)
                    if isinstance(raw, str) and json.loads(raw).get("type") == "ports":
                        break
                else:
                    _fail("setSignals 后连接异常")
                _ok("setSignals 已透传且连接存活")

                # close
                await ws.send(json.dumps({"type": "close"}))
                msg = await recv_json(ws)
                assert msg["type"] == "closed", f"close 返回 {msg}"
                _ok("close 正常")
        finally:
            os.close(master_fd)
            try:
                os.close(slave_fd)
            except OSError:
                pass


def main():
    print("m3e-serial-proxy 端到端测试")
    try:
        asyncio.run(asyncio.wait_for(run(), timeout=20))
    except Exception as e:  # noqa: BLE001
        _fail(f"未捕获异常：{type(e).__name__}: {e}")
    print("\033[32m全部通过\033[0m")


if __name__ == "__main__":
    sys.exit(main())
