# mPython3-IDE-Enhanced

> 为 [`online.mpython.cn`](https://online.mpython.cn/)（mPython 0.8.7，基于 **Blockly** 的掌控板在线 IDE）打造的 **AI 图形化编程书签**：在地址栏执行一段 `javascript:` 书签即可唤出对话面板，用中文描述需求，LLM 直接**生成图形化积木并注入工作区**。

核心理念：把图形化积木当成一门 LLM 没学过的**新语言**来教 —— LLM 只产出一个紧凑、可校验的**编辑算子计划**（基于一套中间表示 IR），由确定性编译器转成 Blockly XML 注入；配合类型校验、表达式简写与自我修复回环保证正确性。

---

## 工作原理

```
用户中文需求
  → 读取当前工作区 IR（带稳定 id）+ 可落点锚点         host/read · host/ops
  → 检索相关积木（kb/retriever）                       L3 词汇
  → 装配稳定系统提示词 + 工具 schema（ctx/agent-prompt）   L0 语言/算子规范 + 核心词汇 + few-shot
  → LLM 调用 edit_blocks（agent/loop + llm/client）       OpenAI 兼容 tool_calls；结构预检失败即回馈重试
  → 表达式简写展开（ir/expr）                          inputs 里的扁平算式字符串 → 值积木树
  → 类型校验（xml/validate）                           未知类型/越界枚举/错位/类型不匹配 + 修正建议
  → 应用算子（host/ops.applyOps）                      clear / insert / delete / move / setField
  → 编译 IR→XML（xml/compile）→ 注入（host/inject）     window.vm.$store.commit('loadXMLCode')
  → 加锁/快照/撤销（host/lock）
```

### 三层防错（让模型参数错误在注入前收敛）
1. **结构化工具参数**：`edit_blocks` 用闭合、递归的 JSON Schema 描述 Wire DTO；动态 `fields/inputs/statements` map 在传输层编码为具名条目数组，客户端校验并解码回内部 IR。模型不“重写整个程序”，而是对带 id 的当前工作区下达 `insert/delete/move/setField/clear` 算子。
2. **表达式简写**：值插槽可直接写一行标准算式字符串（如 `"x": "20 + 20*cos(angle)"`），宿主确定性地展开成 `math_arithmetic/math_trig/...` 积木树——从源头消灭最易出错的深层嵌套。文法收敛到现有积木集合，文法外写法报错回喂而非臆造。
3. **语义校验 + 修复回环**：schema 负责形状，catalog 校验继续负责真实 block type、字段、插槽、枚举和连接类型；失败会在确认前精确回馈模型重试。旧文本 pipeline 仍保留有界 JSON 括号修复，所有路径都绝不静默注入。

---

## 快速开始

需要 [Bun](https://bun.sh/)。

```bash
git clone https://github.com/FET-CN/mPython3-IDE-Enhanced.git
cd mPython3-IDE-Enhanced
bun install

bun run build:bookmarklet   # 从已提交的 data/ 组装可托管的 dist/（无需任何私有数据）
bun run test                # 运行单元与属性测试
```

> 仓库已内置积木目录与板子知识（`data/`），所以**克隆即可构建出可用书签**，无需逆向原始站点。

### 托管 + 安装

书签运行时会从你托管 `dist/` 的地址跨域 `fetch` 数据，所以托管需开启 **CORS**。

```bash
# 设定托管基址后组装 dist/（基址会写进书签与安装页）
M3E_HOST_BASE=https://你的域名/path bun run build:bookmarklet

# 本地自测：任意带 CORS 的静态服务器
bunx serve dist --cors -l 8080
# 或： python3 -m http.server 8080 -d dist
```

打开 `dist/install.html`，把按钮拖到书签栏。再打开 `online.mpython.cn` → 点书签 → 右侧面板 → ⚙ 填入 **OpenAI 兼容**的 Base URL / API Key / 模型 → 输入中文需求 → 生成并应用。

#### 用 GitHub Pages 一键托管（推荐）
本仓库自带 `.github/workflows/pages.yml`：**Fork 后在仓库 Settings → Pages 选择 “GitHub Actions”**，推送即自动构建并发布 `dist/`，托管基址自动设为你的 Pages 地址。访问 `https://<你的用户名>.github.io/mPython3-IDE-Enhanced/install.html` 安装。

#### 在 Firefox / Safari 上连接掌控板（本地串口代理）
`online.mpython.cn` 的「连接设备 / 运行 / 烧录」依赖浏览器 **Web Serial API**，目前只有 Chromium 系支持。
本仓库提供 `serial-proxy/`——一个用 **uv** 跑的本地串口代理：书签注入的 `navigator.serial` 垫片把串口操作经
**WebSocket** 转发给它，由 `pyserial` 持有真实串口。这样 **Firefox / Safari** 也能用。

1. 启动代理（无需安装）：`uv run serial-proxy/m3e_serial_proxy.py`（默认 `ws://127.0.0.1:8765`）。
2. 书签面板 ⚙ 里把 **「串口代理地址」** 填成 `ws://127.0.0.1:8765` → 保存。
3. 回到网站点「连接设备」即可——串口将走本地代理（多个串口时会在面板里让你选）。

留空该地址则不接管，仍用浏览器原生 Web Serial（Chrome）。详见 [`serial-proxy/README.md`](serial-proxy/README.md)。

---

## 多轮助手与 SubAgent

复杂任务可由主助手并行派给多个 **SubAgent** 查资料、读工作区、规划或审查，再汇总成一个答复。四种内置角色分别是：

| 角色 | 用途 |
|---|---|
| `general-purpose` | 综合研究与分析 |
| `explore` | 探索工作区、查证积木与事实 |
| `plan` | 制定实现步骤、边界与验收方案 |
| `review` | 审查正确性、风险和遗漏 |

- **前台任务**会阻塞当前回复直至完成，并随主回合的「停止」一起取消；**后台任务**立即返回任务 ID，在任务栏持续显示状态，运行时需单独停止。
- 后台任务完成后不会自行触发主助手回复；结果会从下一次普通用户输入开始注入上下文，由主助手结合新问题处理。同一时刻结果过多时会按上下文容量顺延，每项只投递一次。
- 输入 `/agents` 展开任务栏，或用 `/agents <ID或名称>` 定位任务。助手也可继续向运行中的任务发消息，或用同一 ID 恢复已结束任务。
- SubAgent 严格只读，只能读取工作区、检索积木和分析；不能修改积木、运行设备、向用户提问或继续派生 SubAgent。最终写入仍由主助手重新读取工作区后执行。
- 任务、记录与通知只保存在当前页面内存中；刷新页面或 `/clear` 会全部清空，`/compact` 则保留它们。

---

## 数据与构建

| 目录 | 是否提交 | 内容 | 谁生成 |
|---|---|---|---|
| `data/` | ✅ 提交（视作源数据） | 积木类型目录 `catalog.{index,full,meta}.json` + 板子知识 `knowledge/**` | `build:catalog` / `build:knowledge` |
| `tools/data/` | ✅ 提交（源码） | 手写补丁：标准 Blockly 积木、few-shot 种子、知识核心/触发词/反模式 | 人工维护 |
| `dist/` | ❌ 忽略（纯产物） | `data/` + few-shot + 打包后的 `main.min.js` + 安装页 | `build:bookmarklet` 组装 |
| `vendor/` | ❌ 忽略（私有原料） | 仅"重新生成 `data/`"时需要，见下 | 你自备 |

### 积木数据从哪来（来源说明）
`data/` 里的积木目录是从 **`online.mpython.cn` 官方 Blockly 积木定义**派生而来的：

- 积木的**类型 / 字段 / 插槽 / 连接** ← 官方积木定义导出（i18n + 非严格 snippet）
- 下拉选项的**中文标签 / option 变量** ← 站点前端 bundle（`app.*.js`）
- 积木的**板型归属（v2/v3）** ← 站点扩展目录表
- **标准 Blockly 积木**（`math_number`/`controls_if`/`math_constant`…）+ 修正 ← 仓库内手写补丁 `tools/data/core-blocks.json`

mPython 官方积木数据采用 **CC0**，因此由其派生的 `data/catalog.*` 可自由再分发，这也是本仓库直接内置积木目录的依据。`knowledge/**` 为板子知识文档的整理副本。

### 重新生成 data/（可选，需自备原料）
只有想更新积木目录/知识时才需要。把原始导出放到 `vendor/`（或用环境变量指向，见 `.env.example`）后：

```bash
M3E_BLOCK_EXPORT_DIR=... M3E_REVERSE_DIR=... M3E_HANDPY_SKILL_DIR=... bun run build
```

这些原始导出**不随仓库分发**。

---

## 目录结构
```
src/
  ir/       expr                                (中缀表达式 → IR 值积木树)
  xml/      compile · decompile · validate      (IR ↔ Blockly XML + 类型检查器)
  kb/       retriever · knowledge               (检索 + 板子知识按需加载)
  agent/    loop · tools                           (多轮工具循环 + edit_blocks 结构化 schema/预检)
  ctx/      prompts · cards · fewshot · assemble (稳定 agent 提示词 + legacy L0–L7 上下文)
  llm/      client · extract · repair           (OpenAI 兼容 + 解析容错 + 生成-修复回环)
  host/     hostBridge · read · ops · inject · lock (宿主防腐层 + 编辑算子 + 注入 + 加锁)
  ui/       panelModern                         (唯一运行时 Shadow DOM 对话面板)
  runtime/  data                                (运行时加载 dist 数据)
  pipeline.mjs · main.mjs
tools/      build-catalog · build-knowledge · build-bookmarklet · lib/ · data/
data/       catalog.{index,full,meta}.json · knowledge/   (提交的积木/知识数据)
test/ e2e/ eval/
```

## IR 与编辑算子速览
```jsonc
// 程序 = 栈数组；栈 = 节点数组(自上而下连接)；值插槽放单个值积木，或一行算式字符串
{ "ops": [
  { "op": "clear" },
  { "op": "insert", "anchor": { "at": "new" }, "blocks": [
    { "type": "mpython_Interrupt_AB", "fields": { "button": "button_a", "action": "down" },
      "statements": { "DO": [
        { "type": "mpython_display_DispChar",
          "inputs": { "x": "0", "y": "0", "message": { "type": "text", "fields": { "TEXT": "Hi" } } } }
      ] } }
  ] }
] }
```
> `"x": "0"` 是表达式简写；`message` 用显式 `text` 节点（裸词会被当成变量名）。锚点 `anchor`：`new`（新栈）/ `after`（接到某 id 之后）/ `body`（进某 id 的语句体）。

---

## 测试与验证

| 层 | 命令 | 说明 |
|---|---|---|
| **T0 纯函数单元/属性** | `bun run test` | catalog 提取、工具 schema、IR↔XML 往返、类型校验、检索/卡片/装配、表达式解析、legacy 解析容错、编辑算子、few-shot 种子自校验、生成-修复回环（mock LLM）。 |
| **T2 真站点注入 E2E** | `bun e2e/inject.e2e.mjs` | Playwright 驱动真站点，用本仓库编译器产出的 XML 经 `loadXMLCode` 注入，断言真实 Blockly 渲染出预期积木、无未知块。 |
| **探针** | `bun e2e/probe.mjs` | 转储真站点宿主面（store/mutations/Blockly/localStorage/XML 格式）。 |
| **T3 LLM eval** | `M3E_API_KEY=... bun run eval` | 跑一组中文任务，报告通过率（校验+编译）。需 API Key。 |

> 系统正确性主要住在确定性层（T0）。生产 agent 由工具 schema + 本地 shape 预检 + catalog 语义校验 + 修复回环兜底；legacy 文本生成链路另保留有界 JSON 容错。质量用 T3 给“通过率”。

---

## 许可证

[AGPL-3.0-or-later](./LICENSE)。这是一个网络可交互的程序——若你修改并对外提供服务，请按 AGPL 第 13 条向用户提供对应源码。

## 致谢
- 积木定义与站点数据来自 [mPython / 掌控板](https://mpython.cn/)（官方积木数据为 CC0）。
- 板子知识整理自 HandPy 技能文档。
- 本项目为非官方第三方工具，与 labplus / mPython 官方无隶属关系。
