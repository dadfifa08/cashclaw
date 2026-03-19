import type { CashClawConfig } from "../config.js";
import type { Task } from "../moltlaunch/types.js";

export interface ToolPolicyDecision {
  allow: boolean;
  requiresApproval: boolean;
  reason?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

const TERMINAL_OR_WAIT_STATUSES = new Set(["quoted", "submitted", "completed", "cancelled", "expired", "declined", "disputed", "resolved"]);

export function getTaskVersion(task: Task): string {
  return [
    task.id,
    task.status,
    task.revisionCount ?? 0,
    task.messages?.length ?? 0,
    task.files?.length ?? 0,
    task.quotedPriceWei ?? "",
    task.ratedScore ?? "",
    task.result?.length ?? 0,
  ].join(":");
}

function shouldRequireApproval(configFlag: boolean, operatorApproved: boolean): boolean {
  return !operatorApproved && configFlag;
}

function buildSummary(name: string, task: Task, input: Record<string, unknown>): string {
  switch (name) {
    case "quote_task":
      return `Quote task ${task.id} at ${String(input.price_eth ?? "unknown")} ETH`;
    case "decline_task":
      return `Decline task ${task.id}`;
    case "submit_work":
      return `Submit deliverable for task ${task.id}`;
    case "send_message":
      return `Send client message on task ${task.id}`;
    case "claim_bounty":
      return `Claim bounty ${String(input.bounty_id ?? task.id)}`;
    case "agentcash_fetch":
      return `Run AgentCash request ${String(input.method ?? "GET")} ${String(input.url ?? "")}`;
    default:
      return `${name} on task ${task.id}`;
  }
}

export function evaluateToolPolicy(
  name: string,
  input: Record<string, unknown>,
  task: Task,
  config: CashClawConfig,
  operatorApproved = false,
): ToolPolicyDecision {
  const summary = buildSummary(name, task, input);

  switch (name) {
    case "read_task":
    case "memory_search":
    case "read_feedback_history":
    case "check_wallet_balance":
    case "log_activity":
    case "list_bounties":
    case "agentcash_balance":
      return { allow: true, requiresApproval: false, summary };

    case "quote_task":
      if (task.status !== "requested") {
        return { allow: false, requiresApproval: false, summary, reason: `quote_task is only allowed for requested tasks, not ${task.status}` };
      }
      return {
        allow: true,
        requiresApproval: shouldRequireApproval(!config.autoQuote || config.security.approvalPolicy.quotes, operatorApproved),
        reason: !config.autoQuote ? "Auto-quote is disabled" : "Quote requires operator approval",
        summary,
      };

    case "decline_task":
      if (task.status !== "requested") {
        return { allow: false, requiresApproval: false, summary, reason: `decline_task is only allowed for requested tasks, not ${task.status}` };
      }
      return {
        allow: true,
        requiresApproval: shouldRequireApproval(!config.autoQuote || config.security.approvalPolicy.declines, operatorApproved),
        reason: !config.autoQuote ? "Auto-quote is disabled" : "Decline requires operator approval",
        summary,
      };

    case "submit_work":
      if (task.status !== "accepted" && task.status !== "revision") {
        return { allow: false, requiresApproval: false, summary, reason: `submit_work is only allowed for accepted or revision tasks, not ${task.status}` };
      }
      return {
        allow: true,
        requiresApproval: shouldRequireApproval(!config.autoWork || config.security.approvalPolicy.submissions, operatorApproved),
        reason: !config.autoWork ? "Auto-work is disabled" : "Submission requires operator approval",
        summary,
      };

    case "send_message": {
      if (TERMINAL_OR_WAIT_STATUSES.has(task.status)) {
        return {
          allow: true,
          requiresApproval: shouldRequireApproval(true, operatorApproved),
          reason: `Task is in ${task.status}; outbound messaging requires operator approval`,
          summary,
        };
      }

      const requiresPhaseApproval = task.status === "requested"
        ? !config.autoQuote
        : !config.autoWork;

      return {
        allow: true,
        requiresApproval: shouldRequireApproval(requiresPhaseApproval || config.security.approvalPolicy.clientMessages, operatorApproved),
        reason: requiresPhaseApproval ? "Automatic client messaging is disabled for this task phase" : "Client message requires operator approval",
        summary,
      };
    }

    case "claim_bounty":
      return {
        allow: true,
        requiresApproval: shouldRequireApproval(config.security.approvalPolicy.bountyClaims, operatorApproved),
        reason: "Bounty claims require operator approval",
        summary,
      };

    case "agentcash_fetch":
      if (!config.agentCashEnabled) {
        return { allow: false, requiresApproval: false, summary, reason: "AgentCash is disabled" };
      }
      return {
        allow: true,
        requiresApproval: shouldRequireApproval(config.security.approvalPolicy.agentCash, operatorApproved),
        reason: "AgentCash requests require operator approval",
        summary,
      };

    default:
      return { allow: true, requiresApproval: false, summary };
  }
}
