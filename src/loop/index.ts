import type { CashClawConfig } from "../config.js";
import type { CateoModelRuntime, CateoRuntimeModelInfo } from "../llm/runtime.js";
import { isCateoModelRuntime } from "../llm/runtime.js";
import type { LLMProvider, LLMMessage, LLMResponse, ToolUseBlock, ToolResultBlock } from "../llm/types.js";
import type { Task } from "../moltlaunch/types.js";
import type { ToolContext } from "../tools/types.js";
import { executeTool, getToolDefinitions } from "../tools/registry.js";
import { buildCashClawToolScope, resolveCashClawSkillsForTask } from "../cateo/skill_registry.js";
import { buildTaskPacket } from "./context/task_context.js";
import { runTaskOrchestration, sumOrchestrationUsage, type OrchestrationTrace } from "./orchestration.js";
import { buildSystemPrompt } from "./prompt.js";

const DEFAULT_MAX_TURNS = 10;

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: string;
  success: boolean;
}

export interface LoopResult {
  toolCalls: ToolCallRecord[];
  reasoning: string;
  turns: number;
  usage: { inputTokens: number; outputTokens: number };
  primaryModel: CateoRuntimeModelInfo;
  orchestration?: OrchestrationTrace;
  toolScope?: string[];
  activeSkillIds?: string[];
}

export interface LoopRuntimeHooks {
  operatorApproved?: boolean;
  requestApproval?: ToolContext["requestApproval"];
  recordAudit?: ToolContext["recordAudit"];
}

type LoopModelInput = LLMProvider | CateoModelRuntime;

type CateoMode =
  | "task-triage"
  | "technical-execution"
  | "revision-handling"
  | "wait-state"
  | "general";

function inferCateoMode(task: Task): CateoMode {
  switch (task.status) {
    case "requested":
      return "task-triage";
    case "accepted":
      return "technical-execution";
    case "revision":
      return "revision-handling";
    case "quoted":
    case "submitted":
    case "completed":
      return "wait-state";
    default:
      return "general";
  }
}

function buildCateoExecutionBrief(task: Task, config: CashClawConfig): string {
  const mode = inferCateoMode(task);

  const commonRules = [
    "Use tools for marketplace actions. Do not pretend that text alone completes a marketplace step.",
    "Distinguish facts, assumptions, and recommendations.",
    "Prefer structured technical output over generic freeform prose.",
    "If critical information is missing, ask focused clarification questions instead of guessing.",
    "Never fabricate measurements, logs, field results, or completed physical verification.",
  ];

  const modeInstructions: Record<CateoMode, string[]> = {
    "task-triage": [
      "Determine whether the task fits Cateo's specialties.",
      "Estimate complexity, ambiguity, and likely deliverable depth.",
      "Choose one path: quote, decline, or request clarification.",
      "Only quote when the scope is understandable enough to price responsibly.",
    ],
    "technical-execution": [
      "Build a complete deliverable, not a rough draft.",
      "Favor a structured result with findings, hypotheses, actions, and open questions.",
      "Optimize for operational usefulness and technical clarity.",
    ],
    "revision-handling": [
      "Review prior submission and recent messages carefully.",
      "Address all client feedback explicitly.",
      "Preserve valid prior work and revise only what needs correction or expansion.",
    ],
    "wait-state": [
      "No major action may be required immediately.",
      "Verify whether there is any new actionable message or state change before doing work.",
    ],
    "general": [
      "Determine the safest next action based on task state and available evidence.",
    ],
  };

  const pricingNotes = [
    `Pricing strategy: ${config.pricing.strategy}`,
    `Base rate: ${config.pricing.baseRateEth} ETH`,
    `Max rate: ${config.pricing.maxRateEth} ETH`,
  ];

  const lines = [
    "## Cateo Execution Brief",
    `Operating mode: ${mode}`,
    "",
    "### Required behavior",
    ...commonRules.map((rule) => `- ${rule}`),
    "",
    "### Mode-specific instructions",
    ...modeInstructions[mode].map((rule) => `- ${rule}`),
    "",
    "### Pricing context",
    ...pricingNotes.map((note) => `- ${note}`),
    "",
    "### Deliverable bias",
    "- Prefer sections like summary, evidence reviewed, findings, root-cause hypotheses, corrective actions, preventive actions, and open questions.",
    "- If task status is requested, focus on fit, scope, and priceability rather than prematurely doing the full work.",
    "- If task status is accepted or revision, focus on producing submit-ready work.",
  ];

  return lines.join("\n");
}

