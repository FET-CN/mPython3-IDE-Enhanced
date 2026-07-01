# AGENTS.md

本文件为 AI 编码助手（Claude Code、Codex 等）提供在本仓库工作时的指引。
`CLAUDE.md` 通过 `@AGENTS.md` 引用本文件，两者内容一致。

## 项目简介

把中文自然语言转成 Blockly 积木并注入 online.mpython.cn / 掌控板 IDE 的 LLM 书签工具。
现已是**多轮对话式编码助手**：聊天面板里一轮用户输入 → 工具调用 agent 循环（流式回复 +
按需调用工具）→ 渲染。底层仍复用「生成 → 校验 → 修复」能力——它内嵌在 `edit_blocks`
工具里（主循环本身就是修复循环，无嵌套 LLM）。会话状态仅在内存，刷新即清空。

## 适配的板子（仅两款）

站点本身支持多种主控，但本项目**只适配掌控板系列**（均为 ESP32 跑 MicroPython）。板子由站点的
`masterControl`（localStorage / Vuex state）标识，`src/kb/knowledge.mjs` 的 `boardFromMaster()` 据此解析：

| 内部名 `masterControl` | 中文名 | 版本 | 芯片 |
| --- | --- | --- | --- |
| `mPython`（空/未设也按此默认） | 掌控板 | `v2` | ESP32 |
| `mPython_V3` | 掌控板V3 | `v3` | ESP32-S3 |

其余 `masterControl` 值一律 `supported:false`（面板提示「不支持」）。**注意区分**：站点代码里出现的
`new1956Files` / `expandTree` / `root@TinaLinux` shell / `ls "..."` 是**另一类 Linux 主控板**（行空板
那类，非掌控板），与本项目无关，排查掌控板问题时不要顺着那条链路走。

## 命令（使用 Bun，不要用 npm）

- `bun install` —— 安装依赖
- `bun run build` —— 完整重建：catalog + knowledge + **css** + bookmarklet（**需要 `vendor/`，见下文**）
- `bun run build:bookmarklet` —— 仅从已提交的 `data/` 组装 `dist/`，无需私有数据
- `bun run build:css` —— 预编译 Tailwind 到 `src/ui/styles.generated.mjs`（见 UI 约束）
- `bun run build:term-font` —— 用系统/本地 Noto Sans Mono CJK SC（或 `M3E_TERM_FONT_WOFF2` 指定的本地 woff2）重新生成 `src/host/termFont.mjs`（内嵌等宽 web 字体的纯数据模块）。生成物已提交，**不入 `build`**；缺失/加载失败时各字体修复优雅降级到裸 `monospace`。
- `bun run build:css:modern` —— 用 **Tailwind v4**（`@tailwindcss/cli`，包别名 `tailwindcss4`，与 classic 的 v3 共存）从 `src/ui/tailwind.modern.css` 预编译到 `src/ui/stylesModern.generated.mjs`。改了 modern 面板/图标类名后重跑。生成物已提交，**不入 `build`**。
- `bun run build:fonts:modern` —— 抓取/子集化 Geist + Sarasa Gothic SC + Sarasa Mono SC（3500 通用规范一级字 + ASCII + CJK 标点，Regular/较重两重，woff2+base64）到 `src/ui/fontsModern.generated.mjs`。env 源 `M3E_MODERN_GEIST_DIR` / `M3E_MODERN_SARASA_DIR`（缺失则从上游 release 下载）。生成物已提交，**不入 `build`**；加载失败优雅降级 system-ui/monospace。
- `bun run dump:toolbox` —— **联网**用 Playwright 抓 online.mpython.cn 两块板的侧边栏可见积木，刷新 `data/toolbox.visible.json`（带时效快照，不入 `build`）
- `bun run test` —— Vitest 单元/属性测试（T0 层）
- `bun run verify` —— 提交前快速验证：`build:bookmarklet` + `test`
- `bun run e2e:smoke` / `e2e:ask` / `e2e:inject` / `e2e:patch` —— Playwright E2E（T2，需访问真实站点）
- `bun run e2e:filepanel` —— 文件面板 T2：默认仅跑 **Part B**（真 serialProxy 垫片 ←WS→ **假设备**内存 MicroPython FS，无需真板/网络）做设备文件读写全链路；`M3E_E2E_SITE=1` 追加 **Part A**（真站渲染机制冒烟）
- `M3E_API_KEY=... bun run eval` —— T3 LLM 评测，需 OpenAI 兼容 API key
- `uv run serial-proxy/m3e_serial_proxy.py` —— 启动本地串口代理（Web Serial 替身，让 Firefox 等连板）；`uv run python serial-proxy/test_proxy.py` 跑其端到端测试

