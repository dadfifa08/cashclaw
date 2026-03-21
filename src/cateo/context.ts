import { analyzeDigitalTwin } from "./digital_twin.js";
import { buildDerivedDigitalTwinInput } from "./media_adapter.js";
import type {
  CateoArtifactType,
  CateoAssistInput,
  CateoAttachmentEvidence,
  CateoContextBundle,
  CateoDigitalTwinInput,
  CateoFailureCodeEntry,
  CateoMatchedFailureCode,
  CateoPartCatalogEntry,
  CateoPartResolution,
  CateoTaskClass,
} from "./types.js";

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}

function scorePart(part: CateoPartCatalogEntry, tokens: Set<string>, model: string | undefined, partResolution: CateoPartResolution | undefined): number {
  let score = 0;
  for (const token of tokens) {
    if (part.description.toLowerCase().includes(token)) score += 2;
    if (part.sku.toLowerCase().includes(token)) score += 2;
  }
  if (model && part.compatibleModels?.some((entry) => entry.toLowerCase() === model.toLowerCase())) {
    score += 3;
  }
  if (partResolution?.partNumber && part.sku.toLowerCase() === partResolution.partNumber.toLowerCase()) {
    score += 8;
  }
  if (partResolution?.aliases.some((alias) => alias.toLowerCase() === part.sku.toLowerCase())) {
    score += 3;
  }
  return score;
}

function matchFailureCode(errorCode: string | undefined, entries: CateoFailureCodeEntry[] | undefined): CateoMatchedFailureCode | null {
  if (!errorCode || !entries || entries.length === 0) return null;
  const normalized = errorCode.trim().toLowerCase();
  const direct = entries.find((entry) => entry.code.trim().toLowerCase() === normalized);
  if (direct) {
    return { code: direct.code, label: direct.label, description: direct.description };
  }
  const fuzzy = entries.find((entry) => `${entry.code} ${entry.label} ${entry.description ?? ""}`.toLowerCase().includes(normalized));
  return fuzzy ? { code: fuzzy.code, label: fuzzy.label, description: fuzzy.description } : null;
}

function mergeDigitalTwinInputs(primary: CateoDigitalTwinInput | undefined, derived: CateoDigitalTwinInput | undefined): CateoDigitalTwinInput | undefined {
  if (!primary && !derived) return undefined;
  return {
    referenceModelId: primary?.referenceModelId ?? derived?.referenceModelId,
    expectedStateLabel: primary?.expectedStateLabel ?? derived?.expectedStateLabel,
    dimensions: [...(primary?.dimensions ?? []), ...(derived?.dimensions ?? [])],
    points: [...(primary?.points ?? []), ...(derived?.points ?? [])],
  };
}

function partCatalogFromResolution(partResolution: CateoPartResolution | undefined): CateoPartCatalogEntry[] {
  if (!partResolution?.partNumber) {
    return [];
  }
  return [{
    sku: partResolution.partNumber,
    description: partResolution.partDescription || partResolution.partNumber,
    compatibleModels: [],
  }];
}

export function inferCateoTaskClass(input: CateoAssistInput): CateoTaskClass {
  const corpus = [
    input.title,
    input.query,
    input.errorCode,
    input.symptomDescription,
    ...(input.observedConditions ?? []),
    ...(input.requestedArtifacts ?? []),
  ].filter(Boolean).join(" \n ").toLowerCase();

  if (/(inspection|walkdown|checklist|survey|visual|pass\/fail)/.test(corpus) || input.digitalTwin || (input.attachments?.length ?? 0) > 0) return "inspection";
  if (/(pm\b|preventive|interval|lubrication|maintenance window)/.test(corpus)) return "preventive-maintenance";
  if (/(root cause|rca|failure analysis|diagnostic reasoning)/.test(corpus)) return "root-cause-analysis";
  if (/(procedure|sop|work instruction|documentation)/.test(corpus)) return "documentation";
  if (/(error|fault|alarm|trip|fail|diagnos|troubleshoot|symptom)/.test(corpus) || input.errorCode) return "troubleshooting";
  return "mixed";
}

export function inferRequestedArtifacts(input: CateoAssistInput, taskClass = inferCateoTaskClass(input)): CateoArtifactType[] {
  if (input.requestedArtifacts && input.requestedArtifacts.length > 0) {
    return [...new Set(input.requestedArtifacts)];
  }
  switch (taskClass) {
    case "inspection": return ["inspection-checklist", "service-report", "diagnostic-reasoning-log"];
    case "preventive-maintenance": return ["inspection-checklist", "parts-tools-list", "service-report"];
    case "root-cause-analysis": return ["diagnostic-reasoning-log", "troubleshooting-procedure", "service-report"];
    case "documentation": return ["troubleshooting-procedure", "service-report"];
    case "troubleshooting": return ["troubleshooting-procedure", "parts-tools-list", "diagnostic-reasoning-log"];
    default: return ["troubleshooting-procedure", "service-report", "diagnostic-reasoning-log"];
  }
}