function buildCateoArtifactSchema(task: Task): string {
  const mode = inferCateoMode(task);

  if (mode === "task-triage") {
    return [
      "## Cateo Submission / Action Schema",
      "",
      "For requested tasks, do NOT produce a full final engineering artifact unless clearly necessary.",
      "Your output should help you choose quote_task, decline_task, or send_message.",
      "",
      "Use this internal decision structure:",
      "1. Task fit",
      "2. Scope clarity",
      "3. Complexity estimate",
      "4. Key risks / missing information",
      "5. Recommended marketplace action",
      "",
      "If you send a clarification message, keep it concise and targeted.",
    ].join("\n");
  }

  if (mode === "technical-execution" || mode === "revision-handling") {
    return [
      "## Cateo Submission / Action Schema",
      "",
      "When preparing work for submit_work, format the deliverable as a polished technical artifact using this structure when applicable:",
      "",
      "# Task Summary",
      "- Brief description of the request and objective",
      "",
      "# Evidence Reviewed",
      "- Inputs, files, messages, prior context, and assumptions",
      "",
      "# Findings / Assessment",
      "- Technical observations and interpreted meaning",
      "",
      "# Root-Cause Hypotheses",
      "- Prioritized likely causes or failure modes",
      "",
      "# Corrective Actions",
      "- Recommended near-term actions",
      "",
      "# Preventive Actions",
      "- Recommended actions to reduce recurrence",
      "",
      "# Open Questions / Limitations",
      "- What remains unknown or requires confirmation",
      "",
      "# Final Recommendation",
      "- Concise recommended path forward",
      "",
      "If the task is a revision, explicitly address the client's feedback in the updated artifact.",
      "If the task is documentation-heavy, adapt the same structure into a checklist, SOP, troubleshooting guide, or technical write-up as appropriate.",
    ].join("\n");
  }

  return [
    "## Cateo Submission / Action Schema",
    "",
    "Use structured technical reasoning.",
    "Favor concise, actionable, professionally formatted output.",
  ].join("\n");
}

function extractReasoningText(response: LLMResponse): string[] {
  return response.content
    .filter((block): block is Extract<LLMResponse["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean);
}

function resolveLeadModel(runtime: LoopModelInput, config: CashClawConfig): {
  llm: LLMProvider;
  runtime?: CateoModelRuntime;
  primaryModel: CateoRuntimeModelInfo;
} {
  if (isCateoModelRuntime(runtime)) {
    return {
      llm: runtime.lead,
      runtime,
      primaryModel: runtime.meta.lead,
    };
  }

  return {
    llm: runtime,
    primaryModel: {
      role: "lead",
      provider: config.llm.provider,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
    },
  };
}

export async function runAgentLoop(
  runtimeInput: LoopModelInput,
  task: Task,
  config: CashClawConfig,
  hooks: LoopRuntimeHooks = {},
): Promise<LoopResult> {
  const maxTurns = config.maxLoopTurns ?? DEFAULT_MAX_TURNS;
  const resolved = resolveLeadModel(runtimeInput, config);
  const orchestration = resolved.runtime
    ? await runTaskOrchestration(resolved.runtime, task, config, hooks.recordAudit)
    : undefined;
  const activeSkills = orchestration ? resolveCashClawSkillsForTask(task, orchestration.route) : [];
  const toolScope = orchestration
    ? buildCashClawToolScope({ task, route: orchestration.route, config, activations: activeSkills })
    : undefined;
  const tools = getToolDefinitions(config, toolScope);
  const toolCtx: ToolContext = {
    config,
    taskId: task.id,
    task,
    operatorApproved: hooks.operatorApproved ?? false,
    allowedToolNames: toolScope,
    activeSkillIds: activeSkills.map((skill) => skill.id),
    requestApproval: hooks.requestApproval,
    recordAudit: hooks.recordAudit,
  };
  const orchestrationUsage = sumOrchestrationUsage(orchestration);

  const messages: LLMMessage[] = [
    { role: "system", content: buildSystemPrompt(config, task.task) },
    { role: "user", content: buildTaskPacket(task) },
    { role: "user", content: buildCateoExecutionBrief(task, config) },
    { role: "user", content: buildCateoArtifactSchema(task) },
  ];

  if (orchestration?.finalContext) {
    messages.push({ role: "user", content: orchestration.finalContext });
  }

  const allToolCalls: ToolCallRecord[] = [];
  const reasoningParts: string[] = [];
  let totalInputTokens = orchestrationUsage.inputTokens;
  let totalOutputTokens = orchestrationUsage.outputTokens;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response: LLMResponse = await resolved.llm.chat(messages, tools);
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    const textBlocks = extractReasoningText(response);
    if (textBlocks.length > 0) {
      reasoningParts.push(...textBlocks);
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stopReason !== "tool_use") {
      return {
        toolCalls: allToolCalls,
        reasoning: reasoningParts.join("\n\n"),
        turns: turn + 1,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        primaryModel: resolved.primaryModel,
        orchestration,
        toolScope,
        activeSkillIds: activeSkills.map((skill) => skill.id),
      };
    }

    const toolUseBlocks = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      return {
        toolCalls: allToolCalls,
        reasoning: reasoningParts.join("\n\n"),
        turns: turn + 1,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        primaryModel: resolved.primaryModel,
        orchestration,
        toolScope,
        activeSkillIds: activeSkills.map((skill) => skill.id),
      };
    }

    const toolResults: ToolResultBlock[] = [];

    for (const block of toolUseBlocks) {
      const result = await executeTool(block.name, block.input, toolCtx);

      allToolCalls.push({
        name: block.name,
        input: block.input,
        result: result.data,
        success: result.success,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.data,
        is_error: !result.success,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    toolCalls: allToolCalls,
    reasoning: `${reasoningParts.join("\n\n")}\n\n[max turns reached]`.trim(),
    turns: maxTurns,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    primaryModel: resolved.primaryModel,
    orchestration,
    toolScope,
    activeSkillIds: activeSkills.map((skill) => skill.id),
  };
}


