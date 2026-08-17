// src/agent/tools/index.mjs — The tool registry exposed to the agent loop.

import { readWorkspaceTool } from "./readWorkspace.mjs";
import { searchBlocksTool } from "./searchBlocks.mjs";
import { editBlocksTool } from "./editBlocks.mjs";
import { runCodeTool } from "./runCode.mjs";
import { askUserTool } from "./askUser.mjs";
import { thinkTool } from "./think.mjs";
import { updateTodosTool } from "./updateTodos.mjs";
import { SUBAGENT_MANAGEMENT_TOOLS } from "./subagents.mjs";

export const ALL_TOOLS = [
  readWorkspaceTool,
  searchBlocksTool,
  editBlocksTool,
  runCodeTool,
  askUserTool,
  thinkTool,
  updateTodosTool,
  ...SUBAGENT_MANAGEMENT_TOOLS,
];

/** Convert our tool defs into OpenAI `tools` function specs. */
export function toToolSpecs(tools) {
  return tools.map((t) => {
    const fn = { name: t.name, description: t.description, parameters: t.parameters };
    if (t.strict === true) fn.strict = true;
    const spec = { type: "function", function: fn };
    if (t.fallbackParameters) spec._fallbackParameters = t.fallbackParameters;
    return spec;
  });
}
