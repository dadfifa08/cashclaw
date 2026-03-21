import type { Task } from "../moltlaunch/types.js";
import type { OrchestrationRoute } from "../loop/orchestration.js";
import type { CashClawConfig } from "../config.js";
import type { CateoArtifactType, CateoAssistInput, CateoSkillActivation, CateoSkillExposure, CateoTaskClass } from "./types.js";

interface SkillDefinition {
  id: string;
  title: string;
  category: string;
  exposure: CateoSkillExposure;
  summary: string;
  triggers: string[];
  taskClasses?: CateoTaskClass[];
  recommendedArtifacts: CateoArtifactType[];
  recommendedTools: string[];
  datasetTags: string[];
}

const CORE_TOOL_ORDER = [
  "read_task",
  "memory_search",
  "read_feedback_history",
  "check_wallet_balance",
  "log_activity",
  "send_message",
  "quote_task",
  "decline_task",
  "submit_work",
  "list_bounties",
  "claim_bounty",
  "agentcash_balance",
  "agentcash_fetch",
] as const;

const SKILLS: SkillDefinition[] = [
  {
    id: "engineering-chat",
    title: "Engineering Chat",
    category: "general",
    exposure: "both",
    summary: "Keeps Cateo conversational while preserving engineering-grade structure in the background.",
    triggers: ["help", "explain", "what", "how", "why", "issue", "problem", "question"],
    recommendedArtifacts: ["service-report", "diagnostic-reasoning-log"],
    recommendedTools: ["memory_search", "read_feedback_history", "log_activity"],
    datasetTags: ["chat", "general-assist", "artifact-projection"],
  },
  {
    id: "cashclaw-quote-planning",
    title: "CashClaw Quote Planning",
    category: "marketplace",
    exposure: "cashclaw",
    summary: "Triage requested tasks into quote, decline, or clarification-ready paths.",
    triggers: ["quote", "estimate", "scope", "budget", "requested", "proposal", "fit"],
    recommendedArtifacts: ["service-report", "diagnostic-reasoning-log"],
    recommendedTools: ["read_task", "send_message", "quote_task", "decline_task", "log_activity"],
    datasetTags: ["cashclaw", "quote", "triage"],
  },
  {
    id: "cashclaw-submission-packaging",
    title: "CashClaw Submission Packaging",
    category: "marketplace",
    exposure: "cashclaw",
    summary: "Packages completed engineering work into a structured delivery and submission trail.",
    triggers: ["deliverable", "submit", "accepted", "revision", "handoff", "client feedback"],
    recommendedArtifacts: ["service-report", "troubleshooting-procedure", "diagnostic-reasoning-log"],
    recommendedTools: ["read_task", "send_message", "submit_work", "log_activity"],
    datasetTags: ["cashclaw", "submission", "delivery"],
  },
  {
    id: "inspection-walkdown",
    title: "Inspection Walkdown",
    category: "inspection",
    exposure: "both",
    summary: "Turns observed conditions into an inspection-ready checklist and evidence plan.",
    triggers: ["inspect", "inspection", "walkdown", "audit", "survey", "checklist", "visual"],
    taskClasses: ["inspection"],
    recommendedArtifacts: ["inspection-checklist", "service-report"],
    recommendedTools: ["memory_search", "log_activity"],
    datasetTags: ["inspection", "checklist", "field-service"],
  },
  {
    id: "troubleshooting-root-cause",
    title: "Troubleshooting Root Cause",
    category: "diagnostics",
    exposure: "both",
    summary: "Builds ranked hypotheses, fault-isolation logic, and corrective action paths.",
    triggers: ["troubleshoot", "root cause", "failure", "fault", "debug", "diagnos", "error code", "rca"],
    taskClasses: ["troubleshooting", "root-cause-analysis", "mixed"],
    recommendedArtifacts: ["diagnostic-reasoning-log", "troubleshooting-procedure", "service-report"],
    recommendedTools: ["memory_search", "read_feedback_history", "log_activity", "agentcash_fetch"],
    datasetTags: ["rca", "diagnostics", "failure-analysis"],
  },
  {
    id: "preventive-maintenance-planner",
    title: "Preventive Maintenance Planner",
    category: "maintenance",
    exposure: "both",
    summary: "Converts service history and operating context into preventive maintenance outputs.",
    triggers: ["pm", "preventive", "maintenance", "service interval", "routine", "schedule"],
    taskClasses: ["preventive-maintenance"],
    recommendedArtifacts: ["inspection-checklist", "service-report", "parts-tools-list"],
    recommendedTools: ["memory_search", "log_activity"],
    datasetTags: ["maintenance", "preventive", "service-history"],
  },
  {
    id: "sop-work-instruction",
    title: "SOP and Work Instruction",
    category: "documentation",
    exposure: "both",
    summary: "Normalizes validated reasoning into SOP-style, compliance-ready work instructions.",
    triggers: ["sop", "procedure", "work instruction", "runbook", "manual", "documentation"],
    taskClasses: ["documentation"],
    recommendedArtifacts: ["service-report", "troubleshooting-procedure"],
    recommendedTools: ["memory_search", "agentcash_fetch", "log_activity"],
    datasetTags: ["documentation", "sop", "work-instruction"],
  },
  {
    id: "parts-and-tooling-crosswalk",
    title: "Parts and Tooling Crosswalk",
    category: "parts",
    exposure: "both",
    summary: "Extracts part numbers, required tools, and replacement material candidates from context.",
    triggers: ["part", "sku", "tool", "spare", "replacement", "kit", "consumable"],
    recommendedArtifacts: ["parts-tools-list", "service-report"],
    recommendedTools: ["memory_search", "agentcash_fetch", "log_activity"],
    datasetTags: ["parts", "sku", "tooling"],
  },
  {
    id: "compliance-approval-package",
    title: "Compliance and Approval Package",
    category: "compliance",
    exposure: "both",
    summary: "Adds documentation references, measurable acceptance criteria, and review gates.",
    triggers: ["compliance", "approval", "fda", "iso", "gxp", "regulatory", "validation"],
    recommendedArtifacts: ["service-report", "diagnostic-reasoning-log"],
    recommendedTools: ["memory_search", "agentcash_fetch", "log_activity"],
    datasetTags: ["compliance", "approval", "regulated"],
  },
  {
    id: "digital-twin-measurement",
    title: "Digital Twin Measurement",
    category: "vision",
    exposure: "both",
    summary: "Uses calibration, reference geometry, and deviation checks to ground visual inspection.",
    triggers: ["dimension", "measure", "geometry", "deviation", "digital twin", "cad", "alignment"],
    recommendedArtifacts: ["inspection-checklist", "diagnostic-reasoning-log"],
    recommendedTools: ["memory_search", "log_activity"],
    datasetTags: ["digital-twin", "measurement", "geometry"],
  },
  {
    id: "material-identification",
    title: "Material Identification",
    category: "vision",
    exposure: "both",
    summary: "Flags material cues, coatings, finishes, and uncertain composition for follow-up.",
    triggers: ["material", "metal", "polymer", "coating", "surface", "corrosion", "finish"],
    recommendedArtifacts: ["service-report", "diagnostic-reasoning-log"],
    recommendedTools: ["memory_search", "agentcash_fetch", "log_activity"],
    datasetTags: ["materials", "surface-analysis", "vision"],
  },
  {
    id: "cad-reconstruction-planning",
    title: "CAD Reconstruction Planning",
    category: "cad",
    exposure: "both",
    summary: "Plans the path from 2D/3D evidence into reusable CAD and digital twin assets.",
    triggers: ["3d", "2d", "cad", "model", "mesh", "photogrammetry", "reconstruct"],
    recommendedArtifacts: ["service-report", "inspection-checklist"],
    recommendedTools: ["memory_search", "log_activity"],
    datasetTags: ["cad", "reconstruction", "digital-thread"],
  },
  {
    id: "dataset-curation",
    title: "Dataset Curation",
    category: "learning",
    exposure: "both",
    summary: "Preserves prompt, evidence, skills, outcomes, and revisions for future training loops.",
    triggers: ["dataset", "training", "fine-tune", "learn", "feedback", "history", "notes"],
    recommendedArtifacts: ["service-report", "diagnostic-reasoning-log"],
    recommendedTools: ["log_activity", "memory_search"],
    datasetTags: ["dataset", "training", "curation"],
  },
  {
    id: "client-comms",
    title: "Client Communications",
    category: "marketplace",
    exposure: "cashclaw",
    summary: "Keeps task messaging precise, scoped, and tied to the job state.",
    triggers: ["message", "client", "clarify", "question", "follow up", "revision"],
    recommendedArtifacts: ["service-report"],
    recommendedTools: ["read_task", "send_message", "log_activity"],
    datasetTags: ["cashclaw", "client-comms", "follow-up"],
  },
  {
    id: "bounty-scout",
    title: "Bounty Scout",
    category: "marketplace",
    exposure: "cashclaw",
    summary: "Surfaces marketplace bounties and claim flow only when the task warrants it.",
    triggers: ["bounty", "claim", "marketplace", "open work", "queue"],
    recommendedArtifacts: ["service-report"],
    recommendedTools: ["list_bounties", "claim_bounty", "log_activity"],
    datasetTags: ["cashclaw", "bounty", "marketplace"],
  },
  {
    id: "external-evidence-research",
    title: "External Evidence Research",
    category: "research",
    exposure: "both",
    summary: "Uses gated external retrieval only when the case needs manuals, standards, or missing evidence.",
    triggers: ["datasheet", "manual", "standard", "reference", "documentation", "cite", "source"],
    recommendedArtifacts: ["service-report", "diagnostic-reasoning-log"],
    recommendedTools: ["agentcash_fetch", "memory_search", "log_activity"],
    datasetTags: ["research", "evidence", "references"],
  },
];

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function textBlob(parts: Array<string | undefined | null>): string {
  return parts.filter(Boolean).join("\n").toLowerCase();
}