export function buildCateoContext(caseId: string, input: CateoAssistInput, attachmentEvidence: CateoAttachmentEvidence[] = [], partResolution?: CateoPartResolution | null): CateoContextBundle {
  const taskClass = inferCateoTaskClass(input);
  const matchedFailureCode = matchFailureCode(input.errorCode, input.taxonomy?.failureCodes);
  const machineModel = input.machine?.model ?? input.asset?.model;
  const searchTokens = new Set(tokenize([
    input.errorCode,
    matchedFailureCode?.label,
    matchedFailureCode?.description,
    input.symptomDescription,
    ...(input.observedConditions ?? []),
    partResolution?.partNumber,
    partResolution?.partDescription,
    partResolution?.manufacturer,
    ...(partResolution?.aliases ?? []),
    ...attachmentEvidence.map((entry) => `${entry.name} ${entry.mimeType ?? ""}`),
  ].filter(Boolean).join(" ")));

  const suggestedParts = [...(input.partsCatalog ?? []), ...partCatalogFromResolution(partResolution ?? undefined)]
    .map((part) => ({ part, score: scorePart(part, searchTokens, machineModel, partResolution ?? undefined) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map((entry) => entry.part);

  const digitalTwin = analyzeDigitalTwin(mergeDigitalTwinInputs(input.digitalTwin, buildDerivedDigitalTwinInput(attachmentEvidence)));
  const serviceHistory = [...(input.serviceHistory ?? [])].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 12);

  const contextSummary = uniqueStrings([
    partResolution?.partNumber ? `Resolved manufacturing part number: ${partResolution.partNumber} (${partResolution.confidencePct}% confidence).` : undefined,
    partResolution?.partDescription ? `Resolved part description: ${partResolution.partDescription}.` : undefined,
    partResolution?.manufacturer ? `Resolved manufacturer: ${partResolution.manufacturer}.` : undefined,
    partResolution?.verifiedSources.length ? `Verified web sources collected: ${partResolution.verifiedSources.length}.` : undefined,
    input.asset?.assetId ? `Asset reference: ${input.asset.assetId}.` : undefined,
    input.workOrder?.workOrderId ? `Work order reference: ${input.workOrder.workOrderId}.` : undefined,
    machineModel ? `Machine model: ${machineModel}.` : undefined,
    input.machine?.serialNumber ? `Serial number: ${input.machine.serialNumber}.` : undefined,
    input.errorCode ? `Reported error code: ${input.errorCode}.` : undefined,
    matchedFailureCode ? `Matched failure taxonomy: ${matchedFailureCode.code} - ${matchedFailureCode.label}.` : undefined,
    serviceHistory.length > 0 ? `Maintenance history entries loaded: ${serviceHistory.length}.` : undefined,
    suggestedParts.length > 0 ? `Suggested parts available: ${suggestedParts.map((entry) => entry.sku).join(", ")}.` : undefined,
    attachmentEvidence.length > 0 ? `Media evidence ingested: ${attachmentEvidence.length} attachment(s).` : undefined,
    ...attachmentEvidence.slice(0, 3).map((entry) => `${entry.kind} evidence ${entry.name}${entry.width && entry.height ? ` at ${entry.width}x${entry.height}` : ""}.`),
    digitalTwin?.status === "fail" ? `Digital twin deviations detected: ${digitalTwin.flaggedFeatures.join("; ")}.` : undefined,
    digitalTwin?.status === "pass" ? "Digital twin geometry checks passed within tolerance." : undefined,
    ...((partResolution?.evidence ?? []).slice(0, 4)),
  ]);

  const resolvedTitle = partResolution?.partNumber
    ? `${taskClass.replace(/-/g, " ")} case for ${partResolution.partNumber}`
    : input.title?.trim() || `${taskClass.replace(/-/g, " ")} case for ${input.asset?.assetId ?? input.machine?.model ?? "unidentified asset"}`;

  return {
    caseId,
    title: resolvedTitle,
    taskClass,
    asset: input.asset ?? null,
    machine: input.machine ?? null,
    workOrder: input.workOrder ?? null,
    failureCode: matchedFailureCode,
    partResolution: partResolution ?? null,
    observedConditions: uniqueStrings(input.observedConditions ?? []),
    serviceHistory,
    suggestedParts,
    attachments: attachmentEvidence,
    taxonomy: input.taxonomy ?? {},
    digitalTwin,
    contextSummary,
  };
}