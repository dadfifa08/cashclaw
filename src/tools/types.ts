import type { ToolDefinition } from "../llm/types.js";
import type { CashClawConfig } from "../config.js";
import type { Task } from "../moltlaunch/types.js";

export interface ToolResult {
  success: boolean;
  data: string;
}

export interface ToolApprovalRequest {
  toolName: string;
  summary: string;
  reason: string;
  input: Record<string, unknown>;
  taskId?: string;
  taskStatus?: string;
  taskVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolAuditEvent {
  category: string;
  action: string;
  outcome: string;
  message: string;
  severity?: "info" | "warn" | "error";
  approvalId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  config: CashClawConfig;
  taskId: string;
  task: Task;
  operatorApproved?: boolean;
  requestApproval?: (request: ToolApprovalRequest) => { id: string; created: boolean };
  recordAudit?: (event: ToolAuditEvent) => void;
}

export interface Tool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
