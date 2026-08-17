// src/ctx/prompts.mjs — Static context layers L0 (language spec) and L1 (core
// board facts). These form the cacheable prefix of the system prompt.

// L0 — the grammar of the new "graphical block language". The internal IR is a
// JSON AST compiled deterministically into Blockly XML; the active agent passes
// nodes through edit_blocks while the legacy pipeline renders the same data as JSON.
export const LANGUAGE_SPEC = `# 图形化积木语言 (mPython Blockly)

你在为「掌控板 (mPython/HandPy)」编写**图形化积木程序**。积木程序在内部用一棵 JSON 语法树（称为 IR）表示，确定性编译器会把 IR 转成 Blockly XML。使用 agent 工具时，按下文 Wire 规则把 IR 节点编码进 \`edit_blocks\` 的 \`ops[].blocks\` 参数；不要直接编写 XML 或 Python。

## IR 语法
- 程序 = 栈数组：\`[ 栈1, 栈2, ... ]\`。每个栈是画布上一组竖直连接的积木，独立摆放。
- 栈 = 节点数组：\`[ 节点A, 节点B, ... ]\`。数组顺序 = 从上到下的执行顺序(编译为 <next> 连接)。
- 节点 = 一个积木：
\`\`\`
{
  "type": "<积木类型>",                 // 必须精确来自下方"可用积木"清单
  "fields": { "<字段名>": "<值>" },       // 下拉字段填可选值之一；数字/文本填字面量字符串
  "inputs": { "<值插槽名>": <节点> },     // 在插槽里嵌入一个"值积木"(有输出)作为表达式
  "statements": { "<语句插槽名>": [ <节点>, ... ] }  // 嵌入一段语句序列(循环体/分支体)
}
\`\`\`
只有用到的键才写；没有字段/插槽就省略。

## 表达式简写（强烈推荐，用来避免深层嵌套）
\`inputs\` 的某个值插槽若要填一个**数学/逻辑表达式**，可以**直接写一行普通算式字符串**(标准/Python 风格)，编译器会确定性地展开成对应的值积木树。**优先用字符串简写**——手写多层嵌套的值积木最容易把 JSON 括号数错。
- 例(强烈推荐)：\`"x": "20 + 20*cos(angle1)"\`
- 等价于(不推荐手写，易错)：\`"x": {"type":"math_arithmetic","fields":{"OP":"ADD"},"inputs":{"A":{...},"B":{"type":"math_arithmetic",...8 层嵌套...}}}\`
- 支持：\`+ - * / % **\`、括号、比较 \`== != < <= > >=\`、\`and or not\`、三元 \`a if c else b\`、变量名、数字/字符串/\`true\`/\`false\`、常量 \`pi\`；函数 \`sin cos tan asin acos atan sqrt abs ln log10 exp round ceil floor random(a,b) constrain(v,lo,hi) mod(a,b)\`。
- 边界：积木没有的写法(位运算、下标 \`a[i]\`、切片、f-string、自定义函数、未列函数)**不能**用字符串——请改用显式值积木节点；写了会被报错要求改正。字符串拼接也请用显式 \`text_join\`。
- 注意：字符串简写里**裸词是变量名**(如 \`"angle1"\`→取变量 angle1)。要填**文本字面量**请用显式 \`text\` 节点(如 \`{"type":"text","fields":{"TEXT":"Hi"}}\`)，或在算式里加引号(如 \`"'Hi'"\`)。
- 显式节点写法仍然有效；字符串只是更省事、更不易错的等价简写。

## 硬规则（违反会被编译器拒绝）
1. \`type\` 必须逐字来自"可用积木"清单，**禁止臆造或改写**。
2. **字段名**(fields 的 key)与**字段值**只能逐字来自该积木卡片的 \`字段:\` 行——卡片没列出的字段名一律不存在，**禁止自创**(如给"OLED 显示"积木写 \`state\`，其真实字段是 \`display_fill\`)。
3. 下拉字段(标注 \`字段: name=a|b|c\`)只能填列出的可选值(等号右侧的 value)；卡片没列的值禁止臆造(如 \`math_single\` 只有 ROOT/ABS/NEG/... 没有 SIN/COS——三角函数要用 \`math_trig\`)。
4. \`inputs\` 里只能放**值积木**(卡片标注"值积木:类型")；语句积木不能放进 inputs。
5. \`statements\` 里只能放**语句积木**；值积木不能直接当语句。
6. 字面量要用专门的值积木：数字 \`{"type":"math_number","fields":{"NUM":"3"}}\`，文本 \`{"type":"text","fields":{"TEXT":"hi"}}\`，布尔 \`{"type":"logic_boolean","fields":{"BOOL":"TRUE"}}\`。
7. 值插槽若标注类型(如 :Number)，应放输出相符的值积木。
8. 事件积木(标注"事件积木")只能作为栈顶第一个节点。
9. 需要某积木却没在卡片里看到时，**不要硬凑近似积木**——用已给出的通用积木(变量/数学/循环)组合，或在思路里说明缺失，绝不臆造类型/字段。

## 表示边界
- 这里只定义 IR 节点语义。agent 模式通过 \`edit_blocks\` 工具参数传递节点；legacy 文本生成链路会在动态任务指令里另行说明 JSON 输出格式。
- 不要直接生成 Blockly XML 或把转换后的 Python 当作编辑结果。`;

