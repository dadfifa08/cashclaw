import crypto from "node:crypto";
import type { CashClawConfig } from "../config.js";
import type { CateoModelRuntime, CateoRuntimeModelInfo } from "../llm/runtime.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import { appendCateoInteraction } from "../memory/datasets.js";
import { appendAuditEvent } from "../security/audit.js";
import { buildCateoContext, inferRequestedArtifacts } from "./context.js";
import { renderCateoInteraction } from "./render.js";
import { getSchemaRef, validateArtifactContent } from "./schemas.js";
import { evaluateArtifactPackageRules, summarizeRuleOutcomes } from "./rules.js";
import { createRevision, findSimilarArtifacts, fingerprintEvidence, loadArtifactRecord, loadCaseRecord, mergeContentPatch, saveArtifactRecord, saveCaseRecord } from "./store.js";
import { persistTroubleshootingReportPackage } from "./report_exports.js";
import { ensureCaseReviewWorkflow, syncCaseReviewPackageFiles } from "./review_workflow.js";
import { getInstructionTemplate, renderInstructionTemplate } from "./templates.js";
import { ingestMediaAttachments, sanitizeAssistInputForPersistence } from "./media_adapter.js";
import { buildArtifactEnterpriseMetadata } from "./artifact_metadata.js";
import { resolveCateoPart } from "./part_resolution.js";
import { listCateoAdapters } from "./adapter_registry.js";
import { enrichAssistInputWithOpenAIMedia } from "./openai_media.js";
import { resolveCateoSkillsForAssistInput, summarizeSkillReasons } from "./skill_registry.js";
import type {
  CateoAdapterCapability,
  CateoArtifactContent,
  CateoArtifactEnterpriseMetadata,
  CateoArtifactLookupCandidate,
  CateoArtifactPersistAction,
  CateoArtifactRecord,
  CateoArtifactType,
  CateoAssistInput,
  CateoAssistResult,
  CateoCaseRecord,
  CateoBuilderPackage,
  CateoChallengerCritique,
  CateoConfidence,
  CateoContextBundle,
  CateoDiagnosticReasoningLog,
  CateoElectronicSignoff,
  CateoFinalSynthesis,
  CateoInspectionChecklist,
  CateoInteractionCheckpoint,
  CateoLeadPlan,
  CateoRequesterInfo,
  CateoReasoningTrace,
  CateoPartCatalogEntry,
  CateoPartsToolsList,
  CateoReviewerDecision,
  CateoRevisionRequest,
  CateoRuleResult,
  CateoRoutingDecision,
  CateoServiceReport,
  CateoSignoffRequest,
  CateoStructureBlueprint,
  CateoTaskClass,
  CateoTroubleshootingProcedure,
  CateoSkillActivation,
  CateoStageUsage,
  CateoUsageSummary,
  CateoValidationAttempt,
} from "./types.js";

const ARTIFACT_TYPES: CateoArtifactType[] = [
  "troubleshooting-procedure",
  "inspection-checklist",
  "service-report",
  "parts-tools-list",
  "diagnostic-reasoning-log",
];

const CATEO_STAGE_BUDGET_MS = {
  planner: 30_000,
  builder: 45_000,
  reviewer: 30_000,
} as const;

const CATEO_STAGE_MAX_TOKENS = {
  planner: 1_200,
  builder: 2_200,
  reviewer: 1_400,
} as const;

interface StageResult<T> {
  data: T;
  raw?: string;
  modelInfo: CateoRuntimeModelInfo;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface ServiceOptions {
  actor?: string;
  requestId?: string;
  onCheckpoint?: (checkpoint: CateoInteractionCheckpoint) => void;
  requester?: CateoRequesterInfo;
}

const ZERO_STAGE_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
};

export class CateoExecutionError extends Error {
  usage: CateoUsageSummary;

  constructor(message: string, usage: CateoUsageSummary) {
    super(message);
    this.name = "CateoExecutionError";
    this.usage = usage;
  }
}

export function getCateoUsageFromError(error: unknown): CateoUsageSummary | undefined {
  return error instanceof CateoExecutionError ? error.usage : undefined;
}

function buildUsageSummary(stages: CateoStageUsage[]): CateoUsageSummary {
  return {
    inputTokens: stages.reduce((sum, stage) => sum + stage.inputTokens, 0),
    outputTokens: stages.reduce((sum, stage) => sum + stage.outputTokens, 0),
    totalTokens: stages.reduce((sum, stage) => sum + stage.totalTokens, 0),
    stages: stages.map((stage) => ({ ...stage })),
  };
}

interface RawBuilderArtifactDraft {
  artifactType?: string;
  title?: string;
  content?: unknown;
  notes?: unknown;
}

interface RawBuilderOutput {
  packageSummary?: string;
  artifactPlans?: unknown;
  artifactDrafts?: unknown;
}

interface ReviewerStageOutput {
  alternateHypotheses?: unknown;
  blindSpots?: unknown;
  missingAssumptions?: unknown;
  evidenceGaps?: unknown;
  recommendedAdjustments?: unknown;
  reviewDecision?: unknown;
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((block): block is Extract<LLMResponse["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalizeAssistInput(input: CateoAssistInput): CateoAssistInput {
  const symptomDescription = input.symptomDescription?.trim() || input.query?.trim() || input.title?.trim() || "No symptom description provided.";
  const workflow = input.workflow
    ? {
        mode: input.workflow.mode,
        requestedBy: input.workflow.requestedBy?.trim() || undefined,
        documentIntent: input.workflow.documentIntent?.trim() || undefined,
        businessJustification: input.workflow.businessJustification?.trim() || undefined,
        drjJustification: input.workflow.drjJustification?.trim() || undefined,
        complianceScope: input.workflow.complianceScope?.map((entry) => entry.trim()).filter(Boolean) ?? [],
        riskTier: input.workflow.riskTier,
        requiresAdminRelease: input.workflow.requiresAdminRelease,
      }
    : undefined;
  return {
    ...input,
    partNumber: input.partNumber?.trim() || undefined,
    contextNotes: input.contextNotes?.trim() || undefined,
    workflow,
    symptomDescription,
  };
}

function trimCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

function parseJsonObject<T>(raw: string): T | null {
  const trimmed = trimCodeFences(raw);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as T;
  } catch {
    return null;
  }
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.map((entry) => (typeof entry === "string" ? entry : undefined)));
}

function coerceString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function isArtifactType(value: unknown): value is CateoArtifactType {
  return typeof value === "string" && ARTIFACT_TYPES.includes(value as CateoArtifactType);
}

function assertCateoRuntime(runtime: CateoModelRuntime): void {
  if (!runtime.meta.orchestrationEnabled) {
    throw new Error("Cateo orchestration is disabled. Enable the three-role runtime before serving regulated artifacts.");
  }
  if (!runtime.lead) {
    throw new Error("Cateo artifact generation requires a lead model.");
  }
  if (!runtime.challenger || !runtime.meta.challenger) {
    throw new Error("Cateo artifact generation requires a challenger model.");
  }
  if (!runtime.structure || !runtime.meta.structure) {
    throw new Error("Cateo artifact generation requires a structure model.");
  }
}

function buildRoute(input: CateoAssistInput, context: CateoContextBundle): CateoRoutingDecision {
  const requestedArtifacts = inferRequestedArtifacts(input, context.taskClass);
  return {
    taskClass: context.taskClass,
    requestedArtifacts,
    useChallenger: true,
    useStructure: true,
    reasons: uniqueStrings([
      `Task class inferred as ${context.taskClass}.`,
      `Requested artifact package: ${requestedArtifacts.join(", ")}.`,
      "Cateo uses the planner, builder, and reviewer models for every regulated interaction.",
      context.serviceHistory.length > 0 ? `Maintenance history depth: ${context.serviceHistory.length} entries.` : "",
      context.digitalTwin?.status === "fail" ? "Digital twin deviations require explicit artifact review." : "",
    ]),
  };
}

function buildPromptPayload(input: CateoAssistInput, context: CateoContextBundle, route: CateoRoutingDecision): string {
  return JSON.stringify({
    request: {
      title: input.title,
      query: input.query,
      errorCode: input.errorCode,
      productOffering: input.productOffering,
      partNumber: input.partNumber,
      contextNotes: input.contextNotes,
      workflow: input.workflow,
      symptomDescription: input.symptomDescription,
      observedConditions: input.observedConditions ?? [],
      requestedArtifacts: route.requestedArtifacts,
    },
    context: {
      caseId: context.caseId,
      taskClass: context.taskClass,
      asset: context.asset,
      machine: context.machine,
      workOrder: context.workOrder,
      failureCode: context.failureCode,
      serviceHistory: context.serviceHistory.slice(0, 6),
      suggestedParts: context.suggestedParts.slice(0, 5),
      attachments: context.attachments,
      digitalTwin: context.digitalTwin,
      partResolution: context.partResolution,
      summary: context.contextSummary,
    },
    route,
  }, null, 2);
}

function fallbackLeadPlan(route: CateoRoutingDecision, context: CateoContextBundle, input: CateoAssistInput): CateoLeadPlan {
  return {
    taskClass: route.taskClass,
    objective: `Produce a ${route.requestedArtifacts.join(", ")} package for ${context.asset?.assetId ?? context.machine?.model ?? "the reported asset"}.`,
    evidencePlan: uniqueStrings([
      "Verify the reported symptom against the current operating state.",
      context.failureCode ? `Confirm the failure code ${context.failureCode.code} against the approved taxonomy.` : "Capture and classify the observed failure mode.",
      context.serviceHistory.length > 0 ? "Review recent maintenance history for repeat interventions and unresolved findings." : "Collect recent maintenance or work-order context before committing to a corrective path.",
      context.digitalTwin ? "Compare observed geometry against the expected reference state and record deviations." : "Capture dimensional, visual, or functional evidence required to confirm the fault state.",
    ]),
    assumptions: uniqueStrings([
      input.errorCode ? `The reported code ${input.errorCode} is relevant to the present symptom.` : "The reported symptom is current and reproducible.",
      context.asset?.assetId ? `The asset identity ${context.asset.assetId} is correct.` : "Asset identity requires operator confirmation.",
    ]),
    risks: uniqueStrings([
      "Do not return the equipment to service without validating the correction against acceptance criteria.",
      context.digitalTwin?.status === "fail" ? "Out-of-tolerance geometric conditions may indicate latent mechanical damage." : "Evidence gaps may hide a secondary cause if the inspection is rushed.",
    ]),
    decisionBasis: uniqueStrings([
      ...context.contextSummary,
      context.serviceHistory.length > 0 ? "Maintenance recurrence and unresolved findings influence the decision path." : "Limited maintenance history increases uncertainty.",
    ]),
    artifactPriorities: route.requestedArtifacts,
    maintenanceConsiderations: uniqueStrings([
      context.workOrder?.workOrderId ? `Tie all deliverables back to work order ${context.workOrder.workOrderId}.` : "Create a work-order-ready deliverable package.",
      "Keep regulatory traceability and revision control intact.",
    ]),
    partsConsiderations: uniqueStrings([
      context.suggestedParts.length > 0 ? `Known candidate parts: ${context.suggestedParts.map((entry) => entry.sku).join(", ")}.` : "No confident part mapping is available yet.",
      context.partResolution?.referenceDocuments?.length ? `Source document anchors: ${context.partResolution.referenceDocuments.slice(0, 4).join(", ")}.` : "No verified external document anchors are available yet.",
    ]),
  };
}

function fallbackCritique(context: CateoContextBundle): CateoChallengerCritique {
  return {
    alternateHypotheses: uniqueStrings([
      context.digitalTwin?.status === "fail" ? "Observed misalignment may be the primary fault rather than a secondary symptom." : "The reported failure code may be symptomatic rather than causal.",
      context.serviceHistory.length > 1 ? "A repeat maintenance pattern may point to an unresolved underlying cause or an ineffective previous repair." : "A process condition or setup drift may be contributing to the event.",
    ]),
    blindSpots: uniqueStrings([
      "Assumptions about asset configuration may be wrong if recent field modifications were not captured.",
      context.attachments.length === 0 ? "No direct visual evidence is attached to validate the current condition." : "Attached media may not capture the full failure envelope.",
    ]),
    missingAssumptions: ["Confirm process conditions, load, and environmental state at the time of the event."],
    evidenceGaps: uniqueStrings([
      context.digitalTwin ? "Need calibrated dimensional evidence and reference-state confirmation." : "Need calibrated measurements, not only narrative symptoms.",
      context.serviceHistory.length === 0 ? "Need at least one recent maintenance or work-order history entry." : "Need confirmation that previous corrective actions actually resolved prior events.",
      context.partResolution?.verifiedSources?.length ? "Cross-check the draft against the verified manufacturer/manual source set before release." : "No verified external source set is available, so generic engineering assumptions must be kept explicit.",
    ]),
    recommendedAdjustments: [
      "Add an explicit verification step that distinguishes root cause from symptomatic alarms.",
      "Carry unresolved evidence gaps into the service report and sign-off package.",
    ],
  };
}

