// src/agent/commands.mjs — Slash-command parsing for the chat input. Command
// NAMES are English (per project decision); descriptions are zh-CN. Local commands
// (clear/compact/undo/config/help/rewind) are handled by the controller in main.mjs;
// "prompt" commands (review/run) expand into a user message that drives the agent
// loop and its tools.

export const COMMANDS = {
  clear:   { kind: "local",  desc: "清空对话历史（保留工作区）" },
  compact: { kind: "local",  desc: "把对话压缩成摘要后继续" },
  undo:    { kind: "local",  desc: "撤销上一次积木改动" },
  rewind:  { kind: "local",  desc: "进入回退模式，选择要回到的用户回合" },
  config:  { kind: "local",  desc: "打开设置面板" },
  theme:   { kind: "local",  desc: "切换界面主题（/theme classic | modern，重置界面、保留上下文）" },
  help:    { kind: "local",  desc: "显示可用命令" },
  review:  { kind: "prompt", desc: "审查当前积木程序并给出改进建议" },
  run:     { kind: "prompt", desc: "在已连接的掌控板上运行当前程序" },
};

/** Parse a chat input. Returns { name, arg } for a known command, else null. */
export function parseSlash(input) {
  const m = /^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec((input || "").trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!COMMANDS[name]) return { name, arg: m[2].trim(), unknown: true };
  return { name, arg: m[2].trim() };
}

export function parseRewindArgs(arg = "") {
  const raw = String(arg || "").trim();
  if (!raw) return { mode: "interactive" };
  const parts = raw.split(/\s+/).filter(Boolean);
  let count = null;
  let chatOnly = false;
  for (const p of parts) {
    if (p === "--chat-only") { chatOnly = true; continue; }
    if (/^\d+$/.test(p)) {
      if (count != null) return { mode: "error", message: "只能指定一个回退轮数" };
      count = Number(p);
      continue;
    }
    return { mode: "error", message: `无法识别 /rewind 参数：${p}` };
  }
  if (count == null) count = 1;
  if (!Number.isSafeInteger(count) || count <= 0) return { mode: "error", message: "回退轮数必须是正整数" };
  return { mode: "direct", count, chatOnly };
}

/** For a "prompt" command, the user-message text that drives the agent. */
export function commandPrompt(name, arg = "") {
  switch (name) {
    case "review":
      return (
        "请先调用 read_workspace 读取当前工作区，然后审查这段积木程序：" +
        "指出潜在 bug、不合理之处、可简化或更省电的写法，以及与掌控板 v2/v3 相关的注意点。" +
        "**只给出审查意见，不要修改积木**，除非我明确要求。" +
        (arg ? `\n额外关注：${arg}` : "")
      );
    case "run":
      return (
        "请调用 run_code 在已连接的掌控板上运行当前程序，并把串口/REPL 输出反馈给我；" +
        "若报错，分析原因并提出修复建议。" + (arg ? `\n补充：${arg}` : "")
      );
    default:
      return arg || "";
  }
}

/** zh-CN help block listing the commands. */
export function helpText() {
  const lines = ["可用斜杠命令："];
  for (const [name, c] of Object.entries(COMMANDS)) lines.push(`  /${name} — ${c.desc}`);
  lines.push("  /rewind N --chat-only — 快速回退 N 轮；--chat-only 只回退聊天，不恢复工作区");
  lines.push("  /theme modern | classic — 切换界面主题（默认 classic，选择持久化）");
  lines.push("  /undo 只撤销最近一次积木编辑；/rewind 回到某个用户回合之前。");
  lines.push("直接输入中文需求即可开始对话（例如：按A键时在屏幕显示温度）。");
  return lines.join("\n");
}
