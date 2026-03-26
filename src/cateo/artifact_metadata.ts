import crypto from "node:crypto";
import { getSchemaRef } from "./schemas.js";
import type {
  CateoAdapterCapability,
  CateoApplicabilityEffectivity,
  CateoApprovalState,
  CateoArtifactContent,
  CateoArtifactEnterpriseMetadata,
  CateoArtifactRecord,
  CateoArtifactRelation,
  CateoArtifactType,
  CateoChangeHistoryEntry,
  CateoConfidence,
  CateoConfigurationFingerprint,
  CateoContextBundle,
  CateoDocumentType,
  CateoExternalSystemLinks,
  CateoLifecycleState,
  CateoObjectCategory,
  CateoObjectMetadata,
  CateoDiagnosticReasoningLog,
  CateoFinalSynthesis,
  CateoInstructionTemplate,
  CateoInspectionChecklist,
  CateoPartReferenceLine,
  CateoPartsToolsList,
  CateoRequesterInfo,
  CateoReviewerDecision,
  CateoRuleResult,
  CateoServiceReport,
  CateoSkillActivation,
  CateoTroubleshootingProcedure,
} from "./types.js";
import { deriveDeepMetadataFromArtifactMetadata } from "./cplm_projection.js";

const unique = (values: Array<string | undefined | null>) => [
  ...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
];

function normalizeObjectToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase();
}