function fallbackStructure(route: CateoRoutingDecision, context: CateoContextBundle): CateoStructureBlueprint {
  return {
    artifactPlans: route.requestedArtifacts.map((artifactType) => ({
      artifactType,
      title: `${artifactType.replace(/-/g, " ")} for ${context.asset?.assetId ?? context.machine?.model ?? "reported asset"}`,
      sectionOrder: artifactType === "inspection-checklist"
        ? ["scope", "prep", "safety", "checks", "completion"]
        : artifactType === "troubleshooting-procedure"
          ? ["objective", "evidence", "steps", "acceptance", "follow-up"]
          : ["summary", "findings", "actions", "risks", "recommendations"],
      qualityGates: [
        "Schema-compliant JSON output only.",
        "Reference the asset and work order when available.",
        "Make assumptions and evidence gaps explicit.",
      ],
      requiredEvidence: uniqueStrings([
        ...context.contextSummary,
        context.digitalTwin ? "Digital twin status and flagged deviations." : "Observed machine state and maintenance history.",
      ]),
    })),
  };
}

function fallbackFinal(route: CateoRoutingDecision, context: CateoContextBundle, leadPlan: CateoLeadPlan, critique?: CateoChallengerCritique): CateoFinalSynthesis {
  const confidence: CateoConfidence = critique && critique.evidenceGaps.length > 1 ? "medium" : (context.digitalTwin?.status === "fail" ? "high" : "medium");
  return {
    executiveSummary: `Prepared ${route.requestedArtifacts.length} structured Cateo artifact(s) for ${context.asset?.assetId ?? context.machine?.model ?? "the reported asset"} with explicit evidence, assumptions, and follow-up controls.`,
    decision: "draft",
    confidence,
    rootCauseStatement: critique?.alternateHypotheses?.[0]
      ? `Primary root-cause candidate remains under review. Leading concern: ${critique.alternateHypotheses[0]}`
      : leadPlan.objective,
    nextActions: uniqueStrings([
      ...leadPlan.evidencePlan.slice(0, 3),
      ...(critique?.recommendedAdjustments ?? []),
      "Route the artifact package for regulated review before execution or release.",
    ]),
    operatorNotes: uniqueStrings([
      ...context.contextSummary,
      "Artifacts remain in draft state until reviewed or approved through the revision workflow.",
    ]),
  };
}
async function callJsonStage<T>(params: {
  stage: string;
  llm: LLMProvider;
  modelInfo: CateoRuntimeModelInfo;
  systemPrompt: string;
  userPrompt: string;
  fallback: T;
  timeoutMs: number;
  maxTokens: number;
  requestId?: string;
}): Promise<StageResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, params.timeoutMs);

  try {
    const response = await params.llm.chat([
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userPrompt },
    ], undefined, {
      signal: controller.signal,
      maxTokens: params.maxTokens,
    });
    const usage = {
      inputTokens: response.usage.inputTokens ?? 0,
      outputTokens: response.usage.outputTokens ?? 0,
    };
    const raw = extractText(response);
    const parsed = parseJsonObject<T>(raw);
    if (!parsed) {
      appendAuditEvent({
        actor: "model",
        category: "cateo_stage",
        action: params.stage,
        outcome: "fallback",
        severity: "warn",
        message: `${params.stage} returned non-JSON output; using deterministic fallback`,
        requestId: params.requestId,
        metadata: {
          model: params.modelInfo.model,
          provider: params.modelInfo.provider,
          maxTokens: params.maxTokens,
          timeoutMs: params.timeoutMs,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
          fallbackReason: "non_json",
        },
      });
      return { data: params.fallback, raw, modelInfo: params.modelInfo, usage };
    }

    appendAuditEvent({
      actor: "model",
      category: "cateo_stage",
      action: params.stage,
      outcome: "success",
      message: `${params.stage} completed`,
      requestId: params.requestId,
      metadata: {
        model: params.modelInfo.model,
        provider: params.modelInfo.provider,
        maxTokens: params.maxTokens,
        timeoutMs: params.timeoutMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
      },
    });
    return { data: parsed, raw, modelInfo: params.modelInfo, usage };
  } catch (error) {
    const fallbackReason = timedOut ? "timeout" : "error";
    const raw = timedOut
      ? `${params.stage} exceeded the stage budget of ${params.timeoutMs}ms`
      : (error instanceof Error ? error.message : String(error));
    appendAuditEvent({
      actor: "model",
      category: "cateo_stage",
      action: params.stage,
      outcome: "fallback",
      severity: "warn",
      message: timedOut
        ? `${params.stage} exceeded ${params.timeoutMs}ms; using deterministic fallback`
        : `${params.stage} failed: ${raw}`,
      requestId: params.requestId,
      metadata: {
        model: params.modelInfo.model,
        provider: params.modelInfo.provider,
        maxTokens: params.maxTokens,
        timeoutMs: params.timeoutMs,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        fallbackReason,
      },
    });
    return { data: params.fallback, raw, modelInfo: params.modelInfo, usage: { ...ZERO_STAGE_USAGE } };
  } finally {
    clearTimeout(timeoutId);
  }
}
function findBlueprintTitle(blueprint: CateoStructureBlueprint | undefined, artifactType: CateoArtifactType, fallback: string): string {
  return blueprint?.artifactPlans.find((entry) => entry.artifactType === artifactType)?.title || fallback;
}

function buildToolList(taskClass: CateoTaskClass, context: CateoContextBundle): string[] {
  const tools = ["Inspection light", "Camera or mobile device for evidence capture"];
  if (taskClass === "troubleshooting" || taskClass === "root-cause-analysis") {
    tools.push("Calibrated multimeter", "Lockout/tagout kit");
  }
  if (context.digitalTwin) {
    tools.push("Calibrated measuring device");
  }
  return uniqueStrings(tools);
}

function buildSuggestedPartLines(parts: CateoPartCatalogEntry[]): string[] {
  return parts.map((part) => `${part.sku}: ${part.description}`);
}

function ensureHypotheses(critique: CateoChallengerCritique | undefined, finalSynthesis: CateoFinalSynthesis): CateoDiagnosticReasoningLog["hypotheses"] {
  const hypotheses = (critique?.alternateHypotheses ?? [finalSynthesis.rootCauseStatement]).slice(0, 4).map((entry, index) => ({
    name: entry,
    status: index === 0 && finalSynthesis.confidence === "high" ? "confirmed" as const : "candidate" as const,
    evidenceFor: [finalSynthesis.rootCauseStatement],
    evidenceAgainst: critique?.blindSpots.slice(0, 2) ?? [],
  }));
  return hypotheses.length > 0 ? hypotheses : [{
    name: finalSynthesis.rootCauseStatement,
    status: finalSynthesis.confidence === "high" ? "confirmed" : "candidate",
    evidenceFor: [finalSynthesis.executiveSummary],
    evidenceAgainst: [],
  }];
}

function buildTroubleshootingArtifact(
  input: CateoAssistInput,
  context: CateoContextBundle,
  leadPlan: CateoLeadPlan,
  critique: CateoChallengerCritique | undefined,
  blueprint: CateoStructureBlueprint | undefined,
  finalSynthesis: CateoFinalSynthesis,
): CateoTroubleshootingProcedure {
  const evidenceSummary = uniqueStrings([
    ...context.contextSummary,
    ...leadPlan.evidencePlan,
    ...(critique?.evidenceGaps ?? []),
  ]);

  const steps = leadPlan.evidencePlan.slice(0, 4).map((entry, index) => ({
    id: `ts-${index + 1}`,
    action: entry,
    rationale: critique?.recommendedAdjustments[index] ?? "This step reduces ambiguity before a corrective action is released.",
    expectedResult: index === 0
      ? "The symptom is reproduced or ruled out under a known operating state."
      : index === 1
        ? "The fault state is confirmed with objective evidence."
        : "Evidence is collected with enough quality to support the engineering decision.",
    escalationTrigger: critique?.blindSpots[index],
  }));

  return {
    title: findBlueprintTitle(blueprint, "troubleshooting-procedure", `Troubleshooting procedure for ${context.asset?.assetId ?? context.machine?.model ?? "reported asset"}`),
    objective: finalSynthesis.executiveSummary,
    failureCode: context.failureCode?.code ?? input.errorCode,
    symptoms: uniqueStrings([input.symptomDescription, ...context.observedConditions]),
    assumptions: uniqueStrings(leadPlan.assumptions),
    evidenceSummary,
    safetyPrecautions: uniqueStrings([
      "Verify energy isolation and process safety before intrusive inspection.",
      "Use approved personal protective equipment for the asset class and environment.",
      context.digitalTwin?.status === "fail" ? "Do not return the asset to service until the geometric deviation is resolved or accepted." : "",
    ]),
    requiredParts: buildSuggestedPartLines(context.suggestedParts),
    requiredTools: buildToolList(context.taskClass, context),
    steps: steps.length > 0 ? steps : [{
      id: "ts-1",
      action: "Confirm the reported symptom and capture objective evidence.",
      rationale: "The procedure must start from verified machine state, not narrative alone.",
      expectedResult: "A validated baseline condition is available for troubleshooting.",
    }],
    acceptanceCriteria: uniqueStrings([
      "The failure condition is cleared or bounded with objective evidence.",
      "No unresolved critical risks remain in the service report.",
      context.digitalTwin ? "All critical digital-twin deviations are resolved, remeasured, or dispositioned." : "",
    ]),
    followUpActions: uniqueStrings(finalSynthesis.nextActions),
  };
}

function buildInspectionArtifact(
  context: CateoContextBundle,
  leadPlan: CateoLeadPlan,
  critique: CateoChallengerCritique | undefined,
  blueprint: CateoStructureBlueprint | undefined,
): CateoInspectionChecklist {
  const checks = uniqueStrings([
    ...leadPlan.evidencePlan,
    ...context.observedConditions.map((entry) => `Inspect observed condition: ${entry}`),
    ...(context.digitalTwin?.flaggedFeatures ?? []).map((entry) => `Verify digital twin flag: ${entry}`),
    ...(critique?.evidenceGaps ?? []),
  ]).slice(0, 8);

  return {
    title: findBlueprintTitle(blueprint, "inspection-checklist", `Inspection checklist for ${context.asset?.assetId ?? context.machine?.model ?? "reported asset"}`),
    scope: `Inspection package for ${context.asset?.assetId ?? context.machine?.model ?? "the reported asset"}${context.workOrder?.workOrderId ? ` under work order ${context.workOrder.workOrderId}` : ""}.`,
    prepSteps: uniqueStrings([
      "Review the active work order, maintenance history, and approved reference documentation.",
      "Confirm asset identification, configuration, and safe access conditions.",
      context.digitalTwin ? "Load the expected-state reference model or tolerance sheet before inspection." : "",
    ]),
    safetyNotes: [
      "Observe site safety, isolation, and contamination-control procedures.",
      "Capture evidence in a way that preserves traceability and chain of review.",
    ],
    checklist: checks.map((check, index) => ({
      id: `ic-${index + 1}`,
      check,
      method: index % 2 === 0 ? "Visual and record review" : "Measurement or functional verification",
      passCriteria: index % 2 === 0 ? "Condition matches approved reference or expected state." : "Measured result is within the allowed tolerance or specification.",
      evidenceRequired: index % 2 === 0 ? "Photo, note, or signed observation record" : "Calibrated measurement, screenshot, or instrument capture",
      severityIfFailed: index === 0 ? "high" : context.digitalTwin?.status === "fail" ? "high" : "medium",
    })),
    completionCriteria: [
      "All required checks have objective evidence attached or referenced.",
      "Any failed critical check is escalated before release to service.",
    ],
  };
}

