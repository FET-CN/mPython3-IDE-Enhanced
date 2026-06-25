# AGENTS.md

本文件为 AI 编码助手（Claude Code、Codex 等）提供在本仓库工作时的指引。
`CLAUDE.md` 通过 `@AGENTS.md` 引用本文件，两者内容一致。

## 项目简介

把中文自然语言转成 Blockly 积木并注入 online.mpython.cn / 掌控板 IDE 的 LLM 书签工具。
现已是**多轮对话式编码助手**：聊天面板里一轮用户输入 → 工具调用 agent 循环（流式回复 +
按需调用工具）→ 渲染。底层仍复用「生成 → 校验 → 修复」能力——它内嵌在 `edit_blocks`
工具里（主循环本身就是修复循环，无嵌套 LLM）。会话状态仅在内存，刷新即清空。

## 命令（使用 Bun，不要用 npm）

- `bun install` —— 安装依赖
- `bun run build` —— 完整重建：catalog + knowledge + **css** + bookmarklet（**需要 `vendor/`，见下文**）
- `bun run build:bookmarklet` —— 仅从已提交的 `data/` 组装 `dist/`，无需私有数据
- `bun run build:css` —— 预编译 Tailwind 到 `src/ui/styles.generated.mjs`（见 UI 约束）
- `bun run test` —— Vitest 单元/属性测试（T0 层）
- `bun run verify` —— 提交前快速验证：`build:bookmarklet` + `test`
- `bun run e2e:smoke` / `e2e:ask` / `e2e:inject` / `e2e:patch` —— Playwright E2E（T2，需访问真实站点）
- `M3E_API_KEY=... bun run eval` —— T3 LLM 评测，需 OpenAI 兼容 API key

## vendor / data 数据流程（关键）

- `data/`（`catalog.*.json` + `knowledge/`）是**已提交的源码**，正常贡献**无需重建**。
- `vendor/` 是私有的逆向导出，**永不提交**，仅用于重新生成 `data/`。
- 仅当更新积木/知识时，才需在 `vendor/` 放置导出（`M3E_REVERSE_DIR` / `M3E_BLOCK_EXPORT_DIR` / `M3E_HANDPY_SKILL_DIR`）后跑 `bun run build`，且**只提交 `data/`**。

## 模块结构

- `src/host/` —— **防腐层**：所有对 `window.vm` / Vuex store / 站点的访问。读写工作区、注入/快照、运行程序与回读串口均在此。
- `src/agent/` —— agent 循环与工具：`loop.mjs`（流式 + 只读并发/写串行）、`history.mjs`（含 `/compact` 与缓存断点）、`commands.mjs`（斜杠命令）、`tools/*`（见下）。
- `src/ctx/agent-prompt.mjs` —— 组装可缓存的系统提示词（身份 + 工具说明 + 算子语法 + 核心词汇）。
- `src/ui/panel.mjs` —— Shadow DOM 聊天面板（纯视图，回调交给 `main.mjs`）。
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
- **图标统一用 SVG**：UI 内**不得出现 unicode emoji**，图标走 `panel.mjs` 的 `ICON` 注册表（按名解析 SVG）。
- **积木默认偏好 mpython3 新一代**：积木栏当前展示的是 `mpython3_*`（事件帽子「当…时」、线程、自定义事件、新版 IoT 接收器），应优先于旧的 `mpython_*` 轮询写法，仅在无新版时退回旧积木。实现：`kb/retriever.preferredTypes()` 始终把这批积木注入系统提示词的「新一代积木」稳定卡片节，`retrieve(..., preferGroups:["mpython3"])` 在检索排序中加权；旧积木**不做整体过滤**（多数无新版等价物，仍是当前积木）。

## 日志约定

- 运行时诊断只走信息级通道——`console.log` / `console.info` / `console.debug`，**不要**用 `console.error` / `console.warn`（用户可见的失败由面板呈现）。
- 统一经 `src/runtime/log.mjs`（`[m3e]` 前缀），agent 循环会打印装配的上下文、模型工具调用与结果。

## 约定

- 直接提交到 `main` 分支（小项目，无强制 PR 流程）；倾向**一个 feature 一个 commit**。
- 助手对用户的输出一律 **zh-CN**；**斜杠命令名用英文**（描述用中文）。
- 无格式化工具 / linter —— 沿用现有 JS 风格（ES modules、`.mjs`），注释即文档。
- License 为 **AGPL-3.0-or-later**，网络著佐权对 web 服务生效。