## vendor / data 数据流程（关键）

- `data/`（`catalog.*.json` + `knowledge/`）是**已提交的源码**，正常贡献**无需重建**。
- `vendor/` 是私有的逆向导出，**永不提交**，仅用于重新生成 `data/`。
- 仅当更新积木/知识时，才需在 `vendor/` 放置导出（`M3E_REVERSE_DIR` / `M3E_BLOCK_EXPORT_DIR` / `M3E_HANDPY_SKILL_DIR`）后跑 `bun run build`，且**只提交 `data/`**。
- **没有这些导出时去哪下**（详见 `CONTRIBUTING.md`「数据来源」表）：积木定义导出 `M3E_BLOCK_EXPORT_DIR` 取自 <https://labplus.cn/posts/6a093a1247fb2875e3a42414>（**有时效性**，当前 `data/` 基于 20260517 导出）；HandPy 技能文档 `M3E_HANDPY_SKILL_DIR` 取自 <https://github.com/gxxk-dev/HandPy-Skill>（指向其 `skills/handpy`）；`M3E_REVERSE_DIR` 为私有逆向导出。可用 `.env`（Bun 自动加载）配置三处路径。

## 模块结构

- `src/host/` —— **防腐层**：所有对 `window.vm` / Vuex store / 站点的访问。读写工作区、注入/快照、运行程序与回读串口均在此。串口适配 `serialProxy.mjs`（`navigator.serial` 垫片，经 WebSocket 接本地 `serial-proxy/`，让 Firefox 等也能连板）也归此层。
- `src/agent/` —— agent 循环与工具：`loop.mjs`（流式 + 只读并发/写串行）、`history.mjs`（含 `/compact` 与缓存断点）、`commands.mjs`（斜杠命令）、`tools/*`（见下）。
- `src/ctx/agent-prompt.mjs` —— 组装可缓存的系统提示词（身份 + 工具说明 + 算子语法 + 核心词汇）。
- `src/ui/panel.mjs` —— Shadow DOM 聊天面板「classic」主题（纯视图，回调交给 `main.mjs`；Tailwind v3 预编译到 `styles.generated.mjs`）。
- `src/ui/panelModern.mjs` —— 与 `panel.mjs` **公共 API 完全一致**的「modern」主题面板（uidotsh 规范：单蓝点缀、Heroicons Micro、内嵌 Geist/Sarasa 字体、Tailwind v4）。经 `panelModern.entry.mjs` 打成独立 `dist/modern.min.js` 懒加载；默认 classic 主包零负担。
- `src/runtime/log.mjs` —— 运行时日志（见日志约定）。
- `src/main.mjs` —— 入口：检测宿主、装配上下文、把面板事件接到 agent 循环。

### 工具集（`src/agent/tools/`）

只读工具（并发执行）：`read_workspace`、`search_blocks`、`think`、`update_todos`。
写/交互工具（串行执行）：`edit_blocks`（写，`needsConfirm`，应用后回传转换的 Python 供模型自检）、
`run_code`（操作设备，`needsConfirm`）、`ask_user`（结构化澄清提问，阻塞等待用户选择）。
新增工具时在 `tools/` 建模块并注册进 `tools/index.mjs`；遵循 `{name, description, parameters, isReadOnly, needsConfirm, run}` 接口。

## 架构约束