function buildServiceReportArtifact(
  context: CateoContextBundle,
  leadPlan: CateoLeadPlan,
  critique: CateoChallengerCritique | undefined,
  finalSynthesis: CateoFinalSynthesis,
  blueprint: CateoStructureBlueprint | undefined,
): CateoServiceReport {
  return {
    title: findBlueprintTitle(blueprint, "service-report", `Service report for ${context.asset?.assetId ?? context.machine?.model ?? "reported asset"}`),
    summary: finalSynthesis.executiveSummary,
    findings: uniqueStrings([
      ...context.contextSummary,
      ...leadPlan.decisionBasis,
      finalSynthesis.rootCauseStatement,
    ]),
    actionsPerformed: uniqueStrings([
      "Generated a schema-governed Cateo artifact package with traceable provenance.",
      ...leadPlan.evidencePlan.slice(0, 3),
    ]),
    unresolvedRisks: uniqueStrings([
      ...leadPlan.risks,
      ...(critique?.evidenceGaps ?? []),
    ]),
    recommendations: uniqueStrings(finalSynthesis.nextActions),
    signoffRequirement: "Electronic sign-off required by an authorized reviewer before the asset is released or the procedure is closed.",
  };
}

function buildPartsArtifact(context: CateoContextBundle, blueprint: CateoStructureBlueprint | undefined): CateoPartsToolsList {
  return {
    title: findBlueprintTitle(blueprint, "parts-tools-list", `Parts and tools list for ${context.asset?.assetId ?? context.machine?.model ?? "reported asset"}`),
    parts: context.suggestedParts.map((part) => ({
      sku: part.sku,
      description: part.description,
      quantity: part.quantitySuggested ?? 1,
      justification: context.failureCode?.label
        ? `Mapped as a candidate part for ${context.failureCode.label} and the reported symptom set.`
        : "Candidate support part based on the reported symptom and machine context.",
      storageLocation: part.storageLocation,
    })),
    tools: buildToolList(context.taskClass, context).map((tool) => ({
      name: tool,
      quantity: 1,
      purpose: "Required to execute the inspection, verification, or corrective workflow.",
    })),
    consumables: uniqueStrings([
      "Cleaning materials",
      "Inspection tags or evidence labels",
      context.taskClass === "preventive-maintenance" ? "Lubricant or approved service consumables" : "",
    ]),
  };
}

function buildReasoningArtifact(
  input: CateoAssistInput,
  leadPlan: CateoLeadPlan,
  critique: CateoChallengerCritique | undefined,
  finalSynthesis: CateoFinalSynthesis,
  blueprint: CateoStructureBlueprint | undefined,
): CateoDiagnosticReasoningLog {
  return {
    title: findBlueprintTitle(blueprint, "diagnostic-reasoning-log", "Diagnostic reasoning log"),
    problemStatement: input.symptomDescription,
    hypotheses: ensureHypotheses(critique, finalSynthesis),
    assumptions: uniqueStrings([
      ...leadPlan.assumptions,
      ...(critique?.missingAssumptions ?? []),
    ]),
    evidenceRequests: uniqueStrings([
      ...leadPlan.evidencePlan,
      ...(critique?.evidenceGaps ?? []),
    ]),
    rootCauseStatement: finalSynthesis.rootCauseStatement,
    confidence: finalSynthesis.confidence,
  };
}
function buildArtifactContent(
  artifactType: CateoArtifactType,
  input: CateoAssistInput,
  context: CateoContextBundle,
  leadPlan: CateoLeadPlan,
  critique: CateoChallengerCritique | undefined,
  blueprint: CateoStructureBlueprint | undefined,
  finalSynthesis: CateoFinalSynthesis,
): CateoArtifactContent {
  switch (artifactType) {
    case "troubleshooting-procedure":
      return buildTroubleshootingArtifact(input, context, leadPlan, critique, blueprint, finalSynthesis);
    case "inspection-checklist":
      return buildInspectionArtifact(context, leadPlan, critique, blueprint);
    case "service-report":
      return buildServiceReportArtifact(context, leadPlan, critique, finalSynthesis, blueprint);
    case "parts-tools-list":
      return buildPartsArtifact(context, blueprint);
    case "diagnostic-reasoning-log":
      return buildReasoningArtifact(input, leadPlan, critique, finalSynthesis, blueprint);
    default:
      throw new Error(`Unsupported artifact type: ${artifactType}`);
  }
}

function summarizeArtifactContent(artifactType: CateoArtifactType, content: CateoArtifactContent): string {
  switch (artifactType) {
    case "troubleshooting-procedure":
      return `${content.title} with ${(content as CateoTroubleshootingProcedure).steps.length} procedural step(s)`;
    case "inspection-checklist":
      return `${content.title} with ${(content as CateoInspectionChecklist).checklist.length} checklist item(s)`;
    case "service-report":
      return `${content.title} summarizing ${(content as CateoServiceReport).findings.length} finding(s)`;
    case "parts-tools-list":
      return `${content.title} covering ${(content as CateoPartsToolsList).parts.length} part candidate(s)`;
    case "diagnostic-reasoning-log":
      return `${content.title} covering ${(content as CateoDiagnosticReasoningLog).hypotheses.length} hypothesis/hypotheses`;
    default:
      return "Cateo artifact";
  }
}

