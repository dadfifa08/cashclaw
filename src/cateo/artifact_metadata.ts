import crypto from "node:crypto";
import { getSchemaRef } from "./schemas.js";
import type {
  CateoAdapterCapability,
  CateoApprovalState,
  CateoArtifactContent,
  CateoArtifactEnterpriseMetadata,
  CateoArtifactRecord,
  CateoArtifactRelation,
  CateoArtifactType,
  CateoConfidence,
  CateoContextBundle,
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

const unique = (values: Array<string | undefined | null>) => [
  ...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
];

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
  for (const part of args.requiredPartLines) {
    relations.push(makeRelation({ kind: "requires-part", targetType: "part", targetId: part.partNumber, label: part.description, strength: "high", source: "inferred", tags: [part.partFamily, part.manufacturer].filter(Boolean) as string[] }));
  }
  for (const documentRef of args.documentRefs) {
    relations.push(makeRelation({ kind: "documents", targetType: "document", targetId: documentRef, label: documentRef, strength: "medium", source: "ingested" }));
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
  const relations = buildRelations({
    context: args.context,
    requester: args.requester,
    requiredPartLines,
    documentRefs,
    failureMode,
  });
  const resolvedPartNumber = args.context.partResolution?.partNumber || primaryPart?.partNumber;
  const resolvedPartDescription = args.context.partResolution?.partDescription || primaryPart?.description;

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
    lifecycleState: "active",
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
      ...(args.activeSkills ?? []).map((skill) => skill.id),
      ...requiredPartLines.map((line) => line.partNumber),
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
      recordClass: `${args.context.taskClass}.${args.artifactType}`,
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