function matches(text: string, triggers: string[]): string[] {
  return unique(triggers.filter((trigger) => text.includes(trigger.toLowerCase())));
}

function activate(definition: SkillDefinition, reason: string): CateoSkillActivation {
  return {
    id: definition.id,
    title: definition.title,
    category: definition.category,
    summary: definition.summary,
    reason,
    exposure: definition.exposure,
    recommendedArtifacts: [...definition.recommendedArtifacts],
    recommendedTools: [...definition.recommendedTools],
    datasetTags: [...definition.datasetTags],
  };
}

function normalizeActivations(activations: CateoSkillActivation[]): CateoSkillActivation[] {
  const map = new Map<string, CateoSkillActivation>();
  for (const activation of activations) {
    const current = map.get(activation.id);
    if (!current) {
      map.set(activation.id, activation);
      continue;
    }
    map.set(activation.id, {
      ...current,
      reason: unique([current.reason, activation.reason]).join(" "),
      recommendedArtifacts: unique([...current.recommendedArtifacts, ...activation.recommendedArtifacts]),
      recommendedTools: unique([...current.recommendedTools, ...activation.recommendedTools]),
      datasetTags: unique([...current.datasetTags, ...activation.datasetTags]),
    });
  }
  return [...map.values()];
}

export function listCateoSkills(): CateoSkillActivation[] {
  return SKILLS.map((definition) => activate(definition, "Registered capability."));
}