function normalizeStructureBlueprint(raw: RawBuilderOutput, route: CateoRoutingDecision, context: CateoContextBundle): CateoStructureBlueprint {
  const fallback = fallbackStructure(route, context);
  if (!Array.isArray(raw.artifactPlans)) {
    return fallback;
  }

  const parsedPlans = raw.artifactPlans
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      if (!isArtifactType(record.artifactType)) {
        return null;
      }
      const fallbackPlan = fallback.artifactPlans.find((plan) => plan.artifactType === record.artifactType);
      return {
        artifactType: record.artifactType,
        title: coerceString(record.title, fallbackPlan?.title ?? record.artifactType),
        sectionOrder: coerceStringArray(record.sectionOrder).length > 0 ? coerceStringArray(record.sectionOrder) : (fallbackPlan?.sectionOrder ?? []),
        qualityGates: coerceStringArray(record.qualityGates).length > 0 ? coerceStringArray(record.qualityGates) : (fallbackPlan?.qualityGates ?? []),
        requiredEvidence: coerceStringArray(record.requiredEvidence).length > 0 ? coerceStringArray(record.requiredEvidence) : (fallbackPlan?.requiredEvidence ?? []),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (parsedPlans.length === 0) {
    return fallback;
  }

  return {
    artifactPlans: route.requestedArtifacts.map((artifactType) => parsedPlans.find((entry) => entry.artifactType === artifactType) ?? fallback.artifactPlans.find((entry) => entry.artifactType === artifactType)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
  };
}

function normalizeReviewerCritique(raw: ReviewerStageOutput, context: CateoContextBundle): CateoChallengerCritique {
  const fallback = fallbackCritique(context);
  return {
    alternateHypotheses: coerceStringArray(raw.alternateHypotheses).length > 0 ? coerceStringArray(raw.alternateHypotheses) : fallback.alternateHypotheses,
    blindSpots: coerceStringArray(raw.blindSpots).length > 0 ? coerceStringArray(raw.blindSpots) : fallback.blindSpots,
    missingAssumptions: coerceStringArray(raw.missingAssumptions).length > 0 ? coerceStringArray(raw.missingAssumptions) : fallback.missingAssumptions,
    evidenceGaps: coerceStringArray(raw.evidenceGaps).length > 0 ? coerceStringArray(raw.evidenceGaps) : fallback.evidenceGaps,
    recommendedAdjustments: coerceStringArray(raw.recommendedAdjustments).length > 0 ? coerceStringArray(raw.recommendedAdjustments) : fallback.recommendedAdjustments,
  };
}

function normalizeBuilderPackage(args: {
  raw: RawBuilderOutput;
  route: CateoRoutingDecision;
  input: CateoAssistInput;
  context: CateoContextBundle;
  leadPlan: CateoLeadPlan;
  critique: CateoChallengerCritique | undefined;
  blueprint: CateoStructureBlueprint;
  finalSynthesis: CateoFinalSynthesis;
}): CateoBuilderPackage {
  const rawDrafts = Array.isArray(args.raw.artifactDrafts) ? args.raw.artifactDrafts : [];
  const draftMap = new Map<CateoArtifactType, RawBuilderArtifactDraft>();
  for (const entry of rawDrafts) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const draft = entry as RawBuilderArtifactDraft;
    if (isArtifactType(draft.artifactType) && !draftMap.has(draft.artifactType)) {
      draftMap.set(draft.artifactType, draft);
    }
  }

  const artifactDrafts: CateoBuilderPackage["artifactDrafts"] = args.route.requestedArtifacts.map((artifactType): CateoBuilderPackage["artifactDrafts"][number] => {
    const rawDraft = draftMap.get(artifactType);
    const attemptedContent = rawDraft?.content as CateoArtifactContent | undefined;
    const attemptedErrors = attemptedContent ? validateArtifactContent(artifactType, attemptedContent) : ["content: missing"];
    const usedModelDraft = Boolean(attemptedContent) && attemptedErrors.length === 0;
    const content: CateoArtifactContent = usedModelDraft && attemptedContent
      ? attemptedContent
      : buildArtifactContent(artifactType, args.input, args.context, args.leadPlan, args.critique, args.blueprint, args.finalSynthesis);
    const contentTitle = coerceString((content as { title?: unknown }).title, artifactType);

    return {
      artifactType,
      title: coerceString(rawDraft?.title, contentTitle),
      content,
      generationMode: usedModelDraft ? "model" : "deterministic-fallback",
      validationErrors: usedModelDraft ? [] : attemptedErrors,
      notes: usedModelDraft
        ? uniqueStrings(coerceStringArray(rawDraft?.notes))
        : uniqueStrings([
            ...coerceStringArray(rawDraft?.notes),
            attemptedContent ? `Model draft for ${artifactType} failed validation and was replaced with a deterministic artifact build.` : `No model draft was returned for ${artifactType}; Cateo used a deterministic artifact build.`,
          ]),
    };
  });

  return {
    packageSummary: coerceString(args.raw.packageSummary, `Structured Cateo package with ${artifactDrafts.length} artifact(s).`),
    artifactPlans: args.blueprint.artifactPlans,
    artifactDrafts,
  };
}

function fallbackReviewerDecision(builderPackage: CateoBuilderPackage, route: CateoRoutingDecision, critique: CateoChallengerCritique): CateoReviewerDecision {
  const fallbackUsed = builderPackage.artifactDrafts.some((draft) => draft.generationMode === "deterministic-fallback");
  const needsAttention = fallbackUsed || critique.evidenceGaps.length > 0 || critique.missingAssumptions.length > 0;
  return {
    overallStatus: needsAttention ? "needs-revision" : "pass",
    technicalAccuracy: critique.evidenceGaps.length > 0 ? "needs-attention" : "pass",
    completeness: critique.missingAssumptions.length > 0 ? "needs-attention" : "pass",
    compliance: fallbackUsed ? "needs-attention" : "pass",
    findings: uniqueStrings([
      fallbackUsed ? "One or more artifacts required deterministic fallback generation." : "",
      ...critique.evidenceGaps,
      ...critique.blindSpots,
    ]),
    approvedArtifactTypes: fallbackUsed ? [] : route.requestedArtifacts,
    approvalState: fallbackUsed ? "draft" : "reviewed",
    confidence: fallbackUsed ? "medium" : "high",
    summary: fallbackUsed
      ? "Reviewer held the package in draft because one or more artifacts require follow-up review."
      : "Reviewer validated the artifact package for controlled use and conversational rendering.",
    requiredFollowUp: uniqueStrings([
      ...critique.recommendedAdjustments,
      ...critique.evidenceGaps,
      "Authorized electronic sign-off is still required before regulated release.",
    ]),
  };
}

function normalizeReviewerDecision(
  raw: unknown,
  builderPackage: CateoBuilderPackage,
  route: CateoRoutingDecision,
  critique: CateoChallengerCritique,
): CateoReviewerDecision {
  const fallback = fallbackReviewerDecision(builderPackage, route, critique);
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const approvedArtifactTypes = Array.isArray(record.approvedArtifactTypes)
    ? record.approvedArtifactTypes.filter((entry): entry is CateoArtifactType => isArtifactType(entry) && route.requestedArtifacts.includes(entry))
    : fallback.approvedArtifactTypes;

  const fallbackUsed = builderPackage.artifactDrafts.some((draft) => draft.generationMode === "deterministic-fallback");
  const technicalAccuracy = record.technicalAccuracy === "pass" || record.technicalAccuracy === "needs-attention" ? record.technicalAccuracy : fallback.technicalAccuracy;
  const completeness = record.completeness === "pass" || record.completeness === "needs-attention" ? record.completeness : fallback.completeness;
  const compliance = record.compliance === "pass" || record.compliance === "needs-attention" ? record.compliance : fallback.compliance;
  const overallStatus = record.overallStatus === "pass" || record.overallStatus === "needs-revision" ? record.overallStatus : fallback.overallStatus;
  const requestedApprovalState = record.approvalState === "draft" || record.approvalState === "reviewed" || record.approvalState === "approved"
    ? record.approvalState
    : fallback.approvalState;

  const derivedApprovalState = fallbackUsed || overallStatus === "needs-revision" || technicalAccuracy === "needs-attention" || completeness === "needs-attention" || compliance === "needs-attention"
    ? "draft"
    : (requestedApprovalState === "approved" ? "reviewed" : requestedApprovalState);

  return {
    overallStatus,
    technicalAccuracy,
    completeness,
    compliance,
    findings: coerceStringArray(record.findings).length > 0 ? coerceStringArray(record.findings) : fallback.findings,
    approvedArtifactTypes: derivedApprovalState === "draft" ? [] : (approvedArtifactTypes.length > 0 ? approvedArtifactTypes : route.requestedArtifacts),
    approvalState: derivedApprovalState,
    confidence: record.confidence === "low" || record.confidence === "medium" || record.confidence === "high" ? record.confidence : fallback.confidence,
    summary: coerceString(record.summary, fallback.summary),
    requiredFollowUp: coerceStringArray(record.requiredFollowUp).length > 0 ? coerceStringArray(record.requiredFollowUp) : fallback.requiredFollowUp,
  };
}

function collectBuilderValidationErrors(builderPackage: CateoBuilderPackage): string[] {
  return builderPackage.artifactDrafts.flatMap((draft) => {
    const errors = draft.validationErrors ?? [];
    return errors.map((error) => `${draft.artifactType}: ${error}`);
  });
}

function shouldMergeArtifact(candidate: CateoArtifactLookupCandidate | undefined): boolean {
  if (!candidate) return false;
  if (candidate.score >= 0.92) return true;
  if (candidate.basis.includes("asset_exact") && candidate.score >= 0.58) return true;
  if (candidate.basis.includes("work_order_exact") && candidate.score >= 0.5) return true;
  return false;
}

function normalizedText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function valuesInclude(haystacks: Array<string | undefined | null>, needles: Array<string | undefined | null>): boolean {
  const normalizedHaystack = haystacks.map((value) => normalizedText(value)).filter((value): value is string => Boolean(value));
  const normalizedNeedles = needles.map((value) => normalizedText(value)).filter((value): value is string => Boolean(value));
  if (normalizedNeedles.length === 0) {
    return false;
  }
  return normalizedNeedles.some((needle) => normalizedHaystack.some((haystack) => haystack.includes(needle) || needle.includes(haystack)));
}

function reuseIssueSignals(input: CateoAssistInput, context: CateoContextBundle): string[] {
  return uniqueStrings([
    input.issueType,
    input.errorCode,
    context.issueType,
    context.failureCode?.code,
    context.failureCode?.label,
    context.taskClass,
  ]);
}

function reuseSystemSignals(input: CateoAssistInput, context: CateoContextBundle): string[] {
  return uniqueStrings([
    context.asset?.assetId,
    context.asset?.assetType,
    context.asset?.model,
    context.machine?.manufacturer,
    context.machine?.model,
    input.title,
  ]);
}

function scoreProcedureReuseCandidate(params: {
  candidate: CateoArtifactLookupCandidate;
  artifact: CateoArtifactRecord;
  input: CateoAssistInput;
  context: CateoContextBundle;
}): number {
  const latest = params.artifact.revisions.at(-1);
  const metadata = latest?.metadata;
  if (!latest || !metadata) {
    return -1;
  }
  if (latest.approvalState === "draft") {
    return -1;
  }
  const requestedPart = normalizedText(params.context.partResolution?.partNumber || params.input.partNumber);
  const candidatePart = normalizedText(metadata.parts?.primaryPartNumber || metadata.partNumber);
  if (!requestedPart || !candidatePart || requestedPart != candidatePart) {
    return -1;
  }

  let score = params.candidate.score;
  const issueMatched = valuesInclude(
    [metadata.classification?.failureCode, metadata.classification?.failureLabel, metadata.classification?.failureMode],
    reuseIssueSignals(params.input, params.context),
  );
  const systemMatched = valuesInclude(
    [metadata.asset?.assetId, metadata.asset?.assetType, metadata.asset?.manufacturer, metadata.asset?.model, metadata.componentTitle],
    reuseSystemSignals(params.input, params.context),
  );

  if (issueMatched) score += 1.4;
  if (systemMatched) score += 0.8;
  if (latest.approvalState === "approved") score += 0.6;
  if (params.artifact.duplicateState === "duplicate") score -= 1;
  return score;
}

export async function findMatchingValidatedProcedure(
  config: CashClawConfig,
  input: CateoAssistInput,
  options: ServiceOptions = {},
): Promise<CateoAssistResult | null> {
  const actor = options.actor ?? "system";
  const requester = options.requester ? { ...options.requester } : undefined;
  const normalizedInput = normalizeAssistInput(input);
  const mediaEnhanced = await enrichAssistInputWithOpenAIMedia(config, normalizedInput, options.requestId);
  const enrichedInput = mediaEnhanced.input;
  const caseId = crypto.randomUUID();
  const sanitizedInput = normalizeAssistInput(sanitizeAssistInputForPersistence(enrichedInput));
  const attachmentEvidence = ingestMediaAttachments(caseId, enrichedInput.attachments, options.requestId);
  const partResolution = await resolveCateoPart(config, sanitizedInput, options.requestId);
  if (partResolution.needsClarification) {
    return null;
  }
  const context = buildCateoContext(caseId, sanitizedInput, attachmentEvidence, partResolution);
  if (context.taskClass !== "troubleshooting") {
    return null;
  }

  let route = buildRoute(sanitizedInput, context);
  const requestedTemplate = sanitizedInput.instructionTemplate;
  const template = getInstructionTemplate(requestedTemplate?.taskClass ?? route.taskClass, route.requestedArtifacts);
  route = {
    ...route,
    taskClass: template.taskClass,
    requestedArtifacts: template.requiredArtifacts,
  };
  const adapters: CateoAdapterCapability[] = listCateoAdapters();
  const activeAdapters = adapters.filter((adapter) => adapter.status === "detected" || adapter.status === "available");
  const activeSkills: CateoSkillActivation[] = resolveCateoSkillsForAssistInput(sanitizedInput, route.taskClass);
  route = {
    ...route,
    activeSkillIds: activeSkills.map((skill) => skill.id),
    capabilityTags: [...new Set([...activeSkills.flatMap((skill) => skill.datasetTags), ...activeAdapters.map((adapter) => adapter.id)])],
    reasons: [...route.reasons, ...summarizeSkillReasons(activeSkills).slice(0, 4)],
  };

  const matches = findSimilarArtifacts({
    text: [
      sanitizedInput.symptomDescription,
      sanitizedInput.issueType,
      sanitizedInput.errorCode,
      context.issueType,
      context.failureCode?.code,
      context.failureCode?.label,
      context.asset?.assetId,
      context.machine?.manufacturer,
      context.machine?.model,
      sanitizedInput.businessType,
    ].filter(Boolean).join("\n"),
    artifactType: "troubleshooting-procedure",
    assetId: context.asset?.assetId,
    workOrderId: context.workOrder?.workOrderId,
    partNumber: context.partResolution?.partNumber,
    limit: 8,
    minScore: 0.35,
  }).map((match) => ({
    artifactId: match.artifactId,
    artifactType: match.artifactType as CateoArtifactType,
    caseId: match.caseId,
    assetId: match.assetId,
    workOrderId: match.workOrderId,
    score: match.score,
    basis: match.basis,
    revisionNumber: match.revisionNumber,
    approvalState: match.approvalState === "approved" || match.approvalState === "reviewed" || match.approvalState === "draft"
      ? match.approvalState
      : "draft",
    updatedAt: match.updatedAt,
  } satisfies CateoArtifactLookupCandidate));

  const ranked: Array<{ candidate: CateoArtifactLookupCandidate; artifact: CateoArtifactRecord; reuseScore: number }> = matches
    .map((candidate): { candidate: CateoArtifactLookupCandidate; artifact: CateoArtifactRecord | null } => ({
      candidate,
      artifact: loadArtifactRecord(candidate.artifactId),
    }))
    .filter((entry) => Boolean(entry.artifact))
    .map((entry) => {
      const artifact = entry.artifact as CateoArtifactRecord;
      return {
        candidate: entry.candidate,
        artifact,
        reuseScore: scoreProcedureReuseCandidate({ candidate: entry.candidate, artifact, input: sanitizedInput, context }),
      };
    })
    .filter((entry) => entry.reuseScore >= 1.85)
    .sort((left, right) => right.reuseScore - left.reuseScore || right.candidate.updatedAt.localeCompare(left.candidate.updatedAt));

  const best = ranked[0];
  if (!best) {
    return null;
  }

  const sourceCase = loadCaseRecord(best.candidate.caseId);
  const relatedArtifacts: CateoArtifactRecord[] = (sourceCase?.artifacts ?? [best.artifact.artifactId])
    .map((artifactId: string) => loadArtifactRecord(artifactId))
    .filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact))
    .filter((artifact) => {
      const latest = artifact.revisions.at(-1);
      const part = normalizedText(latest?.metadata?.parts?.primaryPartNumber || latest?.metadata?.partNumber);
      const requestedPart = normalizedText(context.partResolution?.partNumber || sanitizedInput.partNumber);
      if (requestedPart && part && requestedPart !== part) {
        return false;
      }
      return latest?.approvalState === "approved" || latest?.approvalState === "reviewed";
    });

  const artifacts: CateoArtifactRecord[] = relatedArtifacts.length > 0 ? relatedArtifacts : [best.artifact];
  const interaction = renderCateoInteraction(artifacts, { detailLevel: sanitizedInput.responseDetail });
  interaction.message = `Cateo found an existing validated troubleshooting procedure for ${context.partResolution?.partNumber}. Returning the current controlled version immediately.

${interaction.message}`;
  interaction.highlights = uniqueStrings([
    `Matched validated procedure ${best.artifact.artifactId} for ${context.partResolution?.partNumber}.`,
    ...interaction.highlights,
  ]);
  interaction.releaseStatus = "available";
  interaction.requiresEngineerReview = false;

  const nowIso = new Date().toISOString();
  const runId = crypto.randomUUID();
  const leadPlan = fallbackLeadPlan(route, context, sanitizedInput);
  const finalSynthesis = fallbackFinal(route, context, leadPlan);
  const checkpoints = [
    buildCheckpoint({
      stage: "accepted",
      status: "completed",
      summary: "Cateo accepted the request and checked the validated troubleshooting catalog.",
      taskClass: route.taskClass,
      artifactTypes: ["troubleshooting-procedure"],
      artifactCount: artifacts.length,
    }),
    buildCheckpoint({
      stage: "completed",
      status: "completed",
      summary: "Cateo returned an existing validated troubleshooting procedure without queuing a new generation run.",
      taskClass: route.taskClass,
      confidence: interaction.confidence,
      artifactTypes: artifacts.map((artifact) => artifact.artifactType),
      artifactCount: artifacts.length,
    }),
  ];
  const usage = buildUsageSummary([]);
  const trace: CateoReasoningTrace = {
    route,
    template,
    partResolution,
    activeSkills,
    adapters: activeAdapters,
    validationAttempts: [],
    ruleResults: [],
    lookupCandidates: matches,
    persistActions: [],
    prompts: {
      planner: "",
      builder: "",
      reviewer: "",
    },
    leadPlan,
    finalSynthesis,
    reviewerDecision: {
      overallStatus: "pass",
      technicalAccuracy: "pass",
      completeness: "pass",
      compliance: "pass",
      findings: [`Matched validated procedure ${best.artifact.artifactId}.`],
      approvedArtifactTypes: ["troubleshooting-procedure"],
      approvalState: best.candidate.approvalState === "approved" ? "approved" : "reviewed",
      confidence: interaction.confidence,
      summary: `Returned validated procedure ${best.artifact.artifactId} from the internal catalog.`,
      requiredFollowUp: [],
    },
  };

  const caseRecord: CateoCaseRecord = {
    caseId: context.caseId,
    runId,
    createdAt: nowIso,
    updatedAt: nowIso,
    input: sanitizedInput,
    context,
    artifacts: [...new Set(artifacts.map((artifact: CateoArtifactRecord) => artifact.artifactId))],
    interaction,
    requester,
    conversationId: requester?.conversationId,
    userId: requester?.userId,
    usage,
    trace,
  };

  saveCaseRecord(caseRecord);
  try {
    persistTroubleshootingReportPackage(caseRecord, artifacts);
  } catch (reportError) {
    appendAuditEvent({
      actor: "runtime",
      category: "cateo_report_package",
      action: "persist",
      outcome: "warn",
      severity: "warn",
      message: `Failed to persist reused troubleshooting report package for case ${context.caseId}`,
      requestId: options.requestId,
      metadata: { error: reportError instanceof Error ? reportError.message : String(reportError) },
    });
  }

  appendAuditEvent({
    actor: "runtime",
    category: "cateo_lookup",
    action: "reuse_validated_procedure",
    outcome: "success",
    message: `Returned existing validated procedure ${best.artifact.artifactId} for case ${context.caseId}`,
    requestId: options.requestId,
    metadata: {
      matchedArtifactId: best.artifact.artifactId,
      matchedCaseId: best.candidate.caseId,
      caseId: context.caseId,
      partNumber: context.partResolution?.partNumber,
      issueType: context.issueType,
      businessType: context.businessType,
      reuseScore: best.reuseScore,
    },
  });

  if (config.security.persistence.persistDatasets) {
    appendCateoInteraction({
      schemaVersion: "1.0",
      kind: "cateo_interaction",
      timestamp: Date.now(),
      caseId: context.caseId,
      runId,
      profileId: requester?.profileId,
      requesterId: requester?.requesterId,
      userId: requester?.userId,
      conversationId: requester?.conversationId,
      organization: requester?.organization,
      emailHash: requester?.emailHash,
      taskClass: route.taskClass,
      assetId: context.asset?.assetId,
      workOrderId: context.workOrder?.workOrderId,
      prompt: sanitizedInput.symptomDescription,
      errorCode: sanitizedInput.errorCode,
      observedConditions: context.observedConditions,
      attachmentCount: context.attachments.length,
      requestedArtifacts: route.requestedArtifacts,
      activeSkillIds: activeSkills.map((skill) => skill.id),
      activeAdapterIds: activeAdapters.map((adapter) => adapter.id),
      capabilityTags: route.capabilityTags,
      artifactTypes: artifacts.map((artifact) => artifact.artifactType),
      interactionMessage: interaction.message,
      highlights: interaction.highlights,
      nextActions: interaction.nextActions,
      confidence: interaction.confidence,
      contextSummary: context.contextSummary,
      checkpoints: checkpoints.map((checkpoint) => ({
        stage: checkpoint.stage,
        status: checkpoint.status,
        summary: checkpoint.summary,
      })),
      modelsUsed: [],
      usage,
      executiveSummary: finalSynthesis.executiveSummary,
      rootCauseStatement: finalSynthesis.rootCauseStatement,
      reviewerSummary: `Validated procedure ${best.artifact.artifactId} reused from the internal catalog.`,
    });
  }

  return {
    caseId: context.caseId,
    runId,
    summary: interaction.message,
    interaction,
    checkpoints,
    context,
    requester,
    usage,
    trace,
    artifacts,
  };
}

