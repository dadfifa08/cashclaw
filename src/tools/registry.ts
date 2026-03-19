import type { ToolDefinition } from "../llm/types.js";
import type { CashClawConfig } from "../config.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import {
  readTask,
  quoteTask,
  declineTask,
  submitWork,
  sendMessage,
  listBounties,
  claimBounty,
} from "./marketplace.js";
import {
  checkWalletBalance,
  readFeedbackHistory,
  memorySearch,
  logActivity,
} from "./utility.js";
import { agentcashFetch, agentcashBalance } from "./agentcash.js";
import { evaluateToolPolicy, getTaskVersion } from "../security/policy.js";

const CORE_TASK_TOOLS: Tool[] = [
  readTask,
  sendMessage,
  quoteTask,
  declineTask,
  submitWork,
  listBounties,
  claimBounty,
];

const SUPPORT_TOOLS: Tool[] = [
  memorySearch,
  readFeedbackHistory,
  checkWalletBalance,
  logActivity,
];

const AGENTCASH_TOOLS: Tool[] = [
  agentcashBalance,
  agentcashFetch,
];

let cachedConfig: CashClawConfig | null = null;
let cachedToolMap: Map<string, Tool> | null = null;

function getEnabledTools(config: CashClawConfig): Tool[] {
  const base = [...CORE_TASK_TOOLS, ...SUPPORT_TOOLS];
  return config.agentCashEnabled
    ? [...base, ...AGENTCASH_TOOLS]
    : base;
}

function buildToolMap(config: CashClawConfig): Map<string, Tool> {
  if (cachedConfig === config && cachedToolMap) return cachedToolMap;

  const tools = getEnabledTools(config);
  cachedToolMap = new Map(tools.map((tool) => [tool.definition.name, tool]));
  cachedConfig = config;
  return cachedToolMap;
}

export function getToolDefinitions(config: CashClawConfig): ToolDefinition[] {
  const toolMap = buildToolMap(config);
  return [...toolMap.values()].map((tool) => tool.definition);
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const toolMap = buildToolMap(ctx.config);
  const tool = toolMap.get(name);

  if (!tool) {
    ctx.recordAudit?.({
      category: "tool",
      action: name,
      outcome: "blocked",
      severity: "warn",
      message: `Unknown tool requested: ${name}`,
      metadata: { input },
    });
    return { success: false, data: `Unknown tool: ${name}` };
  }

  const decision = evaluateToolPolicy(name, input, ctx.task, ctx.config, ctx.operatorApproved ?? false);
  if (!decision.allow) {
    ctx.recordAudit?.({
      category: "tool",
      action: name,
      outcome: "blocked",
      severity: "warn",
      message: decision.reason ?? `Blocked tool: ${name}`,
      metadata: { taskId: ctx.taskId, input },
    });
    return { success: false, data: `Blocked by security policy: ${decision.reason ?? "disallowed action"}` };
  }

  if (decision.requiresApproval) {
    const approval = ctx.requestApproval?.({
      toolName: name,
      summary: decision.summary,
      reason: decision.reason ?? "Operator approval required",
      input,
      taskId: ctx.taskId,
      taskStatus: ctx.task.status,
      taskVersion: getTaskVersion(ctx.task),
      metadata: decision.metadata,
    });

    ctx.recordAudit?.({
      category: "approval",
      action: name,
      outcome: approval?.created === false ? "deduplicated" : "pending",
      severity: "warn",
      approvalId: approval?.id,
      message: decision.reason ?? "Operator approval required",
      metadata: { taskId: ctx.taskId, input },
    });

    const approvalText = approval
      ? `Operator approval required: ${decision.reason ?? "approval needed"}. Approval ID: ${approval.id}`
      : `Operator approval required: ${decision.reason ?? "approval needed"}.`;
    return { success: false, data: approvalText };
  }

  ctx.recordAudit?.({
    category: "tool",
    action: name,
    outcome: "started",
    message: `Executing ${name}`,
    metadata: { taskId: ctx.taskId, input },
  });

  try {
    const result = await tool.execute(input, ctx);
    ctx.recordAudit?.({
      category: "tool",
      action: name,
      outcome: result.success ? "success" : "error",
      severity: result.success ? "info" : "warn",
      message: result.success ? `${name} completed` : `${name} returned an error`,
      metadata: { taskId: ctx.taskId, input, result: result.data },
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.recordAudit?.({
      category: "tool",
      action: name,
      outcome: "error",
      severity: "error",
      message: `${name} failed: ${message}`,
      metadata: { taskId: ctx.taskId, input },
    });
    return { success: false, data: `Tool error [${name}]: ${message}` };
  }
}
