// src/agent/tools/subagents.mjs — Parent-agent tools for managing read-only
// SubAgents. The manager is supplied by ctx or created lazily in ctx.session.

import {
  getOrCreateSubagentManager,
  subagentRuntimeFromContext,
} from "../subagents.mjs";

const TYPE_ENUM = ["general-purpose", "explore", "plan", "review"];
const STATUS_ENUM = ["running", "completed", "failed", "killed"];
const PARENT_RESULT_LIMIT = 20_000;

function manager(ctx) {
  const value = getOrCreateSubagentManager(ctx);
  if (!value) throw new Error("当前会话未启用 SubAgent manager。");
  return value;
}

function success(content, display) {
  return { content: clip(content), display };
}

function failure(error) {
  return { is_error: true, content: clip(error?.message || String(error)) };
}

function label(task) {
  return task.name ? `${task.name}（${task.id}）` : task.id;
}

function clip(value) {
  const text = String(value || "");
  if (text.length <= PARENT_RESULT_LIMIT) return text;
  return text.slice(0, PARENT_RESULT_LIMIT - 18) + "\n…（结果已截断）";
}

export const spawnAgentTool = {
  name: "spawn_agent",
  description:
    "派出一个严格只读、拥有独立上下文的 SubAgent 做研究、探索、规划或审查。" +
    "子代理只能读取工作区、检索积木和思考，不能改积木、运行设备、询问用户或继续派生。" +
    "前台模式会等待结果；耗时任务或可并行任务使用后台模式，然后用 list_agents/get_agent 查看。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "可选的会话内唯一名称（最多 64 字符）" },
      description: { type: "string", description: "简短说明该代理负责什么" },
      prompt: { type: "string", description: "完整、独立、可直接执行的任务要求" },
      agent_type: { type: "string", enum: TYPE_ENUM, description: "角色，默认 general-purpose" },
      context_mode: { type: "string", enum: ["isolated", "fork"], description: "isolated 只继承系统知识；fork 复制父代理当前有效历史。默认 isolated" },
      run_in_background: { type: "boolean", description: "是否后台运行，默认 false" },
    },
    required: ["description", "prompt"],
    additionalProperties: false,
  },
  isReadOnly: true,
  needsConfirm: false,
  unboundedConcurrency: true,
  async run(args, ctx) {
    try {
      const task = await manager(ctx).spawn(args, subagentRuntimeFromContext(ctx));
      if (task.background && task.status === "running") {
        return success(`已在后台启动 SubAgent ${label(task)}。可继续工作，稍后用 get_agent 查看结果。`, task);
      }
      if (task.status === "completed") return success(`SubAgent ${label(task)} 已完成：\n${task.result || "（无文本结果）"}`, task);
      if (task.status === "killed") return success(`SubAgent ${label(task)} 已停止。`, task);
      return { is_error: true, content: clip(`SubAgent ${label(task)} 执行失败：${task.error || "未知错误"}`), display: task };
    } catch (error) {
      return failure(error);
    }
  },
};

export const sendAgentMessageTool = {
  name: "send_agent_message",
  description:
    "向指定 SubAgent 追加一条消息。运行中的代理会在下一模型步骤按发送顺序收到；" +
    "已结束的代理保留原 transcript 和 ID，并在后台开启新一代运行。",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "SubAgent ID 或唯一名称" },
      message: { type: "string", description: "补充指示或新问题" },
    },
    required: ["to", "message"],
    additionalProperties: false,
  },
  isReadOnly: false,
  needsConfirm: false,
  async run(args, ctx) {
    try {
      const task = manager(ctx).send(args.to, args.message, subagentRuntimeFromContext(ctx));
      return success(`消息已发送给 SubAgent ${label(task)}；当前状态：${task.status}，运行代次：${task.run_id}。`, task);
    } catch (error) {
      return failure(error);
    }
  },
};

export const listAgentsTool = {
  name: "list_agents",
  description: "列出当前页面会话内的 SubAgent，可按状态筛选。返回精简状态，不包含 transcript。",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: STATUS_ENUM, description: "可选状态筛选" },
    },
    additionalProperties: false,
  },
  isReadOnly: true,
  needsConfirm: false,
  async run(args, ctx) {
    try {
      const tasks = manager(ctx).list({ status: args?.status });
      if (!tasks.length) return success("当前没有符合条件的 SubAgent。", []);
      const lines = tasks.map((task) => {
        const activity = task.activity?.label ? ` · ${task.activity.label}` : "";
        return `- ${label(task)} · ${task.agent_type} · ${task.status}${activity}`;
      });
      return success(`当前 SubAgent（${tasks.length}）：\n${lines.join("\n")}`, tasks);
    } catch (error) {
      return failure(error);
    }
  },
};

export const getAgentTool = {
  name: "get_agent",
  description:
    "查看一个 SubAgent 的最新状态、活动、结果或错误。include_transcript=true 时附带最近 20 条、最多 20000 字符的记录。",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "SubAgent ID 或唯一名称" },
      include_transcript: { type: "boolean", description: "是否附带裁剪后的最近 transcript，默认 false" },
    },
    required: ["to"],
    additionalProperties: false,
  },
  isReadOnly: true,
  needsConfirm: false,
  async run(args, ctx) {
    try {
      const task = manager(ctx).get(args.to, { includeTranscript: !!args.include_transcript });
      const detail = task.status === "completed"
        ? task.result || "（无文本结果）"
        : task.status === "failed" ? task.error || "未知错误"
          : task.status === "killed" ? "任务已停止。" : task.activity?.label || "正在运行。";
      const transcript = task.transcript ? `\n\n最近 transcript：\n${JSON.stringify(task.transcript)}` : "";
      return success(`SubAgent ${label(task)} · ${task.status} · 第 ${task.run_id} 代\n${detail}${transcript}`, task);
    } catch (error) {
      return failure(error);
    }
  },
};

export const stopAgentTool = {
  name: "stop_agent",
  description: "停止一个正在运行的 SubAgent。对已结束任务重复调用会稳定返回其现有状态。",
  parameters: {
    type: "object",
    properties: { to: { type: "string", description: "SubAgent ID 或唯一名称" } },
    required: ["to"],
    additionalProperties: false,
  },
  isReadOnly: false,
  needsConfirm: false,
  async run(args, ctx) {
    try {
      const task = manager(ctx).stop(args.to);
      return success(`SubAgent ${label(task)} 当前状态：${task.status}。`, task);
    } catch (error) {
      return failure(error);
    }
  },
};

export const SUBAGENT_MANAGEMENT_TOOLS = [
  spawnAgentTool,
  sendAgentMessageTool,
  listAgentsTool,
  getAgentTool,
  stopAgentTool,
];
