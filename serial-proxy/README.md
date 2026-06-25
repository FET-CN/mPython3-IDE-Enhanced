# m3e-serial-proxy · 本地串口代理

把 online.mpython.cn / 掌控板 IDE 的串口通信从浏览器 **Web Serial API** 改道到一个
**本地 Python 代理**。这样 **Firefox / Safari** 等不支持 Web Serial 的浏览器也能连接、
运行、烧录掌控板。

工作方式：书签注入的 `navigator.serial` 垫片（`src/host/serialProxy.mjs`）通过 **WebSocket**
把串口操作转发到本代理，代理用 **pyserial** 持有真实 USB 串口。网站自己的连接/运行/烧录
代码无需改动。

## 快速运行（用 uv）

无需安装，直接跑脚本（脚本头部用 PEP 723 声明了依赖，uv 会自动建临时环境）：

```bash
uv run serial-proxy/m3e_serial_proxy.py
```

或作为项目命令运行：

```bash
cd serial-proxy
uv run m3e-serial-proxy
```

默认监听 `ws://127.0.0.1:8765`。常用参数：

```bash
uv run serial-proxy/m3e_serial_proxy.py \
  --host 127.0.0.1 --port 8765 \
  --port-path /dev/ttyUSB0   # 固定串口；缺省则自动识别掌控板
```

启动后，在书签面板的「设置」里把 **「串口代理地址」** 填成 `ws://127.0.0.1:8765`
（与上面监听地址一致），刷新/重连后即可在网站里正常「连接设备」。

## 串口权限

- **Linux**：把当前用户加入 `dialout` 组后重新登录：`sudo usermod -aG dialout $USER`。
- **macOS**：一般可直接使用 `/dev/tty.usbserial-*` / `/dev/tty.wchusbserial-*`。
- **Windows**：串口形如 `COM3`，可用 `--port-path COM3` 固定。

## 协议（与垫片约定）

- **控制走文本帧（JSON）**：`listPorts` / `open` / `close` / `setSignals`，以及回包
  `ports` / `opened` / `closed` / `error`。
- **串口原始字节走二进制帧**，双向直通（写：浏览器→串口；读：串口→浏览器）。
  烧录固件依赖的 DTR/RTS 复位由网站侧通过 `setSignals` 发起，代理忠实透传给 pyserial。

详见 `m3e_serial_proxy.py` 顶部注释。

## 已知问题

- **混合内容**：网站是 HTTPS，浏览器从 HTTPS 页连 `ws://127.0.0.1` 时，Chrome 对环回地址
  有豁免（可用）；Firefox 近版本通常也放行环回，但若被拦截，需要为代理改用 `wss://`
  （自签证书并在浏览器里首次信任）。
- 页面加载时网站可能弹一次「您的浏览器暂不支持串行端口通信！」——这是加载阶段的提示，
  书签在其后注入，不影响随后点击「连接」走代理。
