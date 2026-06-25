# 贡献指南

感谢参与！本项目用 [Bun](https://bun.sh/) 开发，正确性主要由确定性纯函数层 + 测试保证。

## 开发环境

```bash
bun install
bun run build:bookmarklet   # 从 data/ 组装 dist/（无需私有数据）
bun run test                # 必须全绿
bun run test:watch          # 开发时监听
```

提 PR 前请确保 `bun run test` 全绿，并为新行为补测试。

## 架构速记（改之前先看）

- **IR & 编辑算子**：`src/host/ops.mjs`（`applyOps` / 锚点 / id 标注）、`src/xml/compile.mjs`（IR→XML）、`src/xml/decompile.mjs`（XML→IR，往返可验证）。
- **类型校验**：`src/xml/validate.mjs` —— 语言的"类型检查器"，宽松校验，只对模型**给出**的字段/插槽报错。
- **表达式简写**：`src/ir/expr.mjs` —— `parseExpr`（中缀→值积木树）+ `expandOps`。文法收敛到现有积木集合；新增映射前先用 `data/catalog.full.json` 核实目标积木确实存在、字段名正确。
- **解析容错**：`src/llm/extract.mjs`（`repairJson` 有界括号修复）、`src/llm/repair.mjs`（生成-展开-校验-修复回环 + 反馈）。
- **上下文工程**：`src/ctx/`（`prompts` 语言/算子规范、`cards` 卡片渲染、`fewshot`、`assemble` 分层装配）。
- **宿主防腐层**：`src/host/`（`read`/`inject`/`lock`/`hostBridge`）——所有对真站点 `window.vm` 的访问集中于此。

## 常见改动

- **修正某个积木的字段/枚举/类型** → 改手写补丁 `tools/data/core-blocks.json`（它覆盖自动提取结果），然后 `bun run build:catalog` 重生 `data/`。
- **新增板子知识/触发词/反模式** → `tools/data/knowledge-*.json` 或 HandPy 文档，`bun run build:knowledge`。
- **扩展表达式文法** → `src/ir/expr.mjs` + 在 `test/unit/expr.spec.mjs` 补例；必要时在 `tools/data/core-blocks.json` 补齐目标积木的 `output`/`values`。
- **改提示词** → `src/ctx/prompts.mjs`；注意 system 段是可缓存前缀，尽量保持稳定。

## 数据目录

`data/`（提交的积木目录 + 知识）是构建产物但**视作源数据**提交，以便克隆即用。改积木库请改 `tools/data/` 源 + 重跑对应 build，不要手改 `data/` 里的生成文件。重新生成 `data/` 需要私有原始导出，见 [`.env.example`](./.env.example) 与 README「重新生成 data/」。

### 重新生成 data/ 所需的私有导出（去哪下）

这些原始导出**不随仓库分发**；只有在重新生成 `data/` 时才需要。默认放到项目内 `./vendor/`（已被 `.gitignore` 忽略），或用 `.env` 里的环境变量指向别处：

| 环境变量 | 内容 | 出处 |
| --- | --- | --- |
| `M3E_BLOCK_EXPORT_DIR` | 官方 Blockly 积木定义导出（含 `i18n/blocks-i18n.json`、`non-strict/blocks.json`、`i18n/groups-i18n.json`），是积木字段/槽位的权威来源 | <https://labplus.cn/posts/6a093a1247fb2875e3a42414>（**有时效性**：当前 `data/` 取自 20260517 导出，站点更新后请重新提取） |
| `M3E_HANDPY_SKILL_DIR` | HandPy 技能文档目录（指向仓库内的 `skills/handpy`，含 `references/`），供 `build:knowledge` 取板子文档 | <https://github.com/gxxk-dev/HandPy-Skill> |
| `M3E_REVERSE_DIR` | 逆向得到的站点 bundle 目录（含 `site/js/app.*.js` 与 `extension_catalog_all.json`），供 catalog 解析下拉枚举/Msg/主控表 | 私有逆向导出，不公开分发 |

拿到后任选其一接入：放进 `./vendor/` 对应子目录，或复制 `.env.example` 为 `.env` 并填好三个路径（Bun 自动加载），再 `bun run build`（catalog + knowledge + css + bookmarklet）。**只提交 `data/`**，不要提交 `vendor/` / `.env`。

### 积木栏可见性快照 `data/toolbox.visible.json`（带时效）

侧边积木栏（默认工具箱）是 IDE 按 `masterControl` 在 JS 里**动态构建**的，静态导出无法还原。`data/toolbox.visible.json` 是用 Playwright 跑真实站点抓到的**按板可见 block type 快照**（V2/V3），用于让检索/核心词汇只偏好「积木栏当前能找到」的积木、剔除已下架旧块。

- 刷新：`bun run dump:toolbox`（**需联网**，访问 online.mpython.cn；无需登录）。**不随 `bun run build`**。
- 它带 `source`(站点/bundle) + `capturedAt`，定位为**某次快照**——默认工具箱会随站点版本漂移，站点更新后需重抓。
- 运行时缺失会优雅降级（不做可见性过滤/加权），不影响其余功能。

## 许可证

本项目采用 **AGPL-3.0-or-later**。提交贡献即表示你同意以同一许可证授权你的改动。