export function resolveCateoSkillsForAssistInput(input: CateoAssistInput, taskClass: CateoTaskClass): CateoSkillActivation[] {
  const text = textBlob([
    input.title,
    input.query,
    input.symptomDescription,
    input.errorCode,
    ...(input.observedConditions ?? []),
    input.asset?.assetId,
    input.asset?.assetType,
    input.machine?.manufacturer,
    input.machine?.model,
    input.workOrder?.title,
    input.workOrder?.workOrderId,
    ...(input.attachments ?? []).map((attachment) => `${attachment.kind} ${attachment.name} ${attachment.note ?? ""}`),
  ]);

  const activations: CateoSkillActivation[] = [];
  activations.push(activate(SKILLS[0], "General conversational engineering support is always available."));

  for (const definition of SKILLS.slice(1)) {
    if (definition.exposure === "cashclaw") {
      continue;
    }
    const triggerHits = matches(text, definition.triggers);
    const taskClassMatch = definition.taskClasses?.includes(taskClass) ?? false;
    const attachmentBias = (definition.id === "digital-twin-measurement" || definition.id === "material-identification" || definition.id === "cad-reconstruction-planning")
      && (input.attachments?.length ?? 0) > 0;
    if (triggerHits.length === 0 && !taskClassMatch && !attachmentBias) {
      continue;
    }
    const reasonParts = [
      taskClassMatch ? `Mapped to the ${taskClass} task class.` : undefined,
      attachmentBias ? "Attachment evidence makes this capability relevant." : undefined,
      triggerHits.length > 0 ? `Matched terms: ${triggerHits.slice(0, 4).join(", ")}.` : undefined,
    ].filter(Boolean);
    activations.push(activate(definition, reasonParts.join(" ")));
  }

  return normalizeActivations(activations).slice(0, 8);
}

