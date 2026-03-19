import crypto from "node:crypto";
import type { CashClawConfig } from "../config.js";
import type { CateoModelRuntime, CateoRuntimeModelInfo } from "../llm/runtime.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import { appendAuditEvent } from "../security/audit.js";
import { buildCateoContext, inferRequestedArtifacts } from "./context.js";
import { getSchemaRef, validateArtifactContent } from "./schemas.js";
import { createRevision, fingerprintEvidence, loadArtifactRecord, mergeContentPatch, saveArtifactRecord, saveCaseRecord } from "./store.js";
import { ingestMediaAttachments, sanitizeAssistInputForPersistence } from "./media_adapter.js";
import type {
  CateoArtifactContent,
  CateoArtifactRecord,
  CateoArtifactType,
  CateoAssistInput,
  CateoAssistResult,
  CateoChallengerCritique,
  CateoConfidence,
  CateoContextBundle,
  CateoDiagnosticReasoningLog,
  CateoElectronicSignoff,
  CateoFinalSynthesis,
  CateoInspectionChecklist,
  CateoLeadPlan,
  CateoPartCatalogEntry,
  CateoPartsToolsList,
  CateoRevisionRequest,
  CateoRoutingDecision,
  CateoServiceReport,
  CateoSignoffRequest,
  CateoStructureBlueprint,
  CateoTaskClass,
  CateoTroubleshootingProcedure,
} from "./types.js";

interface StageResult<T> {
  data: T;
  raw?: string;
  modelInfo: CateoRuntimeModelInfo;
}