function partObjectId(partNumber: string): string {
  return `cateo:part:${normalizeObjectToken(partNumber)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function emptyExternalSystemIds(): CateoExternalSystemLinks {
  return { cmsIds: [], n7Ids: [], crmIds: [], erpIds: [] };
}

function mergeExternalSystemIds(...sources: Array<CateoExternalSystemLinks | undefined>): CateoExternalSystemLinks {
  const merged = emptyExternalSystemIds();
  for (const source of sources) {
    if (!source) continue;
    merged.cmsIds = unique([...merged.cmsIds, ...(source.cmsIds ?? [])]);
    merged.n7Ids = unique([...merged.n7Ids, ...(source.n7Ids ?? [])]);
    merged.crmIds = unique([...merged.crmIds, ...(source.crmIds ?? [])]);
    merged.erpIds = unique([...merged.erpIds, ...(source.erpIds ?? [])]);
  }
  return merged;
}

function configDerivedExternalIds(configuration: Record<string, string> | undefined): CateoExternalSystemLinks | undefined {
  if (!configuration) return undefined;
  const entries = Object.entries(configuration);
  if (entries.length === 0) return undefined;
  const pick = (labels: string[]) => unique(entries.filter(([key]) => labels.some((label) => key.toLowerCase().includes(label))).map(([, value]) => value));
  return {
    cmsIds: pick(["cms"]),
    n7Ids: pick(["n7"]),
    crmIds: pick(["crm"]),
    erpIds: pick(["erp"]),
  };
}

function inferDocumentType(artifactType: CateoArtifactType): CateoDocumentType {
  switch (artifactType) {
    case "troubleshooting-procedure":
      return "procedure";
    case "inspection-checklist":
      return "checklist";
    case "service-report":
      return "report";
    case "parts-tools-list":
      return "parts-list";
    case "diagnostic-reasoning-log":
      return "knowledge-asset";
    default:
      return "other";
  }
}

function inferLifecycleState(approvalState: CateoApprovalState): CateoLifecycleState {
  return approvalState === "draft" ? "draft" : "released";
}

function inferObjectCategory(args: {
  resolvedPartNumber?: string;
  resolvedPartDescription?: string;
  requiredPartLines: CateoPartReferenceLine[];
  taskClass: string;
  documentType: CateoDocumentType;
}): CateoObjectCategory {
  const haystack = [args.resolvedPartNumber, args.resolvedPartDescription, args.taskClass, args.documentType, ...args.requiredPartLines.map((line) => `${line.partNumber} ${line.description} ${line.partFamily ?? ""}`)].filter(Boolean).join(" ").toLowerCase();
  if (/\bln[-\s_]?\d+/i.test(args.resolvedPartNumber ?? "") || /\bln\b/.test(haystack)) return "ln";
  if (/consumable|filter|sealant|grease|oil|solvent/.test(haystack)) return "consumable";
  if (/software|firmware|recipe|configuration/.test(haystack)) return "software";
  if (/tool|wrench|meter|indicator/.test(haystack)) return "tool";
  if (/sub-assembly|subassembly|module/.test(haystack)) return "sub-assembly";
  if (/assembly|manifold|harness|kit/.test(haystack) || args.requiredPartLines.length > 1) return "assembly";
  if (!args.resolvedPartNumber) return args.documentType === "knowledge-asset" ? "knowledge-asset" : "document";
  return "part";
}

function buildObjectMetadata(args: {
  caseId: string;
  assetId?: string;
  manufacturer?: string;
  machineModel?: string;
  resolvedPartNumber?: string;
  requiredPartLines: CateoPartReferenceLine[];
  objectCategory: CateoObjectCategory;
}): CateoObjectMetadata {
  const normalizedPart = normalizeObjectToken(args.resolvedPartNumber || args.caseId);
  const bomNodeId = unique(args.requiredPartLines.map((line) => line.bomNodeId)).at(0);
  const childObjectIds = unique(args.requiredPartLines.map((line) => line.partNumber).filter((value) => value && value !== args.resolvedPartNumber)).map((partNumber) => partObjectId(partNumber));
  const parentObjectIds = unique([args.assetId ? `cateo:asset:${normalizeObjectToken(args.assetId)}` : undefined]);
  const hierarchyPath = unique([args.manufacturer, args.machineModel, args.assetId, args.resolvedPartNumber, bomNodeId]);
  return {
    persistentObjectId: `cateo:${args.objectCategory}:${normalizedPart}`,
    masterRecordId: `cateo-master:${normalizedPart}`,
    objectCategory: args.objectCategory,
    bomNodeId,
    hierarchyPath,
    parentObjectIds,
    childObjectIds,
    lineNumberRef: args.objectCategory === "ln" ? (args.resolvedPartNumber ?? undefined) : undefined,
  };
}

function buildEffectivity(context: CateoContextBundle): CateoApplicabilityEffectivity {
  const configuration = context.asset?.configuration ?? context.machine?.configuration ?? {};
  const softwareVersions = Object.entries(configuration)
    .filter(([key, value]) => value && /version|firmware|software|recipe/i.test(key))
    .map(([key, value]) => ({ product: key, minVersion: value }));
  return {
    serialRanges: context.machine?.serialNumber ? [{ serialStart: context.machine.serialNumber, serialEnd: context.machine.serialNumber, note: "Observed serial in submitted case context." }] : [],
    softwareVersions,
    geographies: unique([context.asset?.geography, context.machine?.geography]),
    locationPaths: unique([...(context.asset?.locationHierarchy ?? []), ...(context.machine?.locationHierarchy ?? [])]),
    assetIds: unique([context.asset?.assetId]),
    applicabilityNotes: unique([context.issueType, context.businessType, ...(context.contextSummary ?? []).slice(0, 4)]),
  };
}

function buildConfigurationFingerprint(context: CateoContextBundle): CateoConfigurationFingerprint | undefined {
  const payload = {
    asset: context.asset?.configuration ?? {},
    machine: context.machine?.configuration ?? {},
    serialNumber: context.machine?.serialNumber,
    locationHierarchy: context.asset?.locationHierarchy ?? context.machine?.locationHierarchy ?? [],
  };
  const source = unique([
    ...Object.keys(payload.asset),
    ...Object.keys(payload.machine),
    payload.serialNumber ? "serialNumber" : undefined,
    payload.locationHierarchy.length > 0 ? "locationHierarchy" : undefined,
  ]);
  if (source.length === 0) return undefined;
  return {
    fingerprint: crypto.createHash("sha256").update(stableJson(payload)).digest("hex"),
    source,
  };
}

function buildChangeHistory(args: {
  artifactType: CateoArtifactType;
  approvalState: CateoApprovalState;
  caseId: string;
  runId: string;
  summary: string;
  requestId?: string;
}): CateoChangeHistoryEntry[] {
  return [{
    changeId: crypto.randomUUID(),
    changedAt: new Date().toISOString(),
    actor: "cateo-runtime",
    action: args.approvalState === "draft" ? "created-draft" : "released-artifact",
    summary: `Generated ${args.artifactType} for case ${args.caseId}: ${args.summary}`.slice(0, 320),
    relatedCaseId: args.caseId,
    note: args.requestId ? `Request ${args.requestId}` : `Run ${args.runId}`,
  }];
}

function makeRelation(params: Omit<CateoArtifactRelation, "relationId">): CateoArtifactRelation {
  return {
    relationId: crypto.randomUUID(),
    ...params,
  };
}

function inferRiskLevel(args: {
  confidence: CateoConfidence;
  approvalState: CateoApprovalState;
  content: CateoArtifactContent;
}): CateoArtifactEnterpriseMetadata["riskLevel"] {
  const blob = JSON.stringify(args.content).toLowerCase();
  if (/(critical|unsafe|stop operation|stop-work|do not return)/.test(blob)) {
    return "critical";
  }
  if (args.confidence === "low" || args.approvalState === "draft") {
    return "high";
  }
  if (/(follow-up|pending|unresolved|escalate)/.test(blob)) {
    return "medium";
  }
  return "low";
}

function collectValidationSteps(artifactType: CateoArtifactType, content: CateoArtifactContent): string[] {
  if (artifactType === "troubleshooting-procedure") {
    const typed = content as CateoTroubleshootingProcedure;
    return [...typed.acceptanceCriteria, ...typed.steps.map((step) => step.expectedResult)];
  }
  if (artifactType === "inspection-checklist") {
    const typed = content as CateoInspectionChecklist;
    return [...typed.completionCriteria, ...typed.checklist.map((item) => item.passCriteria)];
  }
  if (artifactType === "service-report") {
    return [...(content as CateoServiceReport).recommendations];
  }
  if (artifactType === "parts-tools-list") {
    return (content as CateoPartsToolsList).tools.map((tool) => tool.purpose);
  }
  return [...(content as CateoDiagnosticReasoningLog).evidenceRequests];
}

function collectRequiredParts(artifactType: CateoArtifactType, content: CateoArtifactContent): string[] {
  if (artifactType === "parts-tools-list") {
    return (content as CateoPartsToolsList).parts.map((part) => `${part.sku}: ${part.description}`);
  }
  if (artifactType === "troubleshooting-procedure") {
    return [...(content as CateoTroubleshootingProcedure).requiredParts];
  }
  return [];
}

function collectRequiredTools(artifactType: CateoArtifactType, content: CateoArtifactContent): string[] {
  if (artifactType === "parts-tools-list") {
    return (content as CateoPartsToolsList).tools.map((tool) => tool.name);
  }
  if (artifactType === "troubleshooting-procedure") {
    return [...(content as CateoTroubleshootingProcedure).requiredTools];
  }
  return [];
}

function collectSymptoms(artifactType: CateoArtifactType, content: CateoArtifactContent): string[] {
  if (artifactType === "troubleshooting-procedure") {
    return [...(content as CateoTroubleshootingProcedure).symptoms];
  }
  if (artifactType === "diagnostic-reasoning-log") {
    return [(content as CateoDiagnosticReasoningLog).problemStatement];
  }
  if (artifactType === "service-report") {
    return [...(content as CateoServiceReport).findings];
  }
  return [];
}

function parsePartLine(line: string): CateoPartReferenceLine {
  const [partNumberRaw, ...rest] = line.split(":");
  const partNumber = partNumberRaw?.trim() || line.trim();
  const description = rest.join(":").trim() || partNumber;
  return {
    partNumber,
    description,
    quantity: 1,
    unitOfMeasure: "ea",
  };
}

function buildPartLines(args: { context: CateoContextBundle; requiredParts: string[]; artifactType: CateoArtifactType; content: CateoArtifactContent }): CateoPartReferenceLine[] {
  const explicit = args.requiredParts.map(parsePartLine);
  const suggested = (args.context.suggestedParts ?? []).map((part) => ({
    partNumber: part.sku,
    description: part.description,
    quantity: part.quantitySuggested,
    unitOfMeasure: "ea",
  } satisfies CateoPartReferenceLine));
  const fromCatalog = args.artifactType === "parts-tools-list"
    ? (args.content as CateoPartsToolsList).parts.map((part) => ({
      partNumber: part.sku,
      description: part.description,
      quantity: part.quantity,
      unitOfMeasure: "ea",
    } satisfies CateoPartReferenceLine))
    : [];
  const fromResolution = args.context.partResolution?.partNumber ? [{
    partNumber: args.context.partResolution.partNumber,
    description: args.context.partResolution.partDescription || args.context.partResolution.partNumber,
    quantity: 1,
    unitOfMeasure: "ea",
    manufacturer: args.context.partResolution.manufacturer,
    interchangeablePartNumbers: args.context.partResolution.aliases,
  } satisfies CateoPartReferenceLine] : [];
  const deduped = new Map<string, CateoPartReferenceLine>();
  for (const line of [...explicit, ...fromCatalog, ...suggested, ...fromResolution]) {
    const key = `${line.partNumber}::${line.description}`.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, line);
    }
  }
  return [...deduped.values()];
}

function buildRelations(args: {
  context: CateoContextBundle;
  requester?: CateoRequesterInfo;
  requiredPartLines: CateoPartReferenceLine[];
  documentRefs: string[];
  failureMode?: string;
  resolvedPartNumber?: string;
  resolvedPartDescription?: string;
  effectivity: CateoApplicabilityEffectivity;
  externalSystemIds: CateoExternalSystemLinks;
}): CateoArtifactRelation[] {
  const relations: CateoArtifactRelation[] = [];
  if (args.context.asset?.assetId) {
    relations.push(makeRelation({ kind: "installed-on", targetType: "asset", targetId: args.context.asset.assetId, label: args.context.asset.assetType || args.context.asset.assetId, strength: "exact", source: "ingested", tags: args.context.asset.locationHierarchy }));
  }
  if (args.context.workOrder?.workOrderId) {
    relations.push(makeRelation({ kind: "linked-to-work-order", targetType: "work-order", targetId: args.context.workOrder.workOrderId, label: args.context.workOrder.title || args.context.workOrder.workOrderId, strength: "exact", source: "ingested", tags: [args.context.workOrder.priority, args.context.workOrder.status].filter(Boolean) as string[] }));
  }
  if (args.failureMode) {
    relations.push(makeRelation({ kind: "tracks-failure-mode", targetType: "failure-mode", targetId: args.context.failureCode?.code || args.failureMode, label: args.context.failureCode?.label || args.failureMode, strength: args.context.failureCode?.code ? "exact" : "high", source: args.context.failureCode?.code ? "ingested" : "inferred" }));
  }
  if (args.resolvedPartNumber) {
    relations.push(makeRelation({ kind: "documents", targetType: "part", targetId: args.resolvedPartNumber, label: args.resolvedPartDescription || args.resolvedPartNumber, strength: "high", source: args.context.partResolution?.partNumber ? "ingested" : "inferred" }));
  }
  for (const part of args.requiredPartLines) {
    relations.push(makeRelation({ kind: "requires-part", targetType: "part", targetId: part.partNumber, label: part.description, strength: "high", source: "inferred", tags: [part.partFamily, part.manufacturer].filter(Boolean) as string[] }));
    if (args.resolvedPartNumber && part.partNumber !== args.resolvedPartNumber) {
      relations.push(makeRelation({ kind: "has-child", targetType: "part", targetId: part.partNumber, label: part.description, strength: "medium", source: "inferred", tags: [part.bomNodeId, part.partFamily].filter(Boolean) as string[] }));
    }
  }
  for (const documentRef of args.documentRefs) {
    relations.push(makeRelation({ kind: "documented-in", targetType: "document", targetId: documentRef, label: documentRef, strength: "medium", source: "ingested" }));
  }
  for (const software of args.effectivity.softwareVersions) {
    const targetId = `${software.product ?? "software"}:${software.minVersion ?? "*"}:${software.maxVersion ?? "*"}`;
    relations.push(makeRelation({ kind: "depends-on", targetType: "software-version", targetId, label: [software.product, software.minVersion && `>= ${software.minVersion}`, software.maxVersion && `<= ${software.maxVersion}`].filter(Boolean).join(" ") || targetId, strength: "medium", source: "inferred" }));
  }
  for (const geography of args.effectivity.geographies) {
    relations.push(makeRelation({ kind: "depends-on", targetType: "geography", targetId: geography, label: geography, strength: "medium", source: "ingested" }));
  }
  for (const [system, values] of Object.entries(args.externalSystemIds) as Array<[keyof CateoExternalSystemLinks, string[]]>) {
    for (const value of values) {
      relations.push(makeRelation({ kind: "linked-to-external-record", targetType: "external-record", targetId: `${system}:${value}`, label: `${system.toUpperCase()} ${value}`, strength: "exact", source: "ingested", tags: [system] }));
    }
  }
  if (args.requester?.conversationId) {
    relations.push(makeRelation({ kind: "linked-to-conversation", targetType: "conversation", targetId: args.requester.conversationId, label: args.requester.displayName || args.requester.conversationId, strength: "exact", source: "ingested" }));
  }
  relations.push(makeRelation({ kind: "linked-to-case", targetType: "case", targetId: args.context.caseId, label: args.context.title, strength: "exact", source: "ingested" }));
  return relations;
}

export function buildArtifactEnterpriseMetadata(args: {
  artifactType: CateoArtifactType;
  content: CateoArtifactContent;
  summary: string;
  context: CateoContextBundle;
  reviewerDecision: CateoReviewerDecision;
  finalSynthesis: CateoFinalSynthesis;
  template: CateoInstructionTemplate;
  requester?: CateoRequesterInfo;
  runId: string;
  caseId: string;
  evidenceFingerprint: string;
  promptFingerprint: string;
  requestId?: string;
  activeSkills?: CateoSkillActivation[];
  adapters?: CateoAdapterCapability[];
  validationStatus?: CateoArtifactEnterpriseMetadata["governance"]["validationStatus"];
  retryCount?: number;
  ruleResults?: CateoRuleResult[];
  marketplace?: CateoArtifactEnterpriseMetadata["marketplace"];
}): CateoArtifactEnterpriseMetadata {
  const requiredParts = collectRequiredParts(args.artifactType, args.content);
  const requiredTools = collectRequiredTools(args.artifactType, args.content);
  const validationSteps = collectValidationSteps(args.artifactType, args.content);
  const symptomSummary = collectSymptoms(args.artifactType, args.content);
  const attachmentKinds = unique(args.context.attachments.map((attachment) => attachment.kind));
  const schema = getSchemaRef(args.artifactType);
  const ruleEscalationCount = args.ruleResults?.filter((result) => result.outcome === "escalate").length ?? 0;
  const mediaSignals = unique([
    ...args.context.attachments.flatMap((attachment) => attachment.notes),
    ...args.context.observedConditions.filter((entry) => /(visible|marking|signal|measurement|dimension|material)/i.test(entry)),
  ]);
  const recurringPartSkus = unique(args.context.serviceHistory.flatMap((entry) => entry.partSkus ?? []));
  const requiredPartLines = buildPartLines({
    context: args.context,
    requiredParts,
    artifactType: args.artifactType,
    content: args.content,
  });
  const primaryPart = requiredPartLines[0];
  const failureMode = args.context.failureCode?.label || args.finalSynthesis.rootCauseStatement;
  const webSourceRefs = (args.context.partResolution?.verifiedSources ?? []).map((source) => `${source.title} <${source.url}>`);
  const documentRefs = unique([
    ...args.context.attachments.filter((attachment) => attachment.kind === "document").map((attachment) => attachment.name),
    ...(args.context.partResolution?.referenceDocuments ?? []),
    ...webSourceRefs,
  ]);
  const resolvedPartNumber = args.context.partResolution?.partNumber || primaryPart?.partNumber;
  const resolvedPartDescription = args.context.partResolution?.partDescription || primaryPart?.description;
  const documentType = inferDocumentType(args.artifactType);
  const lifecycleState = inferLifecycleState(args.reviewerDecision.approvalState);
  const objectCategory = inferObjectCategory({
    resolvedPartNumber,
    resolvedPartDescription,
    requiredPartLines,
    taskClass: args.context.taskClass,
    documentType,
  });
  const objectMetadata = buildObjectMetadata({
    caseId: args.caseId,
    assetId: args.context.asset?.assetId,
    manufacturer: args.context.machine?.manufacturer || args.context.partResolution?.manufacturer,
    machineModel: args.context.machine?.model,
    resolvedPartNumber,
    requiredPartLines,
    objectCategory,
  });
  const effectivity = buildEffectivity(args.context);
  const configurationFingerprint = buildConfigurationFingerprint(args.context);
  const externalSystemIds = mergeExternalSystemIds(
    args.context.asset?.externalSystemIds,
    args.context.machine?.externalSystemIds,
    args.context.workOrder?.externalSystemIds,
    configDerivedExternalIds(args.context.asset?.configuration),
    configDerivedExternalIds(args.context.machine?.configuration),
  );
  const relations = buildRelations({
    context: args.context,
    requester: args.requester,
    requiredPartLines,
    documentRefs,
    failureMode,
    resolvedPartNumber,
    resolvedPartDescription,
    effectivity,
    externalSystemIds,
  });
  const changeHistory = buildChangeHistory({
    artifactType: args.artifactType,
    approvalState: args.reviewerDecision.approvalState,
    caseId: args.caseId,
    runId: args.runId,
    summary: args.summary,
    requestId: args.requestId,
  });

  return {
    artifactTitle: args.summary,
    artifactSummary: args.summary,
    taskClass: args.context.taskClass,
    businessType: args.context.businessType,
    approvalState: args.reviewerDecision.approvalState,
    confidence: args.reviewerDecision.confidence,
    riskLevel: inferRiskLevel({
      confidence: args.reviewerDecision.confidence,
      approvalState: args.reviewerDecision.approvalState,
      content: args.content,
    }),
    lifecycleState,
    documentType,
    objectMetadata,
    taxonomyTags: unique([
      resolvedPartNumber,
      args.context.partResolution?.manufacturer,
      args.context.businessType,
      args.context.issueType,
      args.context.failureCode?.code,
      args.context.failureCode?.label,
      args.context.asset?.assetType,
      args.context.machine?.manufacturer,
      args.context.machine?.model,
      args.context.workOrder?.priority,
      documentType,
      objectCategory,
      lifecycleState,
      ...effectivity.geographies,
      ...requiredPartLines.map((line) => line.partNumber),
      ...(args.activeSkills ?? []).map((skill) => skill.id),
    ]),
    componentTitle: resolvedPartNumber || args.context.asset?.assetId || args.context.machine?.model || undefined,
    partNumber: resolvedPartNumber,
    partDescription: resolvedPartDescription ? `${resolvedPartNumber ?? resolvedPartDescription}: ${resolvedPartDescription}` : undefined,
    sourceTemplateId: args.template.templateId,
    sourceTemplateVersion: args.template.version,
    taxonomy: {
      domain: args.context.taskClass === "preventive-maintenance" ? "maintenance" : args.context.taskClass === "root-cause-analysis" ? "reliability" : args.context.taskClass,
      industry: args.context.businessType,
      subsystem: args.context.asset?.assetType || args.context.machine?.model || args.context.partResolution?.manufacturer,
      componentPath: unique([args.context.machine?.manufacturer, args.context.machine?.model, args.context.asset?.assetId, args.context.partResolution?.partNumber]),
      locationPath: args.context.asset?.locationHierarchy ?? args.context.machine?.locationHierarchy ?? [],
      discipline: requiredTools.some((tool) => /meter|indicator|electrical/i.test(tool)) ? "electro-mechanical" : "mechanical",
      failureMechanism: args.context.failureCode?.label || args.finalSynthesis.rootCauseStatement,
      failureEffect: args.reviewerDecision.summary,
      operatingState: args.context.observedConditions.find((entry) => /(running|stopped|intermittent|isolated)/i.test(entry)),
      environment: args.context.machine?.environment,
    },
    classification: {
      failureCode: args.context.failureCode?.code,
      failureLabel: args.context.failureCode?.label,
      failureMode,
      symptomSummary,
      rootCause: args.artifactType === "diagnostic-reasoning-log"
        ? (args.content as CateoDiagnosticReasoningLog).rootCauseStatement
        : args.finalSynthesis.rootCauseStatement,
      riskStatement: args.reviewerDecision.summary,
    },
    asset: {
      assetId: args.context.asset?.assetId,
      assetType: args.context.asset?.assetType,
      manufacturer: args.context.machine?.manufacturer || args.context.partResolution?.manufacturer,
      model: args.context.machine?.model,
      serialNumber: args.context.machine?.serialNumber,
      locationHierarchy: args.context.asset?.locationHierarchy ?? args.context.machine?.locationHierarchy ?? [],
      configuration: args.context.asset?.configuration ?? args.context.machine?.configuration ?? {},
    },
    workOrder: {
      workOrderId: args.context.workOrder?.workOrderId,
      title: args.context.workOrder?.title,
      priority: args.context.workOrder?.priority,
      status: args.context.workOrder?.status,
    },
    parts: {
      primaryPartNumber: resolvedPartNumber,
      primaryPartDescription: resolvedPartDescription,
      candidateSkus: unique([resolvedPartNumber, ...requiredPartLines.map((line) => line.partNumber), ...recurringPartSkus, ...(args.context.partResolution?.aliases ?? [])]),
      requiredPartLines,
      billOfMaterialsRefs: unique(requiredPartLines.map((line) => line.bomNodeId)),
      interchangeablePartNumbers: unique([...(args.context.partResolution?.aliases ?? []), ...requiredPartLines.flatMap((line) => line.interchangeablePartNumbers ?? [])]),
    },
    evidence: {
      attachmentIds: args.context.attachments.map((attachment) => attachment.attachmentId),
      attachmentNames: args.context.attachments.map((attachment) => attachment.name),
      evidenceSummary: unique([
        ...args.context.contextSummary,
        ...symptomSummary,
        ...(args.context.partResolution?.evidence ?? []),
        ...(args.context.partResolution?.groundedFindings ?? []),
        ...(args.context.partResolution?.expectedValues ?? []).map((value) => `Expected value: ${value}`),
        ...(args.context.partResolution?.hazardSignals ?? []).map((value) => `Hazard: ${value}`),
      ]),
      serviceHistoryCount: args.context.serviceHistory.length,
      documentRefs,
      digitalTwinStatus: args.context.digitalTwin?.status,
      measuredCriteria: validationSteps,
    },
    maintenance: {
      lastServiceAt: args.context.serviceHistory[0]?.occurredAt,
      serviceHistorySummaries: args.context.serviceHistory.map((entry) => entry.summary).slice(0, 6),
      recurringFailureCodes: unique(args.context.serviceHistory.map((entry) => entry.failureCode)),
      recurringPartSkus,
    },
    media: {
      attachmentKinds: attachmentKinds as CateoArtifactEnterpriseMetadata["media"]["attachmentKinds"],
      imageCount: args.context.attachments.filter((attachment) => attachment.kind === "image").length,
      videoCount: args.context.attachments.filter((attachment) => attachment.kind === "video").length,
      documentCount: args.context.attachments.filter((attachment) => attachment.kind === "document").length,
      derivedMeasurements: unique(args.context.attachments.flatMap((attachment) => attachment.derivedDimensions.map((dimension) => `${dimension.name}: ${dimension.observed} ${dimension.unit}`))),
      analysisSignals: mediaSignals,
    },
    actions: {
      recommendedActions: unique([
        ...args.finalSynthesis.nextActions,
        ...args.reviewerDecision.requiredFollowUp,
        ...(args.context.partResolution?.preventiveMaintenanceHints ?? []),
        ...(args.context.partResolution?.hazardSignals ?? []).map((value) => `Apply control: ${value}`),
      ]),
      validationSteps,
      requiredParts,
      requiredTools,
      followUpActions: unique([...args.finalSynthesis.operatorNotes, ...args.reviewerDecision.findings]),
    },
    relations,
    effectivity,
    configurationFingerprint,
    externalSystemIds,
    changeHistory,
    traceability: {
      caseId: args.caseId,
      runId: args.runId,
      profileId: args.requester?.profileId,
      requesterId: args.requester?.requesterId,
      userId: args.requester?.userId,
      conversationId: args.requester?.conversationId,
      messageId: args.requester?.messageId,
      promptFingerprint: args.promptFingerprint,
      evidenceFingerprint: args.evidenceFingerprint,
      requestId: args.requestId,
    },
    analytics: {
      artifactKeywords: unique([
        args.context.asset?.assetId,
        args.context.machine?.model,
        args.context.businessType,
        args.context.issueType,
        args.context.failureCode?.code,
        args.context.failureCode?.label,
        args.context.partResolution?.partNumber,
        ...requiredPartLines.map((line) => line.partNumber),
        ...requiredTools,
        ...(args.activeSkills ?? []).map((skill) => skill.id),
      ]),
      recurringSignals: unique([...args.context.serviceHistory.map((entry) => entry.failureCode), ...args.context.observedConditions, ...(args.context.partResolution?.failureModes ?? [])]),
      estimatedRevisionCount: 1,
    },
    governance: {
      schemaId: schema.id,
      schemaVersion: schema.version,
      templateId: args.template.templateId,
      templateVersion: args.template.version,
      validationStatus: args.validationStatus ?? "validated",
      ruleEscalationCount,
      retryCount: args.retryCount ?? 0,
      activeSkillIds: (args.activeSkills ?? []).map((skill) => skill.id),
      activeAdapterIds: (args.adapters ?? []).map((adapter) => adapter.id),
    },
    documentControl: {
      recordClass: `${documentType}.${args.context.taskClass}.${args.artifactType}`,
      retentionClass: "long-term-engineering-record",
      confidentiality: args.context.attachments.some((attachment) => attachment.kind === "document") ? "regulated" : "internal",
      reviewCadenceDays: args.context.taskClass === "preventive-maintenance" ? 90 : 30,
      ownerTeam: "Cateo engineering operations",
      approvalBoard: args.requester?.requiresEngineerReview ? "customer engineering review board" : args.context.workOrder?.workOrderId ? "work-order review board" : "technical reviewer",
      electronicSignoffRequired: true,
      changeReason: args.reviewerDecision.summary,
      relatedArtifactIds: [],
      regulatoryContexts: unique(["ISO-ready", args.context.workOrder?.workOrderId ? "work-order-controlled" : undefined, args.marketplace?.source === "cashclaw" ? "marketplace-traceable" : "public-assist"]),
    },
    marketplace: args.marketplace,
  };
}

export function deriveConversationTitleFromArtifacts(artifacts: CateoArtifactRecord[]): string {
  for (const artifact of artifacts) {
    const revision = artifact.revisions.at(-1);
    const title = revision?.metadata?.parts?.primaryPartDescription || revision?.metadata?.parts?.primaryPartNumber || revision?.metadata?.partDescription || revision?.metadata?.partNumber;
    if (title) {
      return title;
    }
  }

  for (const artifact of artifacts) {
    const revision = artifact.revisions.at(-1);
    const title = revision?.metadata?.asset?.assetId || revision?.metadata?.asset?.model;
    if (title) {
      return title;
    }
  }

  return "Cateo conversation";
}