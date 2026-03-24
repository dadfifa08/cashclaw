import crypto from "node:crypto";
import type { CashClawConfig } from "../config.js";
import type { LoopResult } from "../loop/index.js";
import type { Task } from "../moltlaunch/types.js";
import { appendAuditEvent } from "../security/audit.js";
import { buildArtifactEnterpriseMetadata } from "./artifact_metadata.js";
import { listCateoAdapters } from "./adapter_registry.js";
import { buildCateoContext } from "./context.js";
import { renderCateoInteraction } from "./render.js";
import { getSchemaRef, validateArtifactContent } from "./schemas.js";
import { resolveCashClawSkillsForTask } from "./skill_registry.js";
import { createRevision, loadArtifactRecord, saveArtifactRecord, saveCaseRecord } from "./store.js";
import { getInstructionTemplate } from "./templates.js";
import type {
  CateoArtifactRecord,
  CateoArtifactType,
  CateoAssistInput,
  CateoConfidence,
  CateoContextBundle,
  CateoDiagnosticReasoningLog,
  CateoFinalSynthesis,
  CateoInspectionChecklist,
  CateoLeadPlan,
  CateoPartsToolsList,
  CateoRequesterInfo,
  CateoReviewerDecision,
  CateoRoutingDecision,
  CateoServiceReport,
  CateoTroubleshootingProcedure,
} from "./types.js";

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function truncate(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function mapTaskClass(result: LoopResult): CateoRoutingDecision["taskClass"] {
  const inferred = result.orchestration?.route.taskClass;
  switch (inferred) {
    case "inspection":
      return "inspection";
    case "troubleshooting":
      return "troubleshooting";
    case "preventive-maintenance":
      return "preventive-maintenance";
    case "documentation":
    case "workflow":
      return "documentation";
    case "analysis":
      return "root-cause-analysis";
    default:
      return "mixed";
  }
}

function buildRequestedArtifacts(task: Task, taskClass: CateoRoutingDecision["taskClass"], skills: ReturnType<typeof resolveCashClawSkillsForTask>): CateoArtifactType[] {
  const requested = new Set<CateoArtifactType>(["service-report", "diagnostic-reasoning-log"]);
  if (task.status === "accepted" || task.status === "revision") {
    requested.add("troubleshooting-procedure");
  }
  if (taskClass === "inspection") {
    requested.add("inspection-checklist");
  }
  if (skills.some((skill) => skill.id === "parts-and-tooling-crosswalk")) {
    requested.add("parts-tools-list");
  }
  return [...requested];
}

function buildAssistInput(task: Task, taskClass: CateoRoutingDecision["taskClass"], requestedArtifacts: CateoArtifactType[]): CateoAssistInput {
  const observedConditions = unique([
    `CashClaw task status: ${task.status}.`,
    task.category ? `Marketplace category: ${task.category}.` : undefined,
    task.quotedPriceWei ? `Quoted price: ${task.quotedPriceWei} wei.` : undefined,
    task.revisionCount !== undefined ? `Revision count: ${task.revisionCount}.` : undefined,
    ...(task.messages ?? []).slice(-4).map((message) => `${message.role} message: ${truncate(message.content, 180)}`),
    ...(task.files ?? []).slice(0, 6).map((file) => `Attached file: ${file.name} (${file.size} bytes).`),
  ]);

  return {
    title: `CashClaw task ${task.id}`,
    query: task.task,
    symptomDescription: task.task,
    observedConditions,
    workOrder: {
      workOrderId: task.id,
      title: task.category ? `${task.category} marketplace task` : `CashClaw task ${task.id}`,
      priority: task.status === "revision" ? "high" : task.status === "accepted" ? "medium" : "low",
      status: task.status,
    },
    instructionTemplate: {
      taskClass,
    },
    requestedArtifacts,
  };
}

function buildConfidence(task: Task, result: LoopResult): CateoConfidence {
  const successfulActions = result.toolCalls.filter((call) => call.success).length;
  if (successfulActions >= 2 || task.status === "completed" || task.status === "submitted") {
    return "high";
  }
  if (successfulActions >= 1 || (task.messages?.length ?? 0) > 0) {
    return "medium";
  }
  return "low";
}

function buildFinalSynthesis(task: Task, context: CateoContextBundle, result: LoopResult, requestedArtifacts: CateoArtifactType[], confidence: CateoConfidence): CateoFinalSynthesis {
  const toolSummary = result.toolCalls.length > 0
    ? result.toolCalls.map((call) => `${call.name} (${call.success ? "ok" : "blocked"})`).join(", ")
    : "no irreversible marketplace actions were executed";
  return {
    executiveSummary: `CashClaw task ${task.id} was analyzed as a ${context.taskClass} job. The agent completed ${result.turns} turn(s) and ${toolSummary}. Cateo persisted ${requestedArtifacts.length} managed artifact(s) for revision-aware follow-up.`,
    decision: task.status === "submitted" || task.status === "completed" ? "reviewed" : "draft",
    confidence,
    rootCauseStatement: task.status === "requested"
      ? "The dominant gating factor is task scope clarity and marketplace fit rather than a finished deliverable."
      : task.status === "revision"
        ? "Client feedback and revision control are the primary driver of the current engineering path."
        : "The current task state supports execution packaging with structured engineering traceability.",
    nextActions: unique([
      task.status === "requested" ? "Confirm missing scope details or prepare a bounded quote." : undefined,
      task.status === "accepted" ? "Complete the engineering deliverable and prepare the submission package." : undefined,
      task.status === "revision" ? "Address the revision items explicitly and resubmit with diffs." : undefined,
      task.status === "submitted" ? "Monitor client feedback and preserve submission evidence." : undefined,
      task.status === "completed" ? "Archive the case and retain the artifact lineage for reuse." : undefined,
    ]),
    operatorNotes: unique([
      `Client wallet: ${task.clientAddress}`,
      task.result ? `Task already contains a result payload of ${task.result.length} characters.` : undefined,
      result.orchestration?.route.artifactKind ? `Orchestration artifact bias: ${result.orchestration.route.artifactKind}.` : undefined,
    ]),
  };
}

function buildReviewerDecision(task: Task, requestedArtifacts: CateoArtifactType[], confidence: CateoConfidence, result: LoopResult): CateoReviewerDecision {
  const findings = unique([
    ...(result.toolCalls.filter((call) => !call.success).map((call) => `${call.name} did not complete successfully.`)),
    task.status === "requested" ? "Task remains in quote/clarification territory until scope is committed." : undefined,
    task.status === "revision" ? "Revision tasks require explicit comparison against prior submission content." : undefined,
  ]);
  const approvalState = task.status === "submitted" || task.status === "completed" ? "reviewed" : "draft";
  return {
    overallStatus: findings.length > 0 ? "needs-revision" : "pass",
    technicalAccuracy: findings.length > 0 ? "needs-attention" : "pass",
    completeness: task.task.trim().length > 40 ? "pass" : "needs-attention",
    compliance: "pass",
    findings,
    approvedArtifactTypes: requestedArtifacts,
    approvalState,
    confidence,
    summary: findings.length > 0
      ? `CashClaw task ${task.id} still has open execution risks or missing confirmations.`
      : `CashClaw task ${task.id} produced a controlled execution package with no immediate structural blockers.`,
    requiredFollowUp: unique([
      task.status === "requested" ? "Get explicit client confirmation before making irreversible commitments." : undefined,
      result.toolCalls.some((call) => !call.success) ? "Review blocked or failed tool calls before the next external action." : undefined,
    ]),
  };
}

function buildLeadPlan(task: Task, context: CateoContextBundle, requestedArtifacts: CateoArtifactType[]): CateoLeadPlan {
  return {
    taskClass: context.taskClass,
    objective: `Translate CashClaw task ${task.id} into a revision-aware ${requestedArtifacts.join(", ")} package.`,
    evidencePlan: unique([
      "Review the task brief, current status, and last client messages.",
      task.files?.length ? `Inspect ${task.files.length} attached file(s) for constraints and deliverable cues.` : undefined,
      task.result ? "Compare the stored result payload against the current marketplace state." : undefined,
    ]),
    assumptions: unique([
      "Marketplace task text is the controlling source unless later client messages supersede it.",
      "No field verification should be claimed unless it appears in the task evidence.",
    ]),
    risks: unique([
      task.status === "requested" ? "Premature pricing without complete scope." : undefined,
      task.status === "revision" ? "Revision feedback may invalidate previous reasoning or deliverable structure." : undefined,
    ]),
    decisionBasis: unique([
      `Current task status: ${task.status}.`,
      `Requested artifact package: ${requestedArtifacts.join(", ")}.`,
    ]),
    artifactPriorities: requestedArtifacts,
    maintenanceConsiderations: [],
    partsConsiderations: [],
  };
}

function buildServiceReport(task: Task, result: LoopResult, finalSynthesis: CateoFinalSynthesis): CateoServiceReport {
  return {
    title: `CashClaw service report for task ${task.id}`,
    summary: finalSynthesis.executiveSummary,
    findings: unique([
      task.task,
      task.category ? `Task category: ${task.category}.` : undefined,
      ...(task.messages ?? []).slice(-3).map((message) => `${message.role} said: ${truncate(message.content, 180)}`),
    ]),
    actionsPerformed: unique([
      ...result.toolCalls.map((call) => `${call.name}: ${call.success ? "completed" : "blocked or failed"}.`),
      `Reasoning turns: ${result.turns}.`,
    ]),
    unresolvedRisks: unique([
      ...result.toolCalls.filter((call) => !call.success).map((call) => `${call.name} requires follow-up before relying on the outcome.`),
      task.status === "requested" ? "Scope may still require clarification before quoting." : undefined,
    ]),
    recommendations: [...finalSynthesis.nextActions],
    signoffRequirement: task.status === "completed"
      ? "Archive after operator review of the final marketplace outcome and artifact revisions."
      : "Operator review is required before treating this package as a committed external action.",
  };
}

function buildDiagnosticLog(task: Task, result: LoopResult, confidence: CateoConfidence, finalSynthesis: CateoFinalSynthesis): CateoDiagnosticReasoningLog {
  const successfulActions = result.toolCalls.filter((call) => call.success).map((call) => call.name);
  const failedActions = result.toolCalls.filter((call) => !call.success).map((call) => call.name);
  return {
    title: `CashClaw diagnostic log for task ${task.id}`,
    problemStatement: task.task,
    hypotheses: [
      {
        name: "The task is actionable with the currently available scope.",
        status: successfulActions.length > 0 ? "confirmed" : "candidate",
        evidenceFor: unique([task.status !== "requested" ? `Task state ${task.status} implies an active work phase.` : undefined, ...successfulActions.map((name) => `${name} succeeded.`)]),
        evidenceAgainst: unique([task.status === "requested" ? "Task has not yet been accepted by the client." : undefined, ...failedActions.map((name) => `${name} failed or was blocked.`)]),
      },
      {
        name: "Client clarification or operator approval is still required before the next irreversible step.",
        status: failedActions.length > 0 || task.status === "requested" ? "confirmed" : "candidate",
        evidenceFor: unique([task.status === "requested" ? "Requested tasks stay in a triage state until quoted or clarified." : undefined, ...failedActions.map((name) => `${name} did not complete.`)]),
        evidenceAgainst: unique([...successfulActions.map((name) => `${name} completed without immediate blocking issues.`)]),
      },
    ],
    assumptions: [
      "CashClaw task text and message history are the primary scope record.",
      "Tool execution outcomes are a stronger signal than freeform reasoning alone.",
    ],
    evidenceRequests: unique([
      task.files?.length ? "Review attached files against the requested deliverable before the next submission action." : undefined,
      task.status === "requested" ? "Gather any missing scope or pricing constraints from the client." : undefined,
      failedActions.length > 0 ? "Resolve blocked tools or missing approvals before repeating the action." : undefined,
    ]),
    rootCauseStatement: finalSynthesis.rootCauseStatement,
    confidence,
  };
}

function buildInspectionChecklist(task: Task, finalSynthesis: CateoFinalSynthesis): CateoInspectionChecklist {
  return {
    title: `CashClaw inspection checklist for task ${task.id}`,
    scope: `Validate task ${task.id} scope, evidence, and delivery readiness before the next marketplace action.`,
    prepSteps: [
      "Read the task brief and current client message history.",
      "Review all attached files and prior result content before making a decision.",
    ],
    safetyNotes: [
      "Do not claim field verification or measurements that are not present in the task evidence.",
      "Escalate missing scope or blocked approvals before external commitments.",
    ],
    checklist: [
      {
        id: "scope-bounded",
        check: "Task scope is bounded enough for the next marketplace action.",
        method: "Compare task text, status, and recent messages.",
        passCriteria: "Known deliverable boundaries or missing items are explicitly identified.",
        evidenceRequired: "Task brief plus last client messages.",
        severityIfFailed: "high",
      },
      {
        id: "evidence-reviewed",
        check: "Evidence bundle has been reviewed.",
        method: "Inspect attachments, result payloads, and prior revisions.",
        passCriteria: "No obvious file or message has been skipped.",
        evidenceRequired: "Attached files and prior task result content.",
        severityIfFailed: "medium",
      },
      {
        id: "next-step-ready",
        check: "The next action in the marketplace is supported by the current state.",
        method: "Match the intended action against the CashClaw status and approval posture.",
        passCriteria: "The action can be justified with the current evidence and policy gates.",
        evidenceRequired: "Current task status and planned action.",
        severityIfFailed: "critical",
      },
    ],
    completionCriteria: [...finalSynthesis.nextActions],
  };
}

function buildPartsToolsList(task: Task, result: LoopResult): CateoPartsToolsList {
  return {
    title: `CashClaw parts and tools list for task ${task.id}`,
    parts: [],
    tools: unique([...(result.toolScope ?? []), "artifact review"]).map((name) => ({
      name,
      quantity: 1,
      purpose: `Support task ${task.id} execution and evidence handling.`,
    })),
    consumables: unique(task.files?.map((file) => file.name.split('.').pop() ? `Review supporting ${file.name.split('.').pop()} file(s)` : undefined) ?? []),
  };
}

function buildTroubleshootingProcedure(task: Task, result: LoopResult, finalSynthesis: CateoFinalSynthesis): CateoTroubleshootingProcedure {
  return {
    title: `CashClaw execution procedure for task ${task.id}`,
    objective: `Advance CashClaw task ${task.id} from ${task.status} to the next controlled marketplace state.`,
    failureCode: undefined,
    symptoms: unique([
      task.task,
      ...(task.messages ?? []).slice(-2).map((message) => truncate(message.content, 180)),
    ]),
    assumptions: [
      "Marketplace state determines which external actions are currently valid.",
      "No completion claim should be made without a corresponding successful tool action.",
    ],
    evidenceSummary: unique([
      `Available tool scope: ${(result.toolScope ?? []).join(", ") || "none"}.`,
      task.files?.length ? `${task.files.length} file(s) are attached to the task.` : undefined,
    ]),
    safetyPrecautions: [
      "Do not fabricate field verification, measurements, or finished work.",
      "Use approved CashClaw tools for external commitments and submissions.",
    ],
    requiredParts: [],
    requiredTools: unique([...(result.toolScope ?? []), "structured deliverable authoring"]),
    steps: [
      {
        id: "scope-review",
        action: "Review the task brief, latest messages, and attachments.",
        rationale: "The current marketplace scope controls what can be quoted or delivered.",
        expectedResult: "A bounded task interpretation with known constraints and missing information called out.",
      },
      {
        id: "artifact-package",
        action: "Prepare the structured engineering output and confirm it matches the requested deliverable shape.",
        rationale: "CashClaw submissions must be tool-backed and professionally packaged.",
        expectedResult: "A submission-ready package with findings, reasoning, and follow-up actions.",
      },
      {
        id: "marketplace-action",
        action: task.status === "requested" ? "Quote, decline, or send a focused clarification message." : "Submit work or send the next client-facing update through the marketplace tool layer.",
        rationale: "The next external step must match the task status and approval posture.",
        expectedResult: "CashClaw state advances without unsupported commitments.",
        escalationTrigger: "Required approvals are missing or the client feedback invalidates the package.",
      },
    ],
    acceptanceCriteria: [
      "The next marketplace action is supported by the current task state.",
      "The deliverable or message is grounded in the task evidence and tool outcomes.",
    ],
    followUpActions: [...finalSynthesis.nextActions],
  };
}

function summarizeContent(artifactType: CateoArtifactType, content: CateoServiceReport | CateoDiagnosticReasoningLog | CateoTroubleshootingProcedure | CateoInspectionChecklist | CateoPartsToolsList): string {
  if (artifactType === "service-report") {
    return (content as CateoServiceReport).summary;
  }
  if (artifactType === "diagnostic-reasoning-log") {
    return (content as CateoDiagnosticReasoningLog).rootCauseStatement;
  }
  if (artifactType === "inspection-checklist") {
    return (content as CateoInspectionChecklist).scope;
  }
  if (artifactType === "parts-tools-list") {
    const typed = content as CateoPartsToolsList;
    return `Prepared ${typed.tools.length} tool and ${typed.parts.length} part line(s) for CashClaw task support.`;
  }
  return (content as CateoTroubleshootingProcedure).objective;
}

function createArtifactId(taskId: string, artifactType: CateoArtifactType): string {
  return `cashclaw-${taskId}-${artifactType}`;
}

export function upsertCashClawArtifactsForTask(args: {
  config: CashClawConfig;
  task: Task;
  result: LoopResult;
  requestId?: string;
}): { caseId: string; artifactIds: string[] } {
  const { config, task, result } = args;
  const caseId = `cashclaw-task-${task.id}`;
  const runId = crypto.randomUUID();
  const taskClass = mapTaskClass(result);
  const requester: CateoRequesterInfo = {
    requesterId: task.clientAddress,
    conversationId: `cashclaw-task-${task.id}`,
  };
  const route: CateoRoutingDecision = {
    taskClass,
    requestedArtifacts: [],
    useChallenger: Boolean(result.orchestration?.route.useChallenger),
    useStructure: Boolean(result.orchestration?.route.useStructure),
    reasons: result.orchestration?.route.reasons ?? [`CashClaw task status ${task.status} was bridged into Cateo.`],
    activeSkillIds: result.activeSkillIds,
    capabilityTags: result.orchestration?.route.capabilityTags,
  };
  const orchestrationRoute = result.orchestration?.route ?? {
    taskClass: "mixed",
    artifactKind: "technical-assessment",
    complexity: "medium",
    useChallenger: false,
    useStructure: false,
    reasons: [],
  };
  const skills = resolveCashClawSkillsForTask(task, orchestrationRoute);
  const requestedArtifacts = buildRequestedArtifacts(task, taskClass, skills);
  route.requestedArtifacts = requestedArtifacts;
  const input = buildAssistInput(task, taskClass, requestedArtifacts);
  const context = buildCateoContext(caseId, input, []);
  const template = getInstructionTemplate(taskClass, requestedArtifacts);
  const adapters = listCateoAdapters().filter((adapter) => adapter.status === "detected" || adapter.status === "available");
  const confidence = buildConfidence(task, result);
  const finalSynthesis = buildFinalSynthesis(task, context, result, requestedArtifacts, confidence);
  const reviewerDecision = buildReviewerDecision(task, requestedArtifacts, confidence, result);
  const leadPlan = buildLeadPlan(task, context, requestedArtifacts);
  const promptFingerprint = crypto.createHash("sha256").update(`${task.id}\n${task.task}\n${task.status}`).digest("hex");
  const evidenceFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    task,
    toolCalls: result.toolCalls,
    toolScope: result.toolScope,
  })).digest("hex");
  const createdAt = new Date().toISOString();

  const artifacts: CateoArtifactRecord[] = [];
  for (const artifactType of requestedArtifacts) {
    const content = artifactType === "service-report"
      ? buildServiceReport(task, result, finalSynthesis)
      : artifactType === "diagnostic-reasoning-log"
        ? buildDiagnosticLog(task, result, confidence, finalSynthesis)
        : buildTroubleshootingProcedure(task, result, finalSynthesis);
    const errors = validateArtifactContent(artifactType, content);
    if (errors.length > 0) {
      appendAuditEvent({
        actor: "runtime",
        category: "cashclaw_cateo_bridge",
        action: "validate",
        outcome: "error",
        severity: "error",
        message: `Deterministic CashClaw artifact ${artifactType} failed schema validation.`,
        requestId: args.requestId,
        metadata: { taskId: task.id, errors },
      });
      continue;
    }

    const summary = summarizeContent(artifactType, content as CateoServiceReport & CateoDiagnosticReasoningLog & CateoTroubleshootingProcedure);
    const metadata = buildArtifactEnterpriseMetadata({
      artifactType,
      content,
      summary,
      context,
      reviewerDecision,
      finalSynthesis,
      template,
      requester,
      runId,
      caseId,
      evidenceFingerprint,
      promptFingerprint,
      requestId: args.requestId,
      activeSkills: skills,
      adapters,
      validationStatus: "deterministic",
      retryCount: 0,
      ruleResults: [],
      marketplace: {
        source: "cashclaw",
        taskId: task.id,
        taskStatus: task.status,
        clientAddress: task.clientAddress,
        quotedPriceWei: task.quotedPriceWei,
        toolScope: result.toolScope ?? [],
        toolCalls: result.toolCalls.map((call) => call.name),
      },
    });

    const artifactId = createArtifactId(task.id, artifactType);
    const existing = loadArtifactRecord(artifactId);
    if (existing) {
      artifacts.push(createRevision({
        record: existing,
        createdBy: "cashclaw-runtime",
        summary,
        approvalState: reviewerDecision.approvalState,
        content,
        provenance: {
          runId,
          requestId: args.requestId,
          createdAt,
          createdBy: "cashclaw-runtime",
          source: "cateo-v1",
          taskClass,
          modelsUsed: [result.primaryModel],
          evidenceFingerprint,
          promptFingerprint,
          conversationId: requester.conversationId,
        },
        metadata,
        note: `CashClaw task ${task.id} updated in status ${task.status}.`,
      }));
      continue;
    }

    const revisionId = crypto.randomUUID();
    const record: CateoArtifactRecord = {
      artifactId,
      artifactType,
      schema: getSchemaRef(artifactType),
      caseId,
      workOrderId: task.id,
      linkedConversationIds: requester.conversationId ? [requester.conversationId] : [],
      currentRevisionId: revisionId,
      createdAt,
      updatedAt: createdAt,
      revisions: [
        {
          revisionId,
          revisionNumber: 1,
          approvalState: reviewerDecision.approvalState,
          createdAt,
          createdBy: "cashclaw-runtime",
          summary,
          diffFromPrevious: [],
          signoffs: [],
          provenance: {
            runId,
            requestId: args.requestId,
            createdAt,
            createdBy: "cashclaw-runtime",
            source: "cateo-v1",
            taskClass,
            modelsUsed: [result.primaryModel],
            evidenceFingerprint,
            promptFingerprint,
            conversationId: requester.conversationId,
          },
          metadata,
          content,
        },
      ],
    };
    artifacts.push(saveArtifactRecord(record));
  }

  const interaction = renderCateoInteraction(artifacts, { detailLevel: input.responseDetail });
  saveCaseRecord({
    caseId,
    runId,
    createdAt,
    updatedAt: createdAt,
    input,
    context,
    artifacts: artifacts.map((artifact) => artifact.artifactId),
    interaction,
    requester,
    conversationId: requester.conversationId,
    trace: {
      route,
      template,
      activeSkills: skills,
      adapters,
      validationAttempts: [],
      ruleResults: [],
      lookupCandidates: [],
      persistActions: artifacts.map((artifact) => ({
        artifactType: artifact.artifactType,
        action: artifact.revisions.length > 1 ? "merged" : "created",
        artifactId: artifact.artifactId,
        revisionNumber: artifact.revisions.at(-1)?.revisionNumber ?? 1,
      })),
      prompts: {
        planner: `CashClaw bridge plan for task ${task.id}`,
        builder: `Deterministic CashClaw artifact builder for ${task.id}`,
        reviewer: `Deterministic CashClaw reviewer summary for ${task.id}`,
      },
      leadPlan,
      finalSynthesis,
      rawFinalSynthesis: JSON.stringify(finalSynthesis, null, 2),
    },
  });

  appendAuditEvent({
    actor: "runtime",
    category: "cashclaw_cateo_bridge",
    action: "persist",
    outcome: "success",
    message: `Persisted ${artifacts.length} Cateo artifact(s) for CashClaw task ${task.id}.`,
    requestId: args.requestId,
    metadata: {
      taskId: task.id,
      caseId,
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
      activeSkillIds: skills.map((skill) => skill.id),
      toolScope: result.toolScope,
    },
  });

  return {
    caseId,
    artifactIds: artifacts.map((artifact) => artifact.artifactId),
  };
}