function checkpointLabel(stage: CateoInteractionCheckpoint["stage"]): string {
  switch (stage) {
    case "accepted":
      return "Backlog";
    case "planning":
      return "Planner";
    case "building":
      return "Builder";
    case "reviewing":
      return "Reviewer";
    case "persisting":
      return "Artifact Store";
    case "rendering":
      return "Renderer";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    default:
      return "Cateo";
  }
}

function buildCheckpoint(args: {
  stage: CateoInteractionCheckpoint["stage"];
  status: CateoInteractionCheckpoint["status"];
  summary: string;
  taskClass?: CateoTaskClass;
  confidence?: CateoConfidence;
  artifactTypes?: CateoArtifactType[];
  artifactCount?: number;
}): CateoInteractionCheckpoint {
  return {
    checkpointId: crypto.randomUUID(),
    stage: args.stage,
    status: args.status,
    label: checkpointLabel(args.stage),
    summary: args.summary,
    occurredAt: Date.now(),
    taskClass: args.taskClass,
    confidence: args.confidence,
    artifactTypes: args.artifactTypes,
    artifactCount: args.artifactCount,
  };
}
function buildProvenance(args: {
  runId: string;
  requestId?: string;
  createdAt: string;
  actor: string;
  taskClass: CateoTaskClass;
  modelsUsed: CateoRuntimeModelInfo[];
  evidenceFingerprint: string;
  promptFingerprint?: string;
  profileId?: string;
  userId?: string;
  conversationId?: string;
  messageId?: string;
  templateId?: string;
  templateVersion?: string;
}) {
  return {
    runId: args.runId,
    requestId: args.requestId,
    createdAt: args.createdAt,
    createdBy: args.actor,
    source: "cateo-v1" as const,
    taskClass: args.taskClass,
    modelsUsed: args.modelsUsed,
    evidenceFingerprint: args.evidenceFingerprint,
    promptFingerprint: args.promptFingerprint,
    profileId: args.profileId,
    userId: args.userId,
    conversationId: args.conversationId,
    messageId: args.messageId,
    templateId: args.templateId,
    templateVersion: args.templateVersion,
  };
}
export async function generateCateoArtifacts(
  config: CashClawConfig,
  runtime: CateoModelRuntime,
  input: CateoAssistInput,
  options: ServiceOptions = {},
): Promise<CateoAssistResult> {
  assertCateoRuntime(runtime);

  const actor = options.actor ?? "system";
  const nowIso = new Date().toISOString();
  const caseId = crypto.randomUUID();
  const requester = options.requester ? { ...options.requester } : undefined;
  const normalizedInput = normalizeAssistInput(input);
  const mediaEnhanced = await enrichAssistInputWithOpenAIMedia(config, normalizedInput, options.requestId);
  const enrichedInput = mediaEnhanced.input;
  const sanitizedInput = normalizeAssistInput(sanitizeAssistInputForPersistence(enrichedInput));
  const attachmentEvidence = ingestMediaAttachments(caseId, enrichedInput.attachments, options.requestId);
  const partResolution = await resolveCateoPart(config, sanitizedInput, options.requestId);
  const context = buildCateoContext(caseId, sanitizedInput, attachmentEvidence, partResolution);
  let route = buildRoute(sanitizedInput, context);
  const requestedTemplate = sanitizedInput.instructionTemplate;
  const template = getInstructionTemplate(requestedTemplate?.taskClass ?? route.taskClass, route.requestedArtifacts);
  route = {
    ...route,
    taskClass: template.taskClass,
    requestedArtifacts: template.requiredArtifacts,
  };
  const adapters: CateoAdapterCapability[] = listCateoAdapters();
  const activeAdapters = adapters.filter((adapter) => adapter.status === "detected" || adapter.status === "available");
  const activeSkills: CateoSkillActivation[] = resolveCateoSkillsForAssistInput(sanitizedInput, route.taskClass);
  route = {
    ...route,
    activeSkillIds: activeSkills.map((skill) => skill.id),
    capabilityTags: [...new Set([...activeSkills.flatMap((skill) => skill.datasetTags), ...activeAdapters.map((adapter) => adapter.id)])],
    reasons: [...route.reasons, ...summarizeSkillReasons(activeSkills).slice(0, 4)],
  };
  const templatePayload = renderInstructionTemplate(template);
  const promptPayload = buildPromptPayload(sanitizedInput, context, route);
  const plannerPrompt = [
    "You are Cateo's planner model for a controlled engineering artifact pipeline.",
    "Return JSON only.",
    "Use the instruction template, source hierarchy, and known context before relying on general reasoning.",
    "Instruction template:",
    templatePayload,
    "Request and context payload:",
    promptPayload,
  ].join("\n\n");
  const checkpoints: CateoInteractionCheckpoint[] = [];
  const stageUsages: CateoStageUsage[] = [];
  const validationAttempts: CateoValidationAttempt[] = [];
  const lookupCandidates: CateoArtifactLookupCandidate[] = [];
  const persistActions: CateoArtifactPersistAction[] = [];
  const publishCheckpoint = (checkpoint: CateoInteractionCheckpoint): CateoInteractionCheckpoint => {
    checkpoints.push(checkpoint);
    options.onCheckpoint?.(checkpoint);
    appendAuditEvent({
      actor: "runtime",
      category: "cateo_checkpoint",
      action: checkpoint.stage,
      outcome: checkpoint.status,
      message: checkpoint.summary,
      requestId: options.requestId,
      severity: checkpoint.status === "failed" ? "error" : "info",
      metadata: {
        label: checkpoint.label,
        taskClass: checkpoint.taskClass,
        confidence: checkpoint.confidence,
        artifactTypes: checkpoint.artifactTypes,
        artifactCount: checkpoint.artifactCount,
      },
    });
    return checkpoint;
  };

  appendAuditEvent({
    actor: "runtime",
    category: "cateo_template",
    action: "select",
    outcome: "success",
    message: `Selected instruction template ${template.templateId}@${template.version}`,
    requestId: options.requestId,
    metadata: {
      requestedTemplateId: requestedTemplate?.templateId,
      requestedVersion: requestedTemplate?.version,
      requestedTaskClass: requestedTemplate?.taskClass,
      appliedTemplateId: template.templateId,
      appliedVersion: template.version,
      taskClass: route.taskClass,
      artifactTypes: route.requestedArtifacts,
      provider: config.llm.provider,
      leadModel: runtime.meta.lead.model,
      challengerModel: runtime.meta.challenger?.model,
      structureModel: runtime.meta.structure?.model,
    },
  });

  if (requestedTemplate?.templateId && requestedTemplate.templateId !== template.templateId) {
    appendAuditEvent({
      actor: "runtime",
      category: "cateo_template",
      action: "template_id_mismatch",
      outcome: "warn",
      severity: "warn",
      message: `Requested template ${requestedTemplate.templateId} did not match the applied template ${template.templateId}`,
      requestId: options.requestId,
    });
  }

  if (requestedTemplate?.version && requestedTemplate.version !== template.version) {
    appendAuditEvent({
      actor: "runtime",
      category: "cateo_template",
      action: "version_mismatch",
      outcome: "warn",
      severity: "warn",
      message: `Requested template version ${requestedTemplate.version} did not match the applied version ${template.version}`,
      requestId: options.requestId,
    });
  }

  try {
    publishCheckpoint(buildCheckpoint({
      stage: "accepted",
      status: "completed",
      summary: "Cateo accepted the request and bound it to a controlled artifact template.",
      taskClass: route.taskClass,
      artifactTypes: route.requestedArtifacts,
    }));

    publishCheckpoint(buildCheckpoint({
      stage: "planning",
      status: "running",
      summary: "Planner is classifying the request and defining the evidence plan.",
      taskClass: route.taskClass,
      artifactTypes: route.requestedArtifacts,
    }));

    if (partResolution.needsClarification) {
      const clarificationConfidence: CateoConfidence = partResolution.confidencePct >= 80
        ? "high"
        : partResolution.confidencePct >= 50
          ? "medium"
          : "low";
      const leadPlan = fallbackLeadPlan(route, context, sanitizedInput);
      const critique = fallbackCritique(context);
      const finalSynthesis = fallbackFinal(route, context, leadPlan, critique);
      const runId = crypto.randomUUID();
      const usage = buildUsageSummary(stageUsages);
      const interaction = {
        message: partResolution.clarifyingQuestion || "I need the exact manufacturer part number before I can generate the engineering package.",
        highlights: uniqueStrings([
          partResolution.partNumber ? `Candidate part number: ${partResolution.partNumber}` : undefined,
          ...partResolution.evidence.slice(0, 3),
        ]),
        nextActions: uniqueStrings([
          "Reply with the exact manufacturer part number or a clear nameplate photo.",
          "Include any visible model, revision, or serial markings on the component.",
        ]),
        confidence: clarificationConfidence,
        artifactCount: 0,
        artifactLabels: [],
        conversationTitle: partResolution.partNumber || context.asset?.assetId || context.machine?.model || "Cateo conversation",
        clarifyingQuestion: partResolution.clarifyingQuestion,
        releaseStatus: "clarification-required" as const,
        renderedAt: new Date().toISOString(),
        rendererVersion: "cateo-renderer-v2",
      };
      const trace = {
        route,
        template,
        partResolution,
        activeSkills,
        adapters: activeAdapters,
        validationAttempts,
        ruleResults: [],
        lookupCandidates,
        persistActions,
        prompts: {
          planner: plannerPrompt,
          builder: "",
          reviewer: "",
        },
        leadPlan,
        challengerCritique: critique,
        finalSynthesis,
        rawFinalSynthesis: JSON.stringify(finalSynthesis, null, 2),
      };

      publishCheckpoint(buildCheckpoint({
        stage: "planning",
        status: "completed",
        summary: "Cateo could not verify the manufacturing part number with enough confidence and is requesting clarification.",
        taskClass: route.taskClass,
        confidence: clarificationConfidence,
        artifactTypes: route.requestedArtifacts,
      }));

      saveCaseRecord({
        caseId: context.caseId,
        runId,
        createdAt: nowIso,
        updatedAt: nowIso,
        input: sanitizedInput,
        context,
        artifacts: [],
        interaction,
        requester,
        conversationId: requester?.conversationId,
        userId: requester?.userId,
        usage,
        trace,
      });

      publishCheckpoint(buildCheckpoint({
        stage: "completed",
        status: "completed",
        summary: "Cateo is waiting for a clarifying part-number response before generating controlled artifacts.",
        taskClass: route.taskClass,
        confidence: clarificationConfidence,
        artifactTypes: route.requestedArtifacts,
        artifactCount: 0,
      }));

      if (config.security.persistence.persistDatasets) {
        appendCateoInteraction({
          schemaVersion: "1.0",
          kind: "cateo_interaction",
          timestamp: Date.now(),
          caseId: context.caseId,
          runId,
          profileId: requester?.profileId,
          requesterId: requester?.requesterId,
          userId: requester?.userId,
          conversationId: requester?.conversationId,
          organization: requester?.organization,
          emailHash: requester?.emailHash,
          taskClass: route.taskClass,
          assetId: context.asset?.assetId,
          workOrderId: context.workOrder?.workOrderId,
          prompt: sanitizedInput.symptomDescription,
          errorCode: sanitizedInput.errorCode,
          observedConditions: context.observedConditions,
          attachmentCount: context.attachments.length,
          requestedArtifacts: route.requestedArtifacts,
          activeSkillIds: activeSkills.map((skill) => skill.id),
          activeAdapterIds: activeAdapters.map((adapter) => adapter.id),
          capabilityTags: route.capabilityTags,
          artifactTypes: [],
          interactionMessage: interaction.message,
          highlights: interaction.highlights,
          nextActions: interaction.nextActions,
          confidence: interaction.confidence,
          contextSummary: context.contextSummary,
          checkpoints: checkpoints.map((checkpoint) => ({
            stage: checkpoint.stage,
            status: checkpoint.status,
            summary: checkpoint.summary,
          })),
          modelsUsed: [],
          usage,
          executiveSummary: finalSynthesis.executiveSummary,
          rootCauseStatement: finalSynthesis.rootCauseStatement,
          reviewerSummary: "Clarification required before artifact generation.",
        });
      }

      return {
        caseId: context.caseId,
        runId,
        summary: interaction.message,
        interaction,
        checkpoints,
        context,
        requester,
        usage,
        trace,
        artifacts: [],
      };
    }

    const leadStage = await callJsonStage({
      stage: "planner",
      llm: runtime.lead,
      modelInfo: runtime.meta.lead,
      systemPrompt: "Return a compact JSON object for Cateo planning. No prose outside JSON.",
      userPrompt: plannerPrompt,
      fallback: fallbackLeadPlan(route, context, sanitizedInput),
      timeoutMs: CATEO_STAGE_BUDGET_MS.planner,
      maxTokens: CATEO_STAGE_MAX_TOKENS.planner,
      requestId: options.requestId,
    });

    stageUsages.push({
      stage: "planner",
      role: "lead",
      model: leadStage.modelInfo,
      inputTokens: leadStage.usage.inputTokens,
      outputTokens: leadStage.usage.outputTokens,
      totalTokens: leadStage.usage.inputTokens + leadStage.usage.outputTokens,
    });

    const leadFallback = fallbackLeadPlan(route, context, sanitizedInput);
    const leadRecord = leadStage.data as Partial<CateoLeadPlan>;
    const leadPlan: CateoLeadPlan = {
      taskClass: route.taskClass,
      objective: coerceString(leadRecord.objective, leadFallback.objective),
      evidencePlan: coerceStringArray(leadRecord.evidencePlan).length > 0 ? coerceStringArray(leadRecord.evidencePlan) : leadFallback.evidencePlan,
      assumptions: coerceStringArray(leadRecord.assumptions).length > 0 ? coerceStringArray(leadRecord.assumptions) : leadFallback.assumptions,
      risks: coerceStringArray(leadRecord.risks).length > 0 ? coerceStringArray(leadRecord.risks) : leadFallback.risks,
      decisionBasis: coerceStringArray(leadRecord.decisionBasis).length > 0 ? coerceStringArray(leadRecord.decisionBasis) : leadFallback.decisionBasis,
      artifactPriorities: route.requestedArtifacts,
      maintenanceConsiderations: coerceStringArray(leadRecord.maintenanceConsiderations).length > 0 ? coerceStringArray(leadRecord.maintenanceConsiderations) : leadFallback.maintenanceConsiderations,
      partsConsiderations: coerceStringArray(leadRecord.partsConsiderations).length > 0 ? coerceStringArray(leadRecord.partsConsiderations) : leadFallback.partsConsiderations,
    };

    publishCheckpoint(buildCheckpoint({
      stage: "planning",
      status: "completed",
      summary: `Planner classified this request as ${leadPlan.taskClass} and mapped ${route.requestedArtifacts.length} artifact(s): ${route.requestedArtifacts.join(", ")}.`,
      taskClass: leadPlan.taskClass,
      artifactTypes: route.requestedArtifacts,
    }));
    publishCheckpoint(buildCheckpoint({
      stage: "building",
      status: "running",
      summary: "Builder is converting the plan into schema-governed Cateo artifacts.",
      taskClass: route.taskClass,
      artifactTypes: route.requestedArtifacts,
    }));

    const builderPrompt = [
      "You are Cateo's builder model for structured engineering artifacts.",
      "Return JSON only.",
      "Obey the instruction template and produce schema-ready artifacts. Invalid or incomplete drafts will be rejected and retried.",
      "When verified source findings, expected values, document references, or hazard labels are present, weave them into the procedure, warnings, and verification steps instead of producing generic advice.",
      "Instruction template:",
      templatePayload,
      "Request and context payload:",
      promptPayload,
      "Lead plan:",
      JSON.stringify(leadPlan, null, 2),
    ].join("\n\n");

    let builderRawStage = await callJsonStage<RawBuilderOutput>({
      stage: "builder",
      llm: runtime.structure!,
      modelInfo: runtime.meta.structure!,
      systemPrompt: "Return a compact JSON object with keys packageSummary, artifactPlans, and artifactDrafts. artifactPlans entries must include artifactType, title, sectionOrder, qualityGates, and requiredEvidence. artifactDrafts entries must include artifactType, title, and content. Use grounded source details when present; do not invent source-backed values. No prose outside JSON.",
      userPrompt: builderPrompt,
      fallback: {
        packageSummary: `Structured Cateo package with ${route.requestedArtifacts.length} artifact(s).`,
        artifactPlans: fallbackStructure(route, context).artifactPlans,
        artifactDrafts: [],
      },
      timeoutMs: CATEO_STAGE_BUDGET_MS.builder,
      maxTokens: CATEO_STAGE_MAX_TOKENS.builder,
      requestId: options.requestId,
    });

    stageUsages.push({
      stage: "builder",
      role: "structure",
      model: builderRawStage.modelInfo,
      inputTokens: builderRawStage.usage.inputTokens,
      outputTokens: builderRawStage.usage.outputTokens,
      totalTokens: builderRawStage.usage.inputTokens + builderRawStage.usage.outputTokens,
    });

    const provisionalCritique = fallbackCritique(context);
    const provisionalFinalSynthesis = fallbackFinal(route, context, leadPlan, provisionalCritique);
    let structureBlueprint = normalizeStructureBlueprint(builderRawStage.data, route, context);
    let builderPackage = normalizeBuilderPackage({
      raw: builderRawStage.data,
      route,
      input: sanitizedInput,
      context,
      leadPlan,
      critique: provisionalCritique,
      blueprint: structureBlueprint,
      finalSynthesis: provisionalFinalSynthesis,
    });
    let builderRawTrace = builderRawStage.raw ?? "";
    let builderValidationErrors = collectBuilderValidationErrors(builderPackage);

    if (builderValidationErrors.length === 0) {
      validationAttempts.push({
        stage: "builder",
        attempt: 1,
        outcome: "success",
        errors: [],
      });
    } else {
      validationAttempts.push({
        stage: "builder",
        attempt: 1,
        outcome: "retry",
        errors: builderValidationErrors,
      });
      appendAuditEvent({
        actor: "runtime",
        category: "cateo_validation",
        action: "builder_retry",
        outcome: "retry",
        severity: "warn",
        message: `Builder validation failed on the first pass and is being retried for ${builderValidationErrors.length} issue(s).`,
        requestId: options.requestId,
        metadata: {
          artifactTypes: route.requestedArtifacts,
          errors: builderValidationErrors,
        },
      });

      const builderRetryPrompt = [
        builderPrompt,
        "Previous validation errors:",
        JSON.stringify(builderValidationErrors, null, 2),
        "Return corrected JSON only. Do not omit required artifacts.",
      ].join("\n\n");

      const builderRetryStage = await callJsonStage<RawBuilderOutput>({
        stage: "builder",
        llm: runtime.structure!,
        modelInfo: runtime.meta.structure!,
        systemPrompt: "Return a compact JSON object with keys packageSummary, artifactPlans, and artifactDrafts. artifactPlans entries must include artifactType, title, sectionOrder, qualityGates, and requiredEvidence. artifactDrafts entries must include artifactType, title, and content. Use grounded source details when present; do not invent source-backed values. No prose outside JSON.",
        userPrompt: builderRetryPrompt,
        fallback: {
          packageSummary: `Structured Cateo package with ${route.requestedArtifacts.length} artifact(s).`,
          artifactPlans: fallbackStructure(route, context).artifactPlans,
          artifactDrafts: [],
        },
        timeoutMs: CATEO_STAGE_BUDGET_MS.builder,
        maxTokens: CATEO_STAGE_MAX_TOKENS.builder,
        requestId: options.requestId,
      });

      stageUsages.push({
        stage: "builder",
        role: "structure",
        model: builderRetryStage.modelInfo,
        inputTokens: builderRetryStage.usage.inputTokens,
        outputTokens: builderRetryStage.usage.outputTokens,
        totalTokens: builderRetryStage.usage.inputTokens + builderRetryStage.usage.outputTokens,
      });

      builderRawStage = builderRetryStage;
      builderRawTrace = [builderRawTrace, builderRetryStage.raw].filter(Boolean).join("\n\n--- builder retry ---\n\n");
      structureBlueprint = normalizeStructureBlueprint(builderRetryStage.data, route, context);
      builderPackage = normalizeBuilderPackage({
        raw: builderRetryStage.data,
        route,
        input: sanitizedInput,
        context,
        leadPlan,
        critique: provisionalCritique,
        blueprint: structureBlueprint,
        finalSynthesis: provisionalFinalSynthesis,
      });
      builderValidationErrors = collectBuilderValidationErrors(builderPackage);

      validationAttempts.push({
        stage: "builder",
        attempt: 2,
        outcome: builderValidationErrors.length === 0 ? "success" : "fallback",
        errors: builderValidationErrors,
      });

      appendAuditEvent({
        actor: "runtime",
        category: "cateo_validation",
        action: builderValidationErrors.length === 0 ? "builder_recovered" : "builder_fallback",
        outcome: builderValidationErrors.length === 0 ? "success" : "fallback",
        severity: builderValidationErrors.length === 0 ? "info" : "warn",
        message: builderValidationErrors.length === 0
          ? "Builder retry returned a schema-valid artifact package."
          : "Builder retry still failed schema validation; deterministic artifact generation will remain in effect.",
        requestId: options.requestId,
        metadata: {
          artifactTypes: route.requestedArtifacts,
          errors: builderValidationErrors,
        },
      });
    }

    publishCheckpoint(buildCheckpoint({
      stage: "building",
      status: "completed",
      summary: `Builder drafted ${builderPackage.artifactDrafts.length} artifact(s) for review: ${builderPackage.artifactDrafts.map((draft) => draft.artifactType).join(", ")}.`,
      taskClass: route.taskClass,
      artifactTypes: builderPackage.artifactDrafts.map((draft) => draft.artifactType),
      artifactCount: builderPackage.artifactDrafts.length,
    }));
    publishCheckpoint(buildCheckpoint({
      stage: "reviewing",
      status: "running",
      summary: "Reviewer is checking technical accuracy, completeness, and compliance before release.",
      taskClass: route.taskClass,
      artifactTypes: builderPackage.artifactDrafts.map((draft) => draft.artifactType),
      artifactCount: builderPackage.artifactDrafts.length,
    }));

    const reviewerPrompt = [
      "You are Cateo's reviewer model for technical accuracy, completeness, and compliance.",
      "Return JSON only.",
      "Evaluate blind spots, unsupported claims, measurable criteria, and whether the package should remain draft or advance to reviewed.",
      "Explicitly check whether verified source findings, expected values, reference documents, and hazard labels were actually used where relevant.",
      "Instruction template:",
      templatePayload,
      "Request and context payload:",
      promptPayload,
      "Lead plan:",
      JSON.stringify(leadPlan, null, 2),
      "Builder package:",
      JSON.stringify(builderPackage, null, 2),
      "Validation attempts:",
      JSON.stringify(validationAttempts, null, 2),
    ].join("\n\n");

    const reviewerStage = await callJsonStage<ReviewerStageOutput>({
      stage: "reviewer",
      llm: runtime.challenger!,
      modelInfo: runtime.meta.challenger!,
      systemPrompt: "Return a compact JSON object with keys alternateHypotheses, blindSpots, missingAssumptions, evidenceGaps, recommendedAdjustments, and reviewDecision. reviewDecision must include overallStatus, technicalAccuracy, completeness, compliance, findings, approvedArtifactTypes, approvalState, confidence, summary, and requiredFollowUp. Flag drafts that ignored grounded source evidence or omitted supported hazards/expected values. No prose outside JSON.",
      userPrompt: reviewerPrompt,
      fallback: {
        ...provisionalCritique,
        reviewDecision: fallbackReviewerDecision(builderPackage, route, provisionalCritique),
      },
      timeoutMs: CATEO_STAGE_BUDGET_MS.reviewer,
      maxTokens: CATEO_STAGE_MAX_TOKENS.reviewer,
      requestId: options.requestId,
    });

    stageUsages.push({
      stage: "reviewer",
      role: "challenger",
      model: reviewerStage.modelInfo,
      inputTokens: reviewerStage.usage.inputTokens,
      outputTokens: reviewerStage.usage.outputTokens,
      totalTokens: reviewerStage.usage.inputTokens + reviewerStage.usage.outputTokens,
    });

    const critique = normalizeReviewerCritique(reviewerStage.data, context);
    const baseFinalSynthesis = fallbackFinal(route, context, leadPlan, critique);
    const reviewerDecisionBase = normalizeReviewerDecision(reviewerStage.data.reviewDecision, builderPackage, route, critique);
    const ruleResults = evaluateArtifactPackageRules({
      template,
      context,
      builderPackage,
      reviewerDecision: reviewerDecisionBase,
      finalSynthesis: baseFinalSynthesis,
    });
    const ruleSummary = summarizeRuleOutcomes(ruleResults);
    const ruleMessages = ruleResults.filter((entry) => entry.outcome !== "pass").map((entry) => `${entry.ruleId}: ${entry.message}`);
    const escalatedByRules = ruleResults.some((entry) => entry.outcome === "escalate");
    const requiresEngineerReview = Boolean(requester?.requiresEngineerReview || sanitizedInput.workflow?.mode === "reviewed-document");

    validationAttempts.push({
      stage: "reviewer",
      attempt: 1,
      outcome: escalatedByRules ? "fallback" : "success",
      errors: ruleMessages,
    });

    appendAuditEvent({
      actor: "runtime",
      category: "cateo_rules",
      action: "evaluate",
      outcome: escalatedByRules ? "escalated" : ruleSummary.flagged > 0 ? "flagged" : "pass",
      severity: escalatedByRules ? "warn" : "info",
      message: escalatedByRules
        ? "Cateo rule evaluation escalated the package for additional review."
        : ruleSummary.flagged > 0
          ? "Cateo rule evaluation flagged follow-up items."
          : "Cateo rule evaluation passed.",
      requestId: options.requestId,
      metadata: {
        templateId: template.templateId,
        templateVersion: template.version,
        flagged: ruleSummary.flagged,
        escalated: ruleSummary.escalated,
        failedValidation: ruleSummary.failedValidation,
        messages: ruleMessages,
      },
    });

    const reviewerDecision: CateoReviewerDecision = {
      ...reviewerDecisionBase,
      overallStatus: escalatedByRules ? "needs-revision" : reviewerDecisionBase.overallStatus,
      approvalState: escalatedByRules || requiresEngineerReview ? "draft" : reviewerDecisionBase.approvalState,
      approvedArtifactTypes: escalatedByRules || requiresEngineerReview ? [] : reviewerDecisionBase.approvedArtifactTypes,
      findings: uniqueStrings([
        ...reviewerDecisionBase.findings,
        ...ruleMessages,
        requiresEngineerReview ? "Customer tier requires manual engineer validation before artifact release." : undefined,
      ]),
      requiredFollowUp: uniqueStrings([
        ...reviewerDecisionBase.requiredFollowUp,
        ...ruleResults.filter((entry) => entry.outcome !== "pass").map((entry) => entry.message),
        requiresEngineerReview ? "Engineer sign-off is required before releasing this artifact package to the customer profile." : undefined,
      ]),
      summary: escalatedByRules
        ? "Reviewer and rules engine held the package in draft pending additional engineering follow-up."
        : requiresEngineerReview
          ? "Cateo prepared the package and queued it for manual engineer validation before release."
          : reviewerDecisionBase.summary,
    };

    const finalSynthesis: CateoFinalSynthesis = {
      ...baseFinalSynthesis,
      decision: reviewerDecision.approvalState,
      confidence: reviewerDecision.confidence,
      operatorNotes: uniqueStrings([
        ...baseFinalSynthesis.operatorNotes,
        reviewerDecision.summary,
        ...reviewerDecision.findings,
      ]),
      nextActions: uniqueStrings([
        ...baseFinalSynthesis.nextActions,
        ...reviewerDecision.requiredFollowUp,
      ]),
    };

    publishCheckpoint(buildCheckpoint({
      stage: "reviewing",
      status: "completed",
      summary: reviewerDecision.approvalState === "draft"
        ? escalatedByRules
          ? "Reviewer and rules engine kept the package in draft and recorded required follow-up controls."
          : "Reviewer held the package in draft and requested follow-up before controlled release."
        : `Reviewer validated ${builderPackage.artifactDrafts.length} artifact(s) for conversational rendering with ${reviewerDecision.confidence} confidence.`,
      taskClass: route.taskClass,
      confidence: reviewerDecision.confidence,
      artifactTypes: builderPackage.artifactDrafts.map((draft) => draft.artifactType),
      artifactCount: builderPackage.artifactDrafts.length,
    }));
    publishCheckpoint(buildCheckpoint({
      stage: "persisting",
      status: "running",
      summary: "Cateo is versioning the artifact package, provenance, and audit trace.",
      taskClass: route.taskClass,
      confidence: reviewerDecision.confidence,
      artifactTypes: builderPackage.artifactDrafts.map((draft) => draft.artifactType),
      artifactCount: builderPackage.artifactDrafts.length,
    }));

    const runId = crypto.randomUUID();
    const modelsUsed = [runtime.meta.lead, runtime.meta.structure!, runtime.meta.challenger!];
    const evidenceFingerprint = fingerprintEvidence({
      input: sanitizedInput,
      context,
      route,
      template,
      builderPackage,
      reviewerDecision,
      finalSynthesis,
    });
    const promptFingerprint = fingerprintEvidence({ title: sanitizedInput.title, query: sanitizedInput.query, errorCode: sanitizedInput.errorCode, symptomDescription: sanitizedInput.symptomDescription, observedConditions: sanitizedInput.observedConditions, instructionTemplate: sanitizedInput.instructionTemplate });
    const usage = buildUsageSummary(stageUsages);

    const artifacts = builderPackage.artifactDrafts.map((draft) => {
      const createdAt = new Date().toISOString();
      const validationErrors = validateArtifactContent(draft.artifactType, draft.content);
      if (validationErrors.length > 0) {
        throw new Error(`Generated ${draft.artifactType} failed schema validation: ${validationErrors.join("; ")}`);
      }

      const provenance = buildProvenance({
        runId,
        requestId: options.requestId,
        createdAt,
        actor,
        taskClass: context.taskClass,
        modelsUsed,
        evidenceFingerprint,
        profileId: requester?.profileId,
        userId: requester?.userId,
        conversationId: requester?.conversationId,
        messageId: requester?.messageId,
        templateId: template.templateId,
        templateVersion: template.version,
        promptFingerprint,
      });
      const summary = summarizeArtifactContent(draft.artifactType, draft.content);
      const metadata: CateoArtifactEnterpriseMetadata = buildArtifactEnterpriseMetadata({
        artifactType: draft.artifactType,
        content: draft.content,
        summary,
        context,
        reviewerDecision,
        finalSynthesis,
        template,
        requester,
        runId,
        caseId: context.caseId,
        evidenceFingerprint,
        promptFingerprint,
        requestId: options.requestId,
        activeSkills,
        adapters: activeAdapters,
        validationStatus: draft.generationMode === "deterministic-fallback" ? "fallback" : "validated",
        retryCount: validationAttempts.filter((attempt) => attempt.outcome === "retry").length,
        ruleResults,
        marketplace: {
          source: "cateo-public",
          toolScope: [],
          toolCalls: [],
        },
      });
      const approvalState = reviewerDecision.approvedArtifactTypes.includes(draft.artifactType) ? reviewerDecision.approvalState : "draft";
      const lookupText = [
        sanitizedInput.symptomDescription,
        sanitizedInput.errorCode,
        context.failureCode?.code,
        context.failureCode?.label,
        summary,
        reviewerDecision.summary,
        ...context.contextSummary,
      ].filter(Boolean).join("\n");

      const matches = findSimilarArtifacts({
        text: lookupText,
        artifactType: draft.artifactType,
        assetId: context.asset?.assetId,
        workOrderId: context.workOrder?.workOrderId,
        partNumber: context.partResolution?.partNumber,
        limit: 3,
      }).map((match) => ({
        artifactId: match.artifactId,
        artifactType: match.artifactType as CateoArtifactType,
        caseId: match.caseId,
        assetId: match.assetId,
        workOrderId: match.workOrderId,
        score: match.score,
        basis: match.basis,
        revisionNumber: match.revisionNumber,
        approvalState: match.approvalState === "approved" || match.approvalState === "reviewed" || match.approvalState === "draft"
          ? match.approvalState
          : "draft",
        updatedAt: match.updatedAt,
      } satisfies CateoArtifactLookupCandidate));
      lookupCandidates.push(...matches);

      appendAuditEvent({
        actor: "runtime",
        category: "cateo_lookup",
        action: "search",
        outcome: matches.length > 0 ? "matched" : "none",
        message: `Cateo searched for existing ${draft.artifactType} artifacts before persistence.`,
        requestId: options.requestId,
        metadata: {
          artifactType: draft.artifactType,
          assetId: context.asset?.assetId,
          workOrderId: context.workOrder?.workOrderId,
          matches: matches.map((entry) => ({ artifactId: entry.artifactId, score: entry.score, basis: entry.basis })),
        },
      });

      const bestMatch = matches[0];
      if (shouldMergeArtifact(bestMatch)) {
        const existing = loadArtifactRecord(bestMatch.artifactId);
        if (existing) {
          const current = existing.revisions[existing.revisions.length - 1];
          const mergedCandidate = mergeContentPatch(current.content as unknown as Record<string, unknown>, draft.content as unknown as Record<string, unknown>) as unknown as CateoArtifactContent;
          const mergedErrors = validateArtifactContent(draft.artifactType, mergedCandidate);
          const nextContent = mergedErrors.length === 0 ? mergedCandidate : draft.content;
          const updated = createRevision({
            record: existing,
            createdBy: actor,
            summary: `Merged validated ${draft.artifactType} output from case ${context.caseId}`,
            approvalState,
            content: nextContent,
            note: `Matched existing artifact ${bestMatch.artifactId} at score ${bestMatch.score.toFixed(2)} via ${bestMatch.basis.join(", ")}${mergedErrors.length > 0 ? "; merged content failed schema validation so Cateo stored the validated replacement draft instead." : ""}`,
            signoffs: [],
            provenance,
            metadata,
          });

          persistActions.push({
            artifactType: draft.artifactType,
            action: "merged",
            artifactId: updated.artifactId,
            revisionNumber: updated.revisions.length,
            matchedArtifactId: bestMatch.artifactId,
            matchScore: bestMatch.score,
          });

          appendAuditEvent({
            actor: "runtime",
            category: "cateo_artifact",
            action: "merge",
            outcome: "success",
            message: `Merged ${draft.artifactType} into artifact ${updated.artifactId}`,
            requestId: options.requestId,
            metadata: {
              caseId: context.caseId,
              assetId: context.asset?.assetId,
              workOrderId: context.workOrder?.workOrderId,
              generationMode: draft.generationMode,
              profileId: requester?.profileId,
              matchedArtifactId: bestMatch.artifactId,
              matchScore: bestMatch.score,
              matchBasis: bestMatch.basis,
              mergeMode: mergedErrors.length > 0 ? "replacement" : "merged_patch",
            },
          });

          return updated;
        }
      }

      const artifactId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      const record = saveArtifactRecord({
        artifactId,
        artifactType: draft.artifactType,
        schema: getSchemaRef(draft.artifactType),
        caseId: context.caseId,
        assetId: context.asset?.assetId,
        workOrderId: context.workOrder?.workOrderId,
        linkedConversationIds: requester?.conversationId ? [requester.conversationId] : [],
        currentRevisionId: revisionId,
        createdAt,
        updatedAt: createdAt,
        revisions: [{
          revisionId,
          revisionNumber: 1,
          approvalState,
          createdAt,
          createdBy: actor,
          summary,
          diffFromPrevious: [],
          signoffs: [],
          provenance,
          metadata,
          content: draft.content,
        }],
      });

      persistActions.push({
        artifactType: draft.artifactType,
        action: "created",
        artifactId: record.artifactId,
        revisionNumber: 1,
      });

      appendAuditEvent({
        actor: "runtime",
        category: "cateo_artifact",
        action: "create",
        outcome: "success",
        message: `Created ${draft.artifactType} artifact ${artifactId}`,
        requestId: options.requestId,
        metadata: {
          caseId: context.caseId,
          assetId: context.asset?.assetId,
          workOrderId: context.workOrder?.workOrderId,
          generationMode: draft.generationMode,
          profileId: requester?.profileId,
        },
      });

      return record;
    });

  publishCheckpoint(buildCheckpoint({
    stage: "persisting",
    status: "completed",
    summary: `Cateo saved ${artifacts.length} versioned artifact(s) as the system of record.`,
    taskClass: route.taskClass,
    confidence: reviewerDecision.confidence,
    artifactTypes: artifacts.map((artifact) => artifact.artifactType),
    artifactCount: artifacts.length,
  }));
  publishCheckpoint(buildCheckpoint({
    stage: "rendering",
    status: "running",
    summary: "Renderer is projecting the controlled artifact package into the chat response.",
    taskClass: route.taskClass,
    confidence: reviewerDecision.confidence,
    artifactTypes: artifacts.map((artifact) => artifact.artifactType),
    artifactCount: artifacts.length,
  }));

    const interaction = renderCateoInteraction(artifacts, { detailLevel: sanitizedInput.responseDetail });
    if (requiresEngineerReview) {
      interaction.releaseStatus = "pending-engineer-review";
      interaction.requiresEngineerReview = true;
      interaction.message = `${interaction.message}\n\nThis customer tier includes manual engineer validation. Cateo created the artifact package and queued it for sign-off before release to the profile and download catalog.`;
      interaction.nextActions = uniqueStrings([
        ...interaction.nextActions,
        "Wait for manual engineer validation before downloading the final artifact package.",
      ]);
    }
    const trace = {
      route,
      template,
      partResolution,
      activeSkills,
      adapters: activeAdapters,
      validationAttempts,
      ruleResults,
      lookupCandidates,
      persistActions,
      prompts: {
        planner: plannerPrompt,
        builder: builderPrompt,
        reviewer: reviewerPrompt,
      },
      leadPlan,
      challengerCritique: critique,
      structureBlueprint,
      builderPackage,
      reviewerDecision,
      finalSynthesis,
      rawLeadPlan: leadStage.raw,
      rawChallengerCritique: reviewerStage.raw,
      rawStructureBlueprint: builderRawTrace,
      rawBuilderPackage: builderRawTrace,
      rawReviewerDecision: reviewerStage.raw,
      rawFinalSynthesis: JSON.stringify(finalSynthesis, null, 2),
    };

    publishCheckpoint(buildCheckpoint({
      stage: "rendering",
      status: "completed",
      summary: "Renderer prepared the conversational response from the artifact package.",
      taskClass: route.taskClass,
      confidence: interaction.confidence,
      artifactTypes: artifacts.map((artifact) => artifact.artifactType),
      artifactCount: artifacts.length,
    }));

    const artifactIds = [...new Set(artifacts.map((artifact) => artifact.artifactId))];
    const caseRecord: CateoCaseRecord = {
      caseId: context.caseId,
      runId,
      createdAt: nowIso,
      updatedAt: nowIso,
      input: sanitizedInput,
      context,
      artifacts: artifactIds,
      interaction,
      requester,
      conversationId: requester?.conversationId,
      userId: requester?.userId,
      usage,
      trace,
    };

    ensureCaseReviewWorkflow(caseRecord, artifacts);

    try {
      const reportPackage = persistTroubleshootingReportPackage(caseRecord, artifacts);
      syncCaseReviewPackageFiles(caseRecord, reportPackage.documentControl.files);
    } catch (reportError) {
      appendAuditEvent({
        actor: "runtime",
        category: "cateo_report_package",
        action: "persist",
        outcome: "warn",
        severity: "warn",
        message: `Failed to persist troubleshooting report package for case ${context.caseId}`,
        requestId: options.requestId,
        metadata: { error: reportError instanceof Error ? reportError.message : String(reportError) },
      });
    }

    saveCaseRecord(caseRecord);

    publishCheckpoint(buildCheckpoint({
      stage: "completed",
      status: "completed",
      summary: requiresEngineerReview ? "Cateo generated a provisional response and queued engineer review." : "Cateo response is ready.",
      taskClass: route.taskClass,
      confidence: interaction.confidence,
      artifactTypes: artifacts.map((artifact) => artifact.artifactType),
      artifactCount: artifacts.length,
    }));

    if (config.security.persistence.persistDatasets) {
      appendCateoInteraction({
        schemaVersion: "1.0",
        kind: "cateo_interaction",
        timestamp: Date.now(),
        caseId: context.caseId,
        runId,
        profileId: requester?.profileId,
        requesterId: requester?.requesterId,
        userId: requester?.userId,
        conversationId: requester?.conversationId,
        organization: requester?.organization,
        emailHash: requester?.emailHash,
        taskClass: route.taskClass,
        assetId: context.asset?.assetId,
        workOrderId: context.workOrder?.workOrderId,
        prompt: sanitizedInput.symptomDescription,
        errorCode: sanitizedInput.errorCode,
        observedConditions: context.observedConditions,
        attachmentCount: context.attachments.length,
        requestedArtifacts: route.requestedArtifacts,
        activeSkillIds: activeSkills.map((skill) => skill.id),
        activeAdapterIds: activeAdapters.map((adapter) => adapter.id),
        capabilityTags: route.capabilityTags,
        artifactTypes: artifacts.map((artifact) => artifact.artifactType),
        interactionMessage: interaction.message,
        highlights: interaction.highlights,
        nextActions: interaction.nextActions,
        confidence: interaction.confidence,
        contextSummary: context.contextSummary,
        checkpoints: checkpoints.map((checkpoint) => ({
          stage: checkpoint.stage,
          status: checkpoint.status,
          summary: checkpoint.summary,
        })),
        modelsUsed,
        usage,
        executiveSummary: finalSynthesis.executiveSummary,
        rootCauseStatement: finalSynthesis.rootCauseStatement,
        reviewerSummary: reviewerDecision.summary,
      });
    }

    return {
    caseId: context.caseId,
    runId,
    summary: interaction.message,
    interaction,
    checkpoints,
    context,
    requester,
    usage,
    trace,
    artifacts,
  };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const promptFingerprint = fingerprintEvidence({ title: sanitizedInput.title, query: sanitizedInput.query, errorCode: sanitizedInput.errorCode, symptomDescription: sanitizedInput.symptomDescription, observedConditions: sanitizedInput.observedConditions, instructionTemplate: sanitizedInput.instructionTemplate });
    const usage = buildUsageSummary(stageUsages);
    const lastCheckpoint = checkpoints[checkpoints.length - 1];
    if (lastCheckpoint?.stage !== "failed") {
      publishCheckpoint(buildCheckpoint({
        stage: "failed",
        status: "failed",
        summary: `Cateo could not complete the request: ${message}`,
        taskClass: route.taskClass,
        artifactTypes: route.requestedArtifacts,
      }));
    }
    if (error instanceof CateoExecutionError) {
      throw error;
    }
    throw new CateoExecutionError(message, usage);
  }
}

