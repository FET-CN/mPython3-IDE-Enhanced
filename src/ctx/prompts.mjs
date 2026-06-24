// src/ctx/prompts.mjs — Static context layers L0 (language spec) and L1 (core
// board facts). These form the cacheable prefix of the system prompt.

// L0 — the grammar of the new "graphical block language". Teaches the LLM to
// emit an IR (JSON AST) that our compiler turns into Blockly XML. The LLM never
// writes XML or Python.
export const LANGUAGE_SPEC = `# 图形化积木语言 (mPython Blockly)

你在为「掌控板 (mPython/HandPy)」编写**图形化积木程序**。积木程序用一棵 JSON 语法树(称为 IR)表示；一个确定性编译器会把 IR 转成 Blockly XML 注入到图形化 IDE 的工作区。**你只输出 IR，绝不要输出 XML 或 Python。**

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

## 输出协议
- 先用一句话说明思路(可选)，然后**只输出一个 \`\`\`json 代码块**，块内是 IR 程序(最外层是栈数组)。
- 不要输出多个代码块，不要输出 XML/Python，不要在 JSON 里写注释。`;

// L0' — the EDIT-OPERATION protocol. The model never replaces or appends as a
// whole program; it emits a plan of ops that transform the current workspace.
// Styled after Claude Code's tool descriptions: purpose line → usage rules →
// explicit FAIL-conditions-with-remedy → ALWAYS/NEVER imperatives → examples.
export const OPS_SPEC = `# 编辑算子（你的输出 = 一组对工作区的"工具调用"）

你不是"重写整个程序"，而是像调用编辑工具一样对**当前工作区**下达一组算子。当前工作区里每个积木都带一个 id(如 \`b3\`)。**只输出一个 \`\`\`json 代码块**，内容为：
\`\`\`
{ "ops": [ <算子>, ... ] }
\`\`\`
算子按数组顺序依次执行；其中 \`id\` 一律引用"当前工作区"里已有的 id。

## 下达前自检（ALWAYS）
- 先读"当前工作区"和"可选落点"清单，确认你要操作的 id / 锚点**确实存在**。
- 已存在且正确的积木**不要重建**；只下达达成需求所需的最小改动。
- 版本(v2/v3)不确定且答案因此而异时，在思路里说明假设。

## 算子（每个都像一个工具）
### insert — 放置一段新积木
\`{ "op":"insert", "anchor":<锚点>, "blocks":[<积木节点>, ...] }\`
- blocks 是一段竖直相连的 IR 节点数组(节点语法见上)。
- NEVER 把事件积木(标注"事件积木")放到非 new 锚点——事件只能 \`at:"new"\`。
- FAIL 条件：anchor.id 不存在 / \`after\` 的目标不能接 next / \`body\` 的 input 不是该积木的语句槽 → 改用合法锚点。

### delete — 删除一个积木
\`{ "op":"delete", "id":"b5" }\`
- 删除该积木及其内部子积木；它下方的积木**自动接合**到上面，链不断。

### move — 搬动一个积木（即连接 / 断开）
\`{ "op":"move", "id":"b7", "anchor":<锚点> }\`
- 只搬该积木及其内部子积木，**不含**其下方兄弟；原处自动接合。\`at:"new"\` 即断开成浮动积木。
- NEVER 把一个积木 move 进它自己的子树。

### setField — 修改字段 / 下拉值
\`{ "op":"setField", "id":"b3", "name":"<字段名>", "value":"<新值>" }\`
- 下拉字段的 value NEVER 超出该字段可选项。

### clear — 清空整个工作区
\`{ "op":"clear" }\`
- "从头重写"时：先 \`clear\` 再 \`insert\`。

## 锚点 anchor
\`{ "at":"new" | "after" | "body", "id":"b3", "input":"DO", "index":<可选整数> }\`
- \`new\`：新建独立顶层栈(无需 id)。\`after\`,id：接到积木 id 之后(id 必须能接 next)。\`body\`,id,input：放进积木 id 的 input 语句体(默认末尾，给 index 可指定位置)。
- ALWAYS 只用"可选落点"清单里出现过的 id/锚点；NEVER 臆造 id。

## 示例
<example>
需求: (空工作区) 按A键时在屏幕显示 Hi
输出:
\`\`\`json
{"ops":[{"op":"insert","anchor":{"at":"new"},"blocks":[{"type":"mpython_Interrupt_AB","fields":{"button":"button_a","action":"down"},"statements":{"DO":[{"type":"mpython_display_DispChar","inputs":{"x":{"type":"math_number","fields":{"NUM":"0"}},"y":{"type":"math_number","fields":{"NUM":"0"}},"message":{"type":"text","fields":{"TEXT":"Hi"}}}}]}}]}]}
\`\`\`
</example>
<example>
需求: 当前工作区有事件积木 b1(按A键)，往它体里再加一句点亮RGB
输出:
\`\`\`json
{"ops":[{"op":"insert","anchor":{"at":"body","id":"b1","input":"DO"},"blocks":[{"type":"mpython_set_RGB","fields":{}}]}]}
\`\`\`
</example>
<example>
需求: 删除 id 为 b4 的那块积木
输出:
\`\`\`json
{"ops":[{"op":"delete","id":"b4"}]}
\`\`\`
</example>
<example>
需求: (空工作区) 让小圆按角度 angle 在 OLED 上做圆周运动并每帧让 angle 递增 (演示表达式简写：inputs 直接写算式字符串，避免深层嵌套)
输出:
\`\`\`json
{"ops":[{"op":"insert","anchor":{"at":"new"},"blocks":[{"type":"mpython_display_fill_circle","fields":{"state":"1"},"inputs":{"x":"64 + 20*cos(angle)","y":"32 + 20*sin(angle)","radius":"4"}},{"type":"variables_set","fields":{"VAR":"angle"},"inputs":{"VALUE":"(angle + 10) % 360"}}]}]}
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
