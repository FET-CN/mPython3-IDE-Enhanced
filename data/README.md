# data/ — 提交的积木目录与板子知识（源数据）

本目录是构建产物，但**作为源数据提交**，以便克隆仓库后无需任何私有原料即可
构建出可用书签（`bun run build:bookmarklet`）。请勿手改这里的生成文件——
要改积木库，改 `tools/data/` 源 + 重跑对应 build。

| 文件 | 说明 | 谁生成 |
|---|---|---|
| `catalog.index.json` | 紧凑积木索引（检索用） | `build:catalog` |
| `catalog.full.json` | 完整带类型的积木签名（运行时校验 + 测试） | `build:catalog` |
| `catalog.meta.json` | 构建版本 + 统计 | `build:catalog` |
| `knowledge/**` | 板子常识 / 触发词 / 反模式 / 按需文档 | `build:knowledge` |

## 来源与许可

积木目录派生自 [`online.mpython.cn`](https://online.mpython.cn/) 官方 Blockly 积木定义
（类型/字段/插槽/连接来自官方导出，下拉中文标签来自站点 bundle）。mPython 官方积木
数据为 **CC0**，故其派生结果可自由再分发。标准 Blockly 积木与修正来自仓库内手写补丁
`tools/data/core-blocks.json`。`knowledge/**` 为 HandPy 技能文档的整理副本。

重新生成本目录需自备私有原始导出，见根目录 `.env.example` 与 README。