export function reviseCateoArtifact(request: CateoRevisionRequest, options: ServiceOptions = {}): CateoArtifactRecord {
  const record = loadArtifactRecord(request.artifactId);
  if (!record) {
    throw new Error(`Artifact not found: ${request.artifactId}`);
  }

  const current = record.revisions[record.revisions.length - 1];
  const nextContent = request.fullContent ?? (request.contentPatch ? mergeContentPatch(current.content, request.contentPatch) : current.content);
  const validationErrors = validateArtifactContent(record.artifactType, nextContent);
  if (validationErrors.length > 0) {
    throw new Error(`Artifact revision failed schema validation: ${validationErrors.join("; ")}`);
  }

  const updated = createRevision({
    record,
    createdBy: request.editor,
    summary: request.note?.trim() || `Revision ${record.revisions.length + 1} created by ${request.editor}`,
    approvalState: "draft",
    content: nextContent,
    note: request.note,
    signoffs: [],
    provenance: buildProvenance({
      runId: current.provenance.runId,
      requestId: options.requestId,
      createdAt: new Date().toISOString(),
      actor: request.editor,
      taskClass: current.provenance.taskClass,
      modelsUsed: current.provenance.modelsUsed,
      evidenceFingerprint: fingerprintEvidence(nextContent),
    }),
  });

  appendAuditEvent({ actor: "operator", category: "cateo_artifact", action: "revise", outcome: "success", message: `Revised artifact ${request.artifactId}`, requestId: options.requestId, metadata: { revisionNumber: updated.revisions.length, editor: request.editor } });
  return updated;
}

