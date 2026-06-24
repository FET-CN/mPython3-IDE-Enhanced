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

## 许可证

本项目采用 **AGPL-3.0-or-later**。提交贡献即表示你同意以同一许可证授权你的改动。
