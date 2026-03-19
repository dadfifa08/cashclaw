import type { CashClawConfig, OrchestrationMode } from "../config.js";
import type { CateoModelRuntime } from "../llm/runtime.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../llm/types.js";
import type { Task } from "../moltlaunch/types.js";
import type { ToolAuditEvent } from "../tools/types.js";
import { buildTaskPacket } from "./context/task_context.js";

export type CateoTaskClass =
  | "inspection"
  | "troubleshooting"
  | "preventive-maintenance"
  | "documentation"
  | "workflow"
  | "analysis"
  | "mixed";

export type CateoArtifactKind =
  | "decision-memo"
  | "inspection-checklist"
  | "troubleshooting-guide"
  | "preventive-maintenance-plan"
  | "sop-work-instruction"
  | "technical-assessment";

export type CateoComplexity = "low" | "medium" | "high";

export interface OrchestrationRoute {
  taskClass: CateoTaskClass;
  artifactKind: CateoArtifactKind;
  complexity: CateoComplexity;
  useChallenger: boolean;
  useStructure: boolean;
  reasons: string[];
}

export interface OrchestrationStageTrace {
  role: "lead" | "challenger" | "structure";
  status: "used" | "skipped" | "error";
  provider?: string;
  model?: string;
  text: string;
  reason?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface OrchestrationTrace {
  enabled: boolean;
  route: OrchestrationRoute;
  stages: OrchestrationStageTrace[];
  finalContext: string;
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((block): block is Extract<LLMResponse["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function buildTaskCorpus(task: Task): string {
  return [
    task.task,
    task.category,
    task.result,
    ...(task.messages?.map((message) => message.content) ?? []),
    ...(task.files?.map((file) => file.name) ?? []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function inferTaskClass(task: Task): CateoTaskClass {
  const corpus = buildTaskCorpus(task);

  if (/(inspection|walkdown|checklist|audit|survey)/.test(corpus)) return "inspection";
  if (/(troubleshoot|debug|diagnos|fault|failure|root cause|error)/.test(corpus)) return "troubleshooting";
  if (/(preventive maintenance|maintenance plan|pm schedule|service interval|maintenance)/.test(corpus)) return "preventive-maintenance";
  if (/(sop|procedure|work instruction|runbook|manual|documentation)/.test(corpus)) return "documentation";
  if (/(workflow|handoff|process|decision tree|automation logic)/.test(corpus)) return "workflow";
  if (/(analysis|assessment|evaluate|compare|report)/.test(corpus)) return "analysis";
  return "mixed";
}

function inferArtifactKind(task: Task, taskClass: CateoTaskClass): CateoArtifactKind {
  const corpus = buildTaskCorpus(task);

  if (task.status === "requested") return "decision-memo";
  if (/(checklist|inspection)/.test(corpus) || taskClass === "inspection") return "inspection-checklist";
  if (/(troubleshoot|debug|fault|root cause)/.test(corpus) || taskClass === "troubleshooting") return "troubleshooting-guide";
  if (/(preventive maintenance|maintenance plan|service interval)/.test(corpus) || taskClass === "preventive-maintenance") return "preventive-maintenance-plan";
  if (/(sop|procedure|work instruction|runbook)/.test(corpus) || taskClass === "documentation" || taskClass === "workflow") return "sop-work-instruction";
  return "technical-assessment";
}

function inferComplexity(task: Task, taskClass: CateoTaskClass): CateoComplexity {
  let score = 0;
  const descriptionLength = task.task.trim().length;
  const messageCount = task.messages?.length ?? 0;
  const fileCount = task.files?.length ?? 0;

  if (descriptionLength > 500) score += 2;
  else if (descriptionLength > 220) score += 1;

  if (messageCount >= 4) score += 2;
  else if (messageCount >= 2) score += 1;

  if (fileCount >= 3) score += 2;
  else if (fileCount >= 1) score += 1;

  if ((task.revisionCount ?? 0) > 0 || task.status === "revision") score += 2;
  if (task.status === "accepted") score += 1;
  if (taskClass === "troubleshooting" || taskClass === "analysis" || taskClass === "mixed") score += 1;

  if (score >= 5) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function shouldRunStage(mode: OrchestrationMode, enabled: boolean, adaptiveDecision: boolean): boolean {
  if (!enabled || mode === "never") return false;
  if (mode === "always") return true;
  return adaptiveDecision;
}

function buildRoute(task: Task): OrchestrationRoute {
  const taskClass = inferTaskClass(task);
  const artifactKind = inferArtifactKind(task, taskClass);
  const complexity = inferComplexity(task, taskClass);
  const needsChallenge = task.status === "revision"
    || complexity === "high"
    || taskClass === "troubleshooting"
    || taskClass === "analysis"
    || (task.messages?.length ?? 0) >= 2
    || (task.files?.length ?? 0) >= 1;
  const needsStructure = task.status === "accepted"
    || task.status === "revision"
    || artifactKind !== "decision-memo"
    || taskClass === "documentation"
    || taskClass === "workflow";

  const reasons = [
    `Task class inferred as ${taskClass}.`,
    `Artifact bias inferred as ${artifactKind}.`,
    `Complexity assessed as ${complexity}.`,
  ];

  if (needsChallenge) reasons.push("Challenge stage helps pressure-test assumptions or competing failure modes.");
  if (needsStructure) reasons.push("Structure stage helps convert reasoning into an engineering-grade deliverable scaffold.");

  return {
    taskClass,
    artifactKind,
    complexity,
    useChallenger: needsChallenge,
    useStructure: needsStructure,
    reasons,
  };
}

function buildLeadSystemPrompt(): string {
  return [
    "You are Cateo's lead architect and synthesis model.",
    "Your job is to classify the task, plan the evidence strategy, identify explicit assumptions, and define the execution route for the final decision-making pass.",
    "Do not act like a chatbot. Do not call tools. Produce concise engineering planning output only.",
    "Use the exact headings below:",
    "TASK_CLASS",
    "ACTION_DECISION",
    "DELIVERABLE_SHAPE",
    "EVIDENCE_PLAN",
    "ASSUMPTIONS",
    "RISKS",
    "EXECUTION_PLAN",
  ].join("\n");
}

function buildLeadUserPrompt(task: Task, config: CashClawConfig, route: OrchestrationRoute): string {
  const specialties = config.specialties.length > 0 ? config.specialties.join(", ") : "general engineering diagnostics";
  return [
    `Specialties: ${specialties}`,
    `Detected route: task_class=${route.taskClass}, complexity=${route.complexity}, artifact=${route.artifactKind}`,
    "",
    buildTaskPacket(task),
    "",
    "Generate the initial reasoning plan for the staged Cateo pipeline.",
    "Keep the output deterministic, explicit, and operationally useful.",
  ].join("\n");
}

function buildChallengerSystemPrompt(): string {
  return [
    "You are Cateo's challenger model.",
    "Your job is to attack the lead plan for missing assumptions, competing explanations, evidence gaps, and weak reasoning.",
    "Do not restate the whole plan. Produce a concise engineering critique.",
    "Use the exact headings below:",
    "COMPETING_HYPOTHESES",
    "BLIND_SPOTS",
    "MISSING_ASSUMPTIONS",
    "EVIDENCE_GAPS",
    "RISK_FLAGS",
    "RECOMMENDED_ADJUSTMENTS",
  ].join("\n");
}

function buildChallengerUserPrompt(task: Task, route: OrchestrationRoute, leadPlan: string): string {
  return [
    `Task class: ${route.taskClass}`,
    `Complexity: ${route.complexity}`,
    "",
    buildTaskPacket(task),
    "",
    "Lead plan:",
    leadPlan,
    "",
    "Critique the plan and surface concrete alternate hypotheses or missing evidence.",
  ].join("\n");
}

function buildStructureSystemPrompt(): string {
  return [
    "You are Cateo's structure and artifact specialist.",
    "Convert validated reasoning into a clean, submission-ready artifact scaffold for engineering work.",
    "Do not add new unsupported claims. Focus on structure, sequencing, decision points, and output quality.",
    "Use the exact headings below:",
    "ARTIFACT_TYPE",
    "TITLE",
    "SECTION_ORDER",
    "SECTION_NOTES",
    "QUALITY_GATES",
    "SUBMISSION_SHAPE",
  ].join("\n");
}

function buildStructureUserPrompt(
  task: Task,
  route: OrchestrationRoute,
  leadPlan: string,
  challengerCritique: string | undefined,
): string {
  return [
    `Target artifact: ${route.artifactKind}`,
    `Task class: ${route.taskClass}`,
    "",
    buildTaskPacket(task),
    "",
    "Validated lead plan:",
    leadPlan,
    challengerCritique ? `\nChallenger critique:\n${challengerCritique}` : "",
    "",
    "Produce the Cateo artifact scaffold.",
  ].join("\n");
}

async function runStage(
  role: OrchestrationStageTrace["role"],
  llm: LLMProvider,
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<OrchestrationStageTrace> {
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const response = await llm.chat(messages);
  return {
    role,
    status: "used",
    provider,
    model,
    text: extractText(response) || "No structured output produced.",
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    },
  };
}

function buildSkippedStage(role: OrchestrationStageTrace["role"], reason: string): OrchestrationStageTrace {
  return {
    role,
    status: "skipped",
    text: "",
    reason,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function buildErroredStage(
  role: OrchestrationStageTrace["role"],
  provider: string | undefined,
  model: string | undefined,
  error: unknown,
): OrchestrationStageTrace {
  return {
    role,
    status: "error",
    provider,
    model,
    text: "",
    reason: error instanceof Error ? error.message : String(error),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function logStage(recordAudit: ((event: ToolAuditEvent) => void) | undefined, stage: OrchestrationStageTrace, route: OrchestrationRoute): void {
  if (!recordAudit) return;
  recordAudit({
    category: "orchestration",
    action: stage.role,
    outcome: stage.status,
    severity: stage.status === "error" ? "warn" : "info",
    message: stage.status === "used"
      ? `${stage.role} stage completed`
      : `${stage.role} stage ${stage.status}`,
    metadata: {
      taskClass: route.taskClass,
      artifactKind: route.artifactKind,
      complexity: route.complexity,
      model: stage.model,
      provider: stage.provider,
      reason: stage.reason,
    },
  });
}

export function sumOrchestrationUsage(trace: OrchestrationTrace | undefined): { inputTokens: number; outputTokens: number } {
  if (!trace) {
    return { inputTokens: 0, outputTokens: 0 };
  }

  return trace.stages.reduce(
    (totals, stage) => ({
      inputTokens: totals.inputTokens + stage.usage.inputTokens,
      outputTokens: totals.outputTokens + stage.usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

function buildFinalContext(route: OrchestrationRoute, stages: OrchestrationStageTrace[]): string {
  const lines = [
    "## Cateo Orchestration Context",
    "",
    "Treat the following as internal planning context from staged local role models. Final marketplace decisions and tool actions remain with the lead model.",
    "",
    `- Task class: ${route.taskClass}`,
    `- Complexity: ${route.complexity}`,
    `- Artifact bias: ${route.artifactKind}`,
    ...route.reasons.map((reason) => `- ${reason}`),
  ];

  const lead = stages.find((stage) => stage.role === "lead" && stage.status === "used");
  const challenger = stages.find((stage) => stage.role === "challenger" && stage.status === "used");
  const structure = stages.find((stage) => stage.role === "structure" && stage.status === "used");

  if (lead?.text) {
    lines.push("", "### Lead Plan", lead.text);
  }

  if (challenger?.text) {
    lines.push("", "### Challenger Critique", challenger.text);
  }

  if (structure?.text) {
    lines.push("", "### Structured Artifact Scaffold", structure.text);
  }

  return lines.join("\n");
}

export async function runTaskOrchestration(
  runtime: CateoModelRuntime,
  task: Task,
  config: CashClawConfig,
  recordAudit?: (event: ToolAuditEvent) => void,
): Promise<OrchestrationTrace | undefined> {
  if (!runtime.meta.orchestrationEnabled) {
    return undefined;
  }

  const route = buildRoute(task);
  const stages: OrchestrationStageTrace[] = [];

  const lead = await runStage(
    "lead",
    runtime.lead,
    runtime.meta.lead.provider,
    runtime.meta.lead.model,
    buildLeadSystemPrompt(),
    buildLeadUserPrompt(task, config, route),
  );
  stages.push(lead);
  logStage(recordAudit, lead, route);

  const useChallenger = shouldRunStage(
    config.orchestration.challenger.mode,
    Boolean(runtime.challenger && runtime.meta.challenger),
    route.useChallenger,
  );
  if (useChallenger && runtime.challenger && runtime.meta.challenger) {
    try {
      const challenger = await runStage(
        "challenger",
        runtime.challenger,
        runtime.meta.challenger.provider,
        runtime.meta.challenger.model,
        buildChallengerSystemPrompt(),
        buildChallengerUserPrompt(task, route, lead.text),
      );
      stages.push(challenger);
      logStage(recordAudit, challenger, route);
    } catch (error) {
      const failed = buildErroredStage("challenger", runtime.meta.challenger.provider, runtime.meta.challenger.model, error);
      stages.push(failed);
      logStage(recordAudit, failed, route);
    }
  } else {
    const skipped = buildSkippedStage("challenger", "Adaptive routing skipped the challenger stage.");
    stages.push(skipped);
    logStage(recordAudit, skipped, route);
  }

  const challengerText = stages.find((stage) => stage.role === "challenger" && stage.status === "used")?.text;
  const useStructure = shouldRunStage(
    config.orchestration.structure.mode,
    Boolean(runtime.structure && runtime.meta.structure),
    route.useStructure,
  );
  if (useStructure && runtime.structure && runtime.meta.structure) {
    try {
      const structure = await runStage(
        "structure",
        runtime.structure,
        runtime.meta.structure.provider,
        runtime.meta.structure.model,
        buildStructureSystemPrompt(),
        buildStructureUserPrompt(task, route, lead.text, challengerText),
      );
      stages.push(structure);
      logStage(recordAudit, structure, route);
    } catch (error) {
      const failed = buildErroredStage("structure", runtime.meta.structure.provider, runtime.meta.structure.model, error);
      stages.push(failed);
      logStage(recordAudit, failed, route);
    }
  } else {
    const skipped = buildSkippedStage("structure", "Adaptive routing skipped the structure stage.");
    stages.push(skipped);
    logStage(recordAudit, skipped, route);
  }

  return {
    enabled: true,
    route,
    stages,
    finalContext: buildFinalContext(route, stages),
  };
}