- **防腐层**：所有对 `window.vm` / 站点的访问必须集中在 `src/host/`，其他模块不得直接触碰宿主环境。
- **系统提示词保持稳定**：`src/ctx/prompts.mjs` 与 `src/ctx/agent-prompt.mjs` 是会被缓存的稳定前缀，改动需谨慎、尽量保持稳定。
- **类型校验宽松**：`src/xml/validate.mjs` 只标记模型生成的错误，不做严格类型系统。
- **UI 样式离线编译**：宿主页跑不了 Tailwind 运行时，故 `tools/build-css.mjs` 把 Tailwind 预编译进 `src/ui/styles.generated.mjs`（**已提交**）并内联到 Shadow DOM。改了 `src/ui/**` 的类名后需 `bun run build:css` 重新生成。
- **宿主字体内嵌（控制台 / Agent 对话框 / Ace / 面板代码块）**：`src/host/font.mjs` 统一注册内嵌等宽 web 字体（`src/host/termFont.mjs`，Noto Sans Mono CJK SC Regular，**生成且提交**，由 `bun run build:term-font` 再生成；OFL 见 `src/host/NotoSansCJK-OFL.txt`），覆盖代码、西文符号、中文注释与串口输出。`src/host/termFix.mjs` 修站点 xterm 控制台「字距散开」——某些系统（Linux/Firefox）上具名等宽字体被 fontconfig 换成比例字体，测量元素按比例字宽排版 → 散开；因此用 **FontFace API** 注册 + 最小 `!important` CSS 钉到 `.xterm`、helper textarea 与字符测量元素，并按**真实测量字宽**重排。`src/host/hostFontFix.mjs` 同步把宿主页 AICG 对话框代码/输入框与 Ace 编辑器钉到同一字体；Shadow DOM 面板仍通过 Tailwind 预编译到 `styles.generated.mjs`。
- **文件面板启用（防腐层）**：`src/host/filePanel.mjs` 统一收纳「让网页版用上站点文件管理面板」的全部驯服代码——站点把整块 `#mNoteCatalog`（电脑/掌控板文件两 tab）门控在 `isElectron` 后，网页版恒不渲染。模块四段：① `window.routerDesk` no-op Proxy + 少量 `$serial` Electron-only 方法护栏（表驱动，新增只加一行），**含云端-电脑同步桥护栏**（`synchroFn`/`uploadToMPUF`/`synchroHand`/批量 `delList` 在站点里全是 `project` 语义，走 `$axios` 打 `/api/*` 后端桥——桌面端有后端 agent 代为推送，**网页版根本没有那条桥**，且组件失败路径常漏 `progressFlash` 会卡死 0%；故 `cloudBridgeStub` 返回「让调用组件干净收尾」的安全值 + 必收进度条 + 友好提示，**不接管成设备操作**——设备文件的删/存/传实际走已接管的 `$serial.delFile/saveFile(...,"mPythonList")`）；② **实例级**把渲染文件面板的 Vue 组件（`$options.name==="mNoteBox"`）的 `isElectron` 覆盖为 true（`Object.defineProperty` + `$forceUpdate`，组件延迟挂载时用 observer 兜底）——**不翻全局 `state.isElectron`**：顶部「连接设备」按钮渲染条件为 `isElectron||connectName?隐藏`，翻全局会连带隐藏连接入口（实测回归：无法 `requestPort` → 连不上板）；连接按钮与文件面板分属不同组件实例，故只覆盖 `mNoteBox` 一个即两全；③ 设备文件 `$serial` 覆盖（注册表驱动，按第二参 `mode==="mPythonList"` 分流到串口、否则透传站点 `$axios` 原实现）；④ 经 `serialProxy.link.exec` 跑 MicroPython 单行命令（`chr(2)/chr(3)` 哨兵框定、promise-chain 互斥、仅 REPL 空闲时）。纯函数（解析/命令构造/base64 分块）独立导出便于 T0；设备可由 `e2e/helpers/fakeDevice.mjs`（假代理 WS + 内存 FS，复用 `test/helpers/microFs.mjs`）替身，全链路自测无需真板。
- **图标统一用 SVG**：UI 内**不得出现 unicode emoji**，图标走 `panel.mjs` 的 `ICON` 注册表（按名解析 SVG）；modern 主题走 `src/ui/iconsMicro.mjs`（Heroicons Micro 16px，同名语义键）。
- **modern 主题（opt-in，默认 classic，运行时可切）**：在 classic 之外**新增**一套遵循 uidotsh 的「modern」主题，与 classic **新旧共存、零回归**（`panel.mjs` / `styles.generated.mjs` / `tailwind.config.cjs` **冻结不改**）。构成：`src/ui/panelModern.mjs`（与 `panel.mjs` **公共 API 完全一致**的纯视图，视觉换 zinc+单蓝 / Heroicons Micro / 内嵌 Geist+Sarasa 字体）、`iconsMicro.mjs`、`stylesModern.generated.mjs`（Tailwind **v4** 产出，`tailwind.modern.css` 分层跳 preflight + `@custom-variant dark` 类驱动；v3/v4 同名包冲突故 v4 以 `tailwindcss4` 别名引入，classic 的 `build-css.mjs` 显式钉 v3 CLI）、`fontsModern.generated.mjs`（Geist + Sarasa Gothic SC + Sarasa Mono SC 子集 3500 一级字 woff2 base64，**生成且提交**，OFL 见 `src/ui/OFL.txt`/`OFL-Sarasa.txt`；按 OFL 重命名 family 为 `M3E Geist`/`M3E Sarasa`/`M3E Sarasa Mono`）、`fontsModern.mjs`（FontFace 激活器，失败优雅降级 system-ui/monospace）。切换靠斜杠命令 `/theme classic|modern`（写 `localStorage m3e_theme`）或 modern 面板设置区的主题 select，`main.mjs` 据此 remount（history/session 保留）。modern 资产（面板+CSS+字体）**独立打包为 `dist/modern.min.js`**，`main.mjs` 仅在选中 modern 时懒加载（`import(base+'/modern.min.js')`），**默认 classic 主包零 modern 负担**；无 base（dev 注入）或加载失败 → 优雅回落 classic。`build:css:modern`/`build:fonts:modern` 为按需脚本（生成物已提交，**不入 `build`**，同 term-font 惯例）。`blockTree.mjs` 调色板参数化（`MODERN_PALETTE` 全折叠到 zinc + 单蓝，**无 indigo**），classic 默认零变化。
- **积木默认偏好「积木栏当前可见」**：积木栏当前展示 `mpython3_*`（事件帽子等）+ 一批改名后的新 `mpython_*`（如 `set_RGB`→`set_rgb_list_color`、`display_circle`→`display_shape_circle`），应优先于已下架旧块。实现两层：① `kb/retriever.preferredTypes()` 始终注入 mpython3「新一代积木」卡片节，`agent-prompt.RETIRED_BLOCKS` 给出旧→新改名清单；② `data/toolbox.visible.json`（按板的侧边栏可见集，**Playwright 抓的带时效快照**）驱动 `coreTypes(index,board,visibleSet)`（核心词汇 ∩ 可见，剔除下架块）与 `retrieve(...,{visibleSet})` 加权。`toolbox.visible.json` 由 `bun run dump:toolbox` **联网**刷新，**不入 `bun run build`**；缺失时优雅降级（不过滤）。
- **积木默认偏好 mpython3 新一代**：积木栏当前展示的是 `mpython3_*`（事件帽子「当…时」、线程、自定义事件、新版 IoT 接收器），应优先于旧的 `mpython_*` 轮询写法，仅在无新版时退回旧积木。实现：`kb/retriever.preferredTypes()` 始终把这批积木注入系统提示词的「新一代积木」稳定卡片节，`retrieve(..., preferGroups:["mpython3"])` 在检索排序中加权；旧积木**不做整体过滤**（多数无新版等价物，仍是当前积木）。

## 日志约定

- 运行时诊断只走信息级通道——`console.log` / `console.info` / `console.debug`，**不要**用 `console.error` / `console.warn`（用户可见的失败由面板呈现）。
- 统一经 `src/runtime/log.mjs`（`[m3e]` 前缀），agent 循环会打印装配的上下文、模型工具调用与结果。

## 约定

- 直接提交到 `main` 分支（小项目，无强制 PR 流程）；倾向**一个 feature 一个 commit**。
- 助手对用户的输出一律 **zh-CN**；**斜杠命令名用英文**（描述用中文）。
- 无格式化工具 / linter —— 沿用现有 JS 风格（ES modules、`.mjs`），注释即文档。
- License 为 **AGPL-3.0-or-later**，网络著佐权对 web 服务生效。
