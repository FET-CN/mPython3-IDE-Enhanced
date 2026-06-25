// src/agent/tools/runCode.mjs — Run the current program on the connected board and
// return its serial/REPL output (closed-loop debugging). Output capture is via
// host/run.mjs which subscribes to the IDE's termWrite/terminalWrite mutations.
// Requires a physically connected board; degrades gracefully when none is present.

import { canRun, runCurrent } from "../../host/run.mjs";

export const runCodeTool = {
  name: "run_code",
  description:
    "在已连接的掌控板上运行当前生成的程序，并返回串口/REPL 输出。" +
    "用于验证程序行为或在报错时做闭环调试。需要已连接真实掌控板；" +
    "若未连接设备，本工具会返回提示，请告知用户先连接设备。",
  parameters: {
    type: "object",
    properties: {
      timeout_ms: { type: "number", description: "最长等待毫秒数，默认 8000" },
    },
    additionalProperties: false,
  },
  isReadOnly: false,
  needsConfirm: true,
  async run(args, ctx) {
    const caps = ctx?.caps;
    if (!caps) return { is_error: true, content: "无法访问宿主环境。" };
    if (!canRun(caps)) {
      return { is_error: true, content: "当前没有连接掌控板（或运行入口不可用），无法运行。请先在 IDE 里连接设备。" };
    }
    const timeout = Math.max(1000, Math.min(Number(args?.timeout_ms) || 8000, 30000));
    try {
      const res = await runCurrent(caps, {
        timeout,
        signal: ctx?.signal,
        onOutput: (chunk) => ctx?.emit?.({ type: "run_output", chunk }),
      });
      const out = (res.output || "").trim() || "(无输出)";
      const head = res.error ? "运行出错：" : "运行完成。输出：";
      return { content: `${head}\n\`\`\`\n${out}\n\`\`\``, is_error: !!res.error };
    } catch (e) {
      return { is_error: true, content: "运行失败：" + (e?.message || String(e)) };
    }
  },
};
