import type {
  CateoArtifactRecord,
  CateoConfidence,
  CateoDiagnosticReasoningLog,
  CateoInspectionChecklist,
  CateoInteractionArtifactPreview,
  CateoInteractionProjection,
  CateoInteractionSection,
  CateoPartsToolsList,
  CateoResponseDetail,
  CateoServiceReport,
  CateoTroubleshootingProcedure,
} from "./types.js";
import { deriveConversationTitleFromArtifacts } from "./artifact_metadata.js";

const RENDERER_VERSION = "cateo-renderer-v4";
const unique = (values: Array<string | undefined | null>) => [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
const latest = (record: CateoArtifactRecord) => record.revisions[record.revisions.length - 1];

function label(artifactType: CateoArtifactRecord["artifactType"]) {
  switch (artifactType) {
    case "troubleshooting-procedure":
      return "troubleshooting procedure";
    case "inspection-checklist":
      return "inspection checklist";
    case "service-report":
      return "service report";
    case "parts-tools-list":
      return "parts and tools list";
    case "diagnostic-reasoning-log":
      return "diagnostic reasoning log";
    default:
      return artifactType;
  }
}

function find<T>(artifacts: CateoArtifactRecord[], artifactType: CateoArtifactRecord["artifactType"]) {
  const match = artifacts.find((artifact) => artifact.artifactType === artifactType);
  return match ? latest(match).content as T : null;
}

function rootCause(reasoning: CateoDiagnosticReasoningLog | null, procedure: CateoTroubleshootingProcedure | null, report: CateoServiceReport | null) {
  if (reasoning?.rootCauseStatement) return reasoning.rootCauseStatement;
  if (report?.summary) return report.summary;
  if (procedure?.objective) return procedure.objective;
  return "Cateo prepared a controlled engineering response package from the submitted evidence.";
}

function pathSummary(checklist: CateoInspectionChecklist | null, procedure: CateoTroubleshootingProcedure | null) {
  if (procedure?.steps?.length) {
    const step = procedure.steps[0];
    return step ? `${step.action} Expected outcome: ${step.expectedResult}.` : "Start with the first controlled verification step.";
  }
  if (checklist?.checklist?.length) {
    const item = checklist.checklist[0];
    return item ? `${item.check} Pass criteria: ${item.passCriteria}.` : "Begin with the first checklist item.";
  }
  return "Follow the controlled verification flow captured in the artifact package.";
}

function partSummary(parts: CateoPartsToolsList | null) {
  if (!parts || parts.parts.length === 0) return null;
  return `If replacement material is needed, start with ${parts.parts.slice(0, 2).map((part) => `${part.sku} ${part.description}`.trim()).join(", ")}.`;
}

function buildSections(args: {
  artifacts: CateoArtifactRecord[];
  reasoning: CateoDiagnosticReasoningLog | null;
  procedure: CateoTroubleshootingProcedure | null;
  report: CateoServiceReport | null;
  checklist: CateoInspectionChecklist | null;
  parts: CateoPartsToolsList | null;
  cause: string;
  nextActions: string[];
}): CateoInteractionSection[] {
  const sections: CateoInteractionSection[] = [];
  const assessment = unique([
    args.cause,
    args.report?.summary,
    args.reasoning?.problemStatement,
    args.procedure?.objective,
  ]).slice(0, 4);
  if (assessment.length > 0) {
    sections.push({ sectionId: "assessment", title: "Current engineering read", tone: "info", items: assessment });
  }

  const verification = args.procedure?.steps?.length
    ? args.procedure.steps.slice(0, 4).map((step, index) => `${index + 1}. ${step.action} Expected: ${step.expectedResult}.`)
    : args.checklist?.checklist?.slice(0, 4).map((item, index) => `${index + 1}. ${item.check} Pass: ${item.passCriteria}.`) ?? [];
  if (verification.length > 0) {
    sections.push({ sectionId: "verification", title: "Troubleshooting path", tone: "info", items: verification });
  }

  const releaseCriteria = unique([
    ...(args.procedure?.acceptanceCriteria ?? []),
    ...(args.checklist?.completionCriteria ?? []),
  ]).slice(0, 5);
  if (releaseCriteria.length > 0) {
    sections.push({ sectionId: "release-criteria", title: "Validation and release", tone: "success", items: releaseCriteria });
  }

  const materials = unique([
    ...(args.parts?.parts.slice(0, 4).map((part) => `Part ${part.sku}: ${part.description} x${part.quantity}`) ?? []),
    ...(args.procedure?.requiredParts.slice(0, 3).map((entry) => `Required part: ${entry}`) ?? []),
    ...(args.parts?.tools.slice(0, 4).map((tool) => `Tool ${tool.name}: ${tool.purpose}`) ?? []),
    ...(args.procedure?.requiredTools.slice(0, 3).map((entry) => `Required tool: ${entry}`) ?? []),
    ...(args.parts?.consumables.slice(0, 3).map((entry) => `Consumable: ${entry}`) ?? []),
  ]).slice(0, 6);
  if (materials.length > 0) {
    sections.push({ sectionId: "materials", title: "Materials and tools", tone: "info", items: materials });
  }

  const traceabilitySource = args.artifacts.find((artifact) => latest(artifact).metadata)?.revisions.at(-1)?.metadata;
  const traceability = unique([
    traceabilitySource?.partNumber ? `Part: ${traceabilitySource.partNumber}` : undefined,
    traceabilitySource?.asset?.assetId ? `Asset: ${traceabilitySource.asset.assetId}` : undefined,
    traceabilitySource?.workOrder?.workOrderId ? `Work order: ${traceabilitySource.workOrder.workOrderId}` : undefined,
    traceabilitySource?.objectMetadata?.objectCategory ? `Object category: ${traceabilitySource.objectMetadata.objectCategory}` : undefined,
    traceabilitySource?.documentType ? `Document type: ${traceabilitySource.documentType}` : undefined,
    traceabilitySource?.lifecycleState ? `Lifecycle state: ${traceabilitySource.lifecycleState}` : undefined,
    ...(traceabilitySource?.effectivity?.geographies ?? []).slice(0, 3).map((entry) => `Geography: ${entry}`),
  ]).slice(0, 6);
  if (traceability.length > 0) {
    sections.push({ sectionId: "traceability", title: "Traceability and applicability", tone: "info", items: traceability });
  }

  if (args.nextActions.length > 0) {
    sections.push({ sectionId: "next-actions", title: "Recommended next actions", tone: "caution", items: args.nextActions.slice(0, 5) });
  }

  return sections;
}

function buildArtifactPreviews(artifacts: CateoArtifactRecord[]): CateoInteractionArtifactPreview[] {
  return artifacts.map((artifact) => {
    const revision = latest(artifact);
    return {
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      title: revision.metadata?.artifactTitle || revision.summary || label(artifact.artifactType),
      summary: revision.summary,
      approvalState: revision.approvalState,
      revisionNumber: revision.revisionNumber,
    };
  });
}

function buildMessage(args: {
  detailLevel: CateoResponseDetail;
  cause: string;
  start: string;
  nextActions: string[];
  sections: CateoInteractionSection[];
  partsText: string | null;
}): string {
  if (args.detailLevel === "concise") {
    return [
      `Engineering read: ${args.cause}`,
      `Start here: ${args.start}`,
    ].filter(Boolean).join("\n\n");
  }

  if (args.detailLevel === "detailed") {
    const verification = args.sections.find((section) => section.sectionId === "verification")?.items ?? [];
    const releaseCriteria = args.sections.find((section) => section.sectionId === "release-criteria")?.items ?? [];
    const materials = args.sections.find((section) => section.sectionId === "materials")?.items ?? [];
    const nextSteps = args.sections.find((section) => section.sectionId === "next-actions")?.items ?? args.nextActions;
    return [
      `Current engineering read: ${args.cause}`,
      verification.length > 0
        ? `Controlled verification path:
${verification.slice(0, 3).join("\n")}`
        : `Controlled verification path: ${args.start}`,
      releaseCriteria.length > 0
        ? `Release criteria:
${releaseCriteria.slice(0, 3).map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`
        : null,
      materials.length > 0
        ? `Materials and tools:
${materials.slice(0, 4).join("\n")}`
        : args.partsText,
      nextSteps.length > 0
        ? `Recommended next actions:
${nextSteps.slice(0, 4).map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`
        : null,
    ].filter((value): value is string => Boolean(value)).join("\n\n");
  }

  const actionSentence = args.nextActions.length
    ? `Recommended next steps: ${args.nextActions.slice(0, 3).map((entry, index) => `${index + 1}. ${entry}`).join(" ")}`
    : null;
  return [
    `Here is the current engineering read: ${args.cause}`,
    `Start here: ${args.start}`,
    actionSentence,
    args.partsText,
  ].filter(Boolean).join("\n\n");
}

export function renderCateoInteraction(artifacts: CateoArtifactRecord[], options: { detailLevel?: CateoResponseDetail } = {}): CateoInteractionProjection {
  const detailLevel = options.detailLevel ?? "balanced";
  const reasoning = find<CateoDiagnosticReasoningLog>(artifacts, "diagnostic-reasoning-log");
  const procedure = find<CateoTroubleshootingProcedure>(artifacts, "troubleshooting-procedure");
  const report = find<CateoServiceReport>(artifacts, "service-report");
  const checklist = find<CateoInspectionChecklist>(artifacts, "inspection-checklist");
  const parts = find<CateoPartsToolsList>(artifacts, "parts-tools-list");
  const cause = rootCause(reasoning, procedure, report);
  const start = pathSummary(checklist, procedure);
  const partsText = partSummary(parts);
  const nextActions = unique([
    ...(procedure?.followUpActions ?? []),
    ...(report?.recommendations ?? []),
    ...(reasoning?.evidenceRequests ?? []),
    ...(checklist?.completionCriteria ?? []),
  ]).slice(0, 5);
  const highlights = unique([
    report?.summary,
    cause,
    checklist?.completionCriteria?.[0],
    procedure?.acceptanceCriteria?.[0],
    partsText,
  ]).slice(0, 5);
  const sections = buildSections({
    artifacts,
    reasoning,
    procedure,
    report,
    checklist,
    parts,
    cause,
    nextActions,
  });
  return {
    message: buildMessage({ detailLevel, cause, start, nextActions, sections, partsText }),
    highlights,
    nextActions,
    confidence: (reasoning?.confidence ?? "medium") as CateoConfidence,
    artifactCount: artifacts.length,
    artifactLabels: artifacts.map((artifact) => label(artifact.artifactType)),
    conversationTitle: deriveConversationTitleFromArtifacts(artifacts),
    detailLevel,
    sections,
    artifactPreviews: buildArtifactPreviews(artifacts),
    releaseStatus: "pending-engineer-review",
    requiresEngineerReview: true,
    renderedAt: new Date().toISOString(),
    rendererVersion: RENDERER_VERSION,
  };
}

export function renderArtifactSearchText(record: CateoArtifactRecord) {
  const revision = latest(record);
  return [label(record.artifactType), revision.summary, JSON.stringify(revision.metadata ?? {}), JSON.stringify(revision.content), record.assetId, record.workOrderId].filter(Boolean).join("\n");
}