interface ServiceOptions {
  actor?: string;
  requestId?: string;
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((block): block is Extract<LLMResponse["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function assertLocalCateoRuntime(runtime: CateoModelRuntime): void {
  if (!runtime.meta.orchestrationEnabled) {
    throw new Error("Cateo local orchestration is disabled. Enable the local three-model runtime before serving regulated artifacts.");
  }
  if (runtime.meta.lead.provider !== "ollama") {
    throw new Error("Cateo artifact generation requires a local Ollama lead model.");
  }
  if (runtime.meta.challenger && runtime.meta.challenger.provider !== "ollama") {
    throw new Error("Cateo artifact generation requires a local Ollama challenger model.");
  }
  if (runtime.meta.structure && runtime.meta.structure.provider !== "ollama") {
    throw new Error("Cateo artifact generation requires a local Ollama structure model.");
  }
}

function buildRoute(input: CateoAssistInput, context: CateoContextBundle): CateoRoutingDecision {
  const requestedArtifacts = inferRequestedArtifacts(input, context.taskClass);
  const useChallenger = context.taskClass === "troubleshooting"
    || context.taskClass === "root-cause-analysis"
    || requestedArtifacts.includes("diagnostic-reasoning-log")
    || context.serviceHistory.length >= 2
    || context.digitalTwin?.status === "fail";
  const useStructure = requestedArtifacts.length > 1
    || context.taskClass === "inspection"
    || context.taskClass === "documentation";

  return {
    taskClass: context.taskClass,
    requestedArtifacts,
    useChallenger,
    useStructure,
    reasons: uniqueStrings([
      `Task class inferred as ${context.taskClass}.`,
      `Requested artifact package: ${requestedArtifacts.join(", ")}.`,
      context.serviceHistory.length > 0 ? `Maintenance history depth: ${context.serviceHistory.length} entries.` : "",
      context.digitalTwin?.status === "fail" ? "Digital twin deviations require challenge and evidence handling." : "",
      useChallenger ? "Challenger stage enabled for competing hypotheses and blind-spot review." : "",
      useStructure ? "Structure stage enabled for artifact packaging and quality gates." : "",
    ]),
  };
}

function buildPromptPayload(input: CateoAssistInput, context: CateoContextBundle, route: CateoRoutingDecision): string {
  return JSON.stringify({
    request: {
      title: input.title,
      query: input.query,
      errorCode: input.errorCode,
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
  requestId?: string;
}): Promise<StageResult<T>> {
  try {
    const response = await params.llm.chat([
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userPrompt },
    ]);
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
        metadata: { model: params.modelInfo.model, provider: params.modelInfo.provider },
      });
      return { data: params.fallback, raw, modelInfo: params.modelInfo };
    }

    appendAuditEvent({
      actor: "model",
      category: "cateo_stage",
      action: params.stage,
      outcome: "success",
      message: `${params.stage} completed`,
      requestId: params.requestId,
      metadata: { model: params.modelInfo.model, provider: params.modelInfo.provider },
    });
    return { data: parsed, raw, modelInfo: params.modelInfo };
  } catch (error) {
    appendAuditEvent({
      actor: "model",
      category: "cateo_stage",
      action: params.stage,
      outcome: "error",
      severity: "warn",
      message: `${params.stage} failed: ${error instanceof Error ? error.message : String(error)}`,
      requestId: params.requestId,
      metadata: { model: params.modelInfo.model, provider: params.modelInfo.provider },
    });
    return { data: params.fallback, raw: error instanceof Error ? error.message : String(error), modelInfo: params.modelInfo };
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

function buildProvenance(args: {
  runId: string;
  requestId?: string;
  createdAt: string;
  actor: string;
  taskClass: CateoTaskClass;
  modelsUsed: CateoRuntimeModelInfo[];
  evidenceFingerprint: string;
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
  };
}
export async function generateCateoArtifacts(
  _config: CashClawConfig,
  runtime: CateoModelRuntime,
  input: CateoAssistInput,
  options: ServiceOptions = {},
): Promise<CateoAssistResult> {
  assertLocalCateoRuntime(runtime);

  const actor = options.actor ?? "system";
  const nowIso = new Date().toISOString();
  const caseId = crypto.randomUUID();
  const sanitizedInput = sanitizeAssistInputForPersistence(input);
  const attachmentEvidence = ingestMediaAttachments(caseId, input.attachments, options.requestId);
  const context = buildCateoContext(caseId, sanitizedInput, attachmentEvidence);
  const route = buildRoute(sanitizedInput, context);
  const promptPayload = buildPromptPayload(sanitizedInput, context, route);
  const leadStage = await callJsonStage({
    stage: "lead_plan",
    llm: runtime.lead,
    modelInfo: runtime.meta.lead,
    systemPrompt: "Return a compact JSON object for Cateo planning. No prose outside JSON.",
    userPrompt: [
      "You are Cateo's lead architect and synthesis model for regulated inspection and troubleshooting.",
      "Return JSON only.",
      "Produce keys: taskClass, objective, evidencePlan, assumptions, risks, decisionBasis, artifactPriorities, maintenanceConsiderations, partsConsiderations.",
      promptPayload,
    ].join("\n\n"),
    fallback: fallbackLeadPlan(route, context, sanitizedInput),
    requestId: options.requestId,
  });

  const challengerStage = route.useChallenger && runtime.challenger && runtime.meta.challenger
    ? await callJsonStage({
        stage: "challenger_critique",
        llm: runtime.challenger,
        modelInfo: runtime.meta.challenger,
        systemPrompt: "Return a compact JSON object with the keys alternateHypotheses, blindSpots, missingAssumptions, evidenceGaps, recommendedAdjustments. No prose outside JSON.",
        userPrompt: `${promptPayload}\n\nLead plan:\n${JSON.stringify(leadStage.data, null, 2)}`,
        fallback: fallbackCritique(context),
        requestId: options.requestId,
      })
    : undefined;

  const structureStage = route.useStructure && runtime.structure && runtime.meta.structure
    ? await callJsonStage({
        stage: "structure_blueprint",
        llm: runtime.structure,
        modelInfo: runtime.meta.structure,
        systemPrompt: "Return a compact JSON object with the key artifactPlans. Each plan must include artifactType, title, sectionOrder, qualityGates, and requiredEvidence. No prose outside JSON.",
        userPrompt: `${promptPayload}\n\nLead plan:\n${JSON.stringify(leadStage.data, null, 2)}\n\nCritique:\n${JSON.stringify(challengerStage?.data ?? fallbackCritique(context), null, 2)}`,
        fallback: fallbackStructure(route, context),
        requestId: options.requestId,
      })
    : undefined;

  const finalStage = await callJsonStage({
    stage: "lead_final_synthesis",
    llm: runtime.lead,
    modelInfo: runtime.meta.lead,
    systemPrompt: "Return a compact JSON object with the keys executiveSummary, decision, confidence, rootCauseStatement, nextActions, operatorNotes. No prose outside JSON.",
    userPrompt: `${promptPayload}\n\nLead plan:\n${JSON.stringify(leadStage.data, null, 2)}\n\nCritique:\n${JSON.stringify(challengerStage?.data ?? fallbackCritique(context), null, 2)}\n\nStructure:\n${JSON.stringify(structureStage?.data ?? fallbackStructure(route, context), null, 2)}`,
    fallback: fallbackFinal(route, context, leadStage.data, challengerStage?.data),
    requestId: options.requestId,
  });

  const runId = crypto.randomUUID();
  const modelsUsed = [
    runtime.meta.lead,
    ...(challengerStage ? [challengerStage.modelInfo] : []),
    ...(structureStage ? [structureStage.modelInfo] : []),
  ];
  const evidenceFingerprint = fingerprintEvidence({ input: sanitizedInput, context, route, trace: finalStage.data });

  const artifacts = route.requestedArtifacts.map((artifactType) => {
    const createdAt = new Date().toISOString();
    const content = buildArtifactContent(
      artifactType,
      sanitizedInput,
      context,
      leadStage.data,
      challengerStage?.data,
      structureStage?.data,
      finalStage.data,
    );
    const validationErrors = validateArtifactContent(artifactType, content);
    if (validationErrors.length > 0) {
      throw new Error(`Generated ${artifactType} failed schema validation: ${validationErrors.join("; ")}`);
    }

    const artifactId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const provenance = buildProvenance({
      runId,
      requestId: options.requestId,
      createdAt,
      actor,
      taskClass: context.taskClass,
      modelsUsed,
      evidenceFingerprint,
    });
    const summary = summarizeArtifactContent(artifactType, content);

    appendAuditEvent({
      actor: "runtime",
      category: "cateo_artifact",
      action: "create",
      outcome: "success",
      message: `Created ${artifactType} artifact ${artifactId}`,
      requestId: options.requestId,
      metadata: { caseId: context.caseId, assetId: context.asset?.assetId, workOrderId: context.workOrder?.workOrderId },
    });

    return saveArtifactRecord({
      artifactId,
      artifactType,
      schema: getSchemaRef(artifactType),
      caseId: context.caseId,
      assetId: context.asset?.assetId,
      workOrderId: context.workOrder?.workOrderId,
      currentRevisionId: revisionId,
      createdAt,
      updatedAt: createdAt,
      revisions: [{
        revisionId,
        revisionNumber: 1,
        approvalState: finalStage.data.decision,
        createdAt,
        createdBy: actor,
        summary,
        diffFromPrevious: [],
        signoffs: [],
        provenance,
        content,
      }],
    });
  });

  const trace = {
    route,
    leadPlan: leadStage.data,
    challengerCritique: challengerStage?.data,
    structureBlueprint: structureStage?.data,
    finalSynthesis: finalStage.data,
    rawLeadPlan: leadStage.raw,
    rawChallengerCritique: challengerStage?.raw,
    rawStructureBlueprint: structureStage?.raw,
    rawFinalSynthesis: finalStage.raw,
  };

  saveCaseRecord({
    caseId: context.caseId,
    runId,
    createdAt: nowIso,
    updatedAt: nowIso,
    input: sanitizedInput,
    context,
    artifacts: artifacts.map((artifact) => artifact.artifactId),
    trace,
  });

  return {
    caseId: context.caseId,
    runId,
    summary: finalStage.data.executiveSummary,
    context,
    trace,
    artifacts,
  };
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

