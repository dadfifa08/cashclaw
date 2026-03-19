import type { Tool } from "./types.js";
import { loadFeedback } from "../memory/feedback.js";
import { appendLog } from "../memory/log.js";
import { searchMemory } from "../memory/search.js";
import * as cli from "../moltlaunch/cli.js";

export const checkWalletBalance: Tool = {
  definition: {
    name: "check_wallet_balance",
    description: "Check your operational wallet status on Base. Use this when funding, quoting, or task execution may depend on wallet readiness.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  async execute() {
    const wallet = await cli.walletShow();
    return {
      success: true,
      data: [
        "## Wallet Status",
        `- Address: ${wallet.address}`,
        `- Balance: ${wallet.balance ?? "unknown"} ETH`,

      ].join("\n"),
    };
  },
};

export const readFeedbackHistory: Tool = {
  definition: {
    name: "read_feedback_history",
    description: "Read past task ratings and comments to improve future technical work, delivery quality, and revision handling.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum entries to return (default 10)" },
      },
    },
  },
  async execute(input) {
    const feedback = loadFeedback();
    const limit = (input.limit as number) || 10;
    const recent = feedback.slice(-limit);

    if (recent.length === 0) {
      return { success: true, data: "No feedback history yet." };
    }

    const summary = [
      "## Recent Feedback History",
      ...recent.map((f, i) =>
        `${i + 1}. Score: ${f.score}/5\n   Task: ${f.taskDescription.slice(0, 120)}\n   Comment: ${f.comments || "(no comment)"}`,
      ),
    ].join("\n");

    return { success: true, data: summary };
  },
};

export const memorySearch: Tool = {
  definition: {
    name: "memory_search",
    description:
      "Search prior knowledge, lessons learned, and historical feedback for context relevant to a current technical task. Use this before pricing, diagnosing, revising, or submitting work when prior experience may improve quality.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query describing the issue, task type, failure mode, procedure, or domain topic",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default 5)",
        },
      },
      required: ["query"],
    },
  },
  async execute(input) {
    const query = input.query;
    if (typeof query !== "string" || !query.trim()) {
      return { success: false, data: "Missing required field: query" };
    }

    const limit = (input.limit as number) || 5;
    const hits = searchMemory(query, limit);

    if (hits.length === 0) {
      return { success: true, data: "No relevant memories found." };
    }

    const summary = [
      `## Memory Search Results for: ${query}`,
      ...hits.map((h, i) => `${i + 1}. [${h.type}] ${h.text.slice(0, 300)}`),
    ].join("\n\n");

    return { success: true, data: summary };
  },
};

export const logActivity: Tool = {
  definition: {
    name: "log_activity",
    description: "Write a structured operational note to the activity log. Use this for meaningful state changes, important findings, blockers, or delivery milestones.",
    input_schema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "Log entry text" },
      },
      required: ["entry"],
    },
  },
  async execute(input) {
    const entry = input.entry;
    if (typeof entry !== "string" || !entry.trim()) {
      return { success: false, data: "Missing required field: entry" };
    }

    appendLog(entry);
    return { success: true, data: "Logged activity entry." };
  },
};
