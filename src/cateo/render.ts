import type {
  CateoArtifactRecord,
  CateoConfidence,
  CateoDiagnosticReasoningLog,
  CateoInspectionChecklist,
  CateoInteractionProjection,
  CateoPartsToolsList,
  CateoServiceReport,
  CateoTroubleshootingProcedure,
} from "./types.js";

const RENDERER_VERSION = "cateo-renderer-v1";

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function latestRevision(record: CateoArtifactRecord) {
  return record.revisions[record.revisions.length - 1];
}

function artifactLabel(artifactType: CateoArtifactRecord["artifactType"]): string {
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

function findArtifactContent<T>(artifacts: CateoArtifactRecord[], artifactType: CateoArtifactRecord["artifactType"]): T | null {
  const match = artifacts.find((artifact) => artifact.artifactType === artifactType);
  if (!match) {
    return null;
  }
  return latestRevision(match).content as T;
}

function summarizeRootCause(reasoning: CateoDiagnosticReasoningLog | null, procedure: CateoTroubleshootingProcedure | null, report: CateoServiceReport | null): string {
  if (reasoning?.rootCauseStatement) {
    return reasoning.rootCauseStatement;
  }
  if (report?.summary) {
    return report.summary;
  }
  if (procedure?.objective) {
    return procedure.objective;
  }
  return "Cateo prepared a controlled engineering response package from the submitted evidence.";
}

function summarizeVerificationPath(checklist: CateoInspectionChecklist | null, procedure: CateoTroubleshootingProcedure | null): string {
  if (procedure?.steps?.length) {
    const step = procedure.steps[0];
    return step ? `Start with ${step.action.toLowerCase()}.` : "Start with the first controlled verification step.";
  }
  if (checklist?.checklist?.length) {
    const item = checklist.checklist[0];
    return item ? `Begin with ${item.check.toLowerCase()}.` : "Begin with the first checklist item.";
  }
  return "Follow the controlled verification flow captured in the artifact package.";
}

function summarizeParts(parts: CateoPartsToolsList | null): string | null {
  if (!parts || parts.parts.length === 0) {
    return null;
  }
  const first = parts.parts.slice(0, 2).map((entry) => entry.sku).join(", ");
  return `Candidate parts are referenced for follow-up, including ${first}.`;
}

export function renderCateoInteraction(artifacts: CateoArtifactRecord[]): CateoInteractionProjection {
  const renderedAt = new Date().toISOString();
  const reasoning = findArtifactContent<CateoDiagnosticReasoningLog>(artifacts, "diagnostic-reasoning-log");
  const procedure = findArtifactContent<CateoTroubleshootingProcedure>(artifacts, "troubleshooting-procedure");
  const report = findArtifactContent<CateoServiceReport>(artifacts, "service-report");
  const checklist = findArtifactContent<CateoInspectionChecklist>(artifacts, "inspection-checklist");
  const parts = findArtifactContent<CateoPartsToolsList>(artifacts, "parts-tools-list");

  const rootCauseSummary = summarizeRootCause(reasoning, procedure, report);
  const verificationPath = summarizeVerificationPath(checklist, procedure);
  const partsSummary = summarizeParts(parts);
  const confidence: CateoConfidence = reasoning?.confidence ?? "medium";
  const artifactLabels = artifacts.map((artifact) => artifactLabel(artifact.artifactType));

  const highlights = uniqueStrings([
    report?.summary,
    rootCauseSummary,
    checklist?.completionCriteria?.[0],
    procedure?.acceptanceCriteria?.[0],
    partsSummary,
  ]).slice(0, 4);

  const nextActions = uniqueStrings([
    ...(procedure?.followUpActions ?? []),
    ...(report?.recommendations ?? []),
    ...(reasoning?.evidenceRequests ?? []),
    ...(checklist?.completionCriteria ?? []),
  ]).slice(0, 4);

  const messageParts = uniqueStrings([
    rootCauseSummary,
    verificationPath,
    partsSummary,
  ]);

  return {
    message: messageParts.join(" "),
    highlights,
    nextActions,
    confidence,
    artifactCount: artifacts.length,
    artifactLabels,
    renderedAt,
    rendererVersion: RENDERER_VERSION,
  };
}

export function renderArtifactSearchText(record: CateoArtifactRecord): string {
  const revision = latestRevision(record);
  return [
    artifactLabel(record.artifactType),
    revision.summary,
    JSON.stringify(revision.content),
    record.assetId,
    record.workOrderId,
  ].filter(Boolean).join("\n");
}