export function resolveCashClawSkillsForTask(task: Task, route: OrchestrationRoute): CateoSkillActivation[] {
  const text = textBlob([
    task.task,
    task.category,
    task.result,
    task.status,
    ...(task.messages?.map((message) => message.content) ?? []),
    ...(task.files?.map((file) => file.name) ?? []),
  ]);

  const activations: CateoSkillActivation[] = [
    activate(SKILLS[0], "Structured engineering chat remains available inside CashClaw jobs."),
  ];

  if (task.status === "requested") {
    activations.push(activate(SKILLS.find((skill) => skill.id === "cashclaw-quote-planning")!, "Requested tasks need quote/decline/clarification routing."));
  }
  if (task.status === "accepted" || task.status === "revision") {
    activations.push(activate(SKILLS.find((skill) => skill.id === "cashclaw-submission-packaging")!, "Accepted and revision tasks need delivery packaging and revision control."));
  }
  if ((task.messages?.length ?? 0) > 0) {
    activations.push(activate(SKILLS.find((skill) => skill.id === "client-comms")!, "Existing task messages make client communication relevant."));
  }
  if (/(bounty|marketplace)/.test(text)) {
    activations.push(activate(SKILLS.find((skill) => skill.id === "bounty-scout")!, "The task context references bounties or broader marketplace work."));
  }

  for (const definition of SKILLS.slice(1)) {
    if (definition.exposure === "public") {
      continue;
    }
    const triggerHits = matches(text, definition.triggers);
    const taskClassMatch = route.taskClass === "inspection" && definition.id === "inspection-walkdown"
      || route.taskClass === "troubleshooting" && definition.id === "troubleshooting-root-cause"
      || route.taskClass === "preventive-maintenance" && definition.id === "preventive-maintenance-planner"
      || route.taskClass === "documentation" && definition.id === "sop-work-instruction";
    if (triggerHits.length === 0 && !taskClassMatch) {
      continue;
    }
    const reasonParts = [
      taskClassMatch ? `Mapped to the ${route.taskClass} CashClaw route.` : undefined,
      triggerHits.length > 0 ? `Matched terms: ${triggerHits.slice(0, 4).join(", ")}.` : undefined,
    ].filter(Boolean);
    activations.push(activate(definition, reasonParts.join(" ")));
  }

  return normalizeActivations(activations).slice(0, 9);
}

function hasSkill(activations: CateoSkillActivation[], skillId: string): boolean {
  return activations.some((activation) => activation.id === skillId);
}

export function buildCashClawToolScope(args: { task: Task; route: OrchestrationRoute; config: CashClawConfig; activations: CateoSkillActivation[] }): string[] {
  const allowed = new Set<string>(["read_task", "memory_search", "read_feedback_history", "check_wallet_balance", "log_activity"]);
  const { task, config, activations } = args;

  if (task.status === "requested") {
    allowed.add("send_message");
    allowed.add("quote_task");
    allowed.add("decline_task");
  }

  if (task.status === "accepted" || task.status === "revision") {
    allowed.add("send_message");
    allowed.add("submit_work");
  }

  if (hasSkill(activations, "client-comms")) {
    allowed.add("send_message");
  }

  if (hasSkill(activations, "bounty-scout")) {
    allowed.add("list_bounties");
    if (task.status === "requested") {
      allowed.add("claim_bounty");
    }
  }

  if (config.agentCashEnabled) {
    allowed.add("agentcash_balance");
    if (hasSkill(activations, "external-evidence-research") || hasSkill(activations, "troubleshooting-root-cause") || hasSkill(activations, "compliance-approval-package")) {
      allowed.add("agentcash_fetch");
    }
  }

  return CORE_TOOL_ORDER.filter((tool) => allowed.has(tool));
}

export function summarizeSkillReasons(activations: CateoSkillActivation[]): string[] {
  return activations.map((activation) => `${activation.title}: ${activation.reason}`);
}