export function signOffCateoArtifact(request: CateoSignoffRequest, options: ServiceOptions = {}): CateoArtifactRecord {
  const record = loadArtifactRecord(request.artifactId);
  if (!record) {
    throw new Error(`Artifact not found: ${request.artifactId}`);
  }

  const current = record.revisions[record.revisions.length - 1];
  const signoff: CateoElectronicSignoff = {
    actor: request.actor,
    role: request.role,
    meaning: request.meaning,
    state: request.state,
    signedAt: new Date().toISOString(),
  };

  const updated = createRevision({
    record,
    createdBy: request.actor,
    summary: request.note?.trim() || `${request.state} sign-off recorded by ${request.actor}`,
    approvalState: request.state,
    content: current.content,
    note: request.note,
    signoffs: [...current.signoffs, signoff],
    provenance: buildProvenance({
      runId: current.provenance.runId,
      requestId: options.requestId,
      createdAt: signoff.signedAt,
      actor: request.actor,
      taskClass: current.provenance.taskClass,
      modelsUsed: current.provenance.modelsUsed,
      evidenceFingerprint: current.provenance.evidenceFingerprint,
    }),
  });

  appendAuditEvent({ actor: "operator", category: "cateo_artifact", action: "signoff", outcome: "success", message: `${request.state} sign-off recorded for artifact ${request.artifactId}`, requestId: options.requestId, metadata: { actor: request.actor, role: request.role, state: request.state } });
  return updated;
}



