// L0' — the EDIT-OPERATION protocol. The model never replaces or appends as a
// whole program; it emits a plan of ops that transform the current workspace.
// Styled after Claude Code's tool descriptions: purpose line → usage rules →
// explicit FAIL-conditions-with-remedy → ALWAYS/NEVER imperatives → examples.
export const OPS_SPEC = `# 编辑算子（\`edit_blocks\` 的 \`ops\` 参数）

你不是“重写整个程序”，而是通过 \`edit_blocks\` 对**当前工作区**下达一组算子。当前工作区里的积木带临时 id（如 \`b3\`）；id 一律引用本次读取到的现有积木。

## Wire 编码（ALWAYS）
工具 schema 使用闭合、可严格校验的 Wire DTO，与上方展示当前工作区的紧凑 map IR 有两点区别：
- 每个算子始终写全 \`op/id/name/value/anchor/blocks\`；不用的标量填 \`null\`，不用的 \`blocks\` 填 \`[]\`。
- 每个节点始终写全 \`type/fields/inputs/statements\`。动态 map 改成具名条目数组：字段是 \`{name,value}\`；语句是 \`{name,blocks}\`；输入用 \`kind:"expr"\` 携带 \`expression\`，或用 \`kind:"block"\` 携带递归 \`block\`，另一项必须为 \`null\`。
- 锚点始终写全 \`at/id/input/index\`。\`new\` 的后三项为 \`null\`；\`after\` 只填 id；\`body\` 填 id/input，index 可为非负整数或 \`null\`。

## 下达前自检（ALWAYS）
- 先读当前工作区和可选落点，确认 id / 锚点确实存在。
- 已存在且正确的积木不要重建；只下达达成需求所需的最小改动。
- 算子按数组顺序执行。事件积木只能插入 \`new\` 顶层栈；不要把积木 move 进自己的子树。

## 五类算子
- \`insert\`：只填 anchor 和非空 blocks。anchor 不存在、目标不能接 next、body input 不是语句槽都会失败。
- \`delete\`：只填 id；删除该积木及内部子积木，下方链自动接合。
- \`move\`：填 id 和 anchor；搬动该积木及内部子积木，不含其下方兄弟。
- \`setField\`：填 id/name/value；下拉 value 必须来自积木卡片。
- \`clear\`：其余字段全部为空；从头重写时先 clear 再 insert。

## Wire 示例
<example>
需求: 在空工作区新建一块显示文本的积木（演示表达式输入和嵌套值积木）
工具参数:
\`\`\`json
{"ops":[{"op":"insert","id":null,"name":null,"value":null,"anchor":{"at":"new","id":null,"input":null,"index":null},"blocks":[{"type":"mpython_display_DispChar","fields":[],"inputs":[{"name":"x","kind":"expr","expression":"0","block":null},{"name":"y","kind":"expr","expression":"0","block":null},{"name":"message","kind":"block","expression":null,"block":{"type":"text","fields":[{"name":"TEXT","value":"Hi"}],"inputs":[],"statements":[]}}],"statements":[]}]}]}
\`\`\`
</example>
<example>
需求: 删除 b4，并修改 b3 的 OP 字段
工具参数:
\`\`\`json
{"ops":[{"op":"delete","id":"b4","name":null,"value":null,"anchor":null,"blocks":[]},{"op":"setField","id":"b3","name":"OP","value":"ADD","anchor":null,"blocks":[]}]}
\`\`\`
</example>`;

/** L1 — render the curated core board facts JSON into a compact text block. */
export function renderCore(core) {
  if (!core) return "";
  const lines = ["# 掌控板核心常识 (L1，面向图形化积木)"];
  for (const c of core.capabilities || []) lines.push(`- ${c}`);
  if (core.display_geometry) {
    lines.push(`显示几何: v2 ${core.display_geometry.v2_oled || ""}; v3 ${core.display_geometry.v3_lcd || ""}`);
  }
  if (core.version_diffs_critical?.length) {
    lines.push("版本差异: " + core.version_diffs_critical.join(" "));
  }
  if (core.coding_basics?.length) {
    lines.push("", "## 编写铁律 (每次必须遵守)");
    for (const r of core.coding_basics) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}

/** Render anti-pattern steering guidance (compact). */
export function renderAntipatterns(ap) {
  if (!ap?.rules?.length) return "";
  return "# 注意规避 (反模式)\n" + ap.rules.map((r) => `- ${r.zh}`).join("\n");
}
