// src/agent/tools/index.mjs — The tool registry exposed to the agent loop.

import { readWorkspaceTool } from "./readWorkspace.mjs";
import { searchBlocksTool } from "./searchBlocks.mjs";
import { editBlocksTool } from "./editBlocks.mjs";
import { runCodeTool } from "./runCode.mjs";
import { thinkTool } from "./think.mjs";
import { updateTodosTool } from "./updateTodos.mjs";

export const ALL_TOOLS = [
  readWorkspaceTool,
  searchBlocksTool,
  editBlocksTool,
  runCodeTool,
  thinkTool,
  updateTodosTool,
];

/** Convert our tool defs into OpenAI `tools` function specs. */
export function toToolSpecs(tools) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
