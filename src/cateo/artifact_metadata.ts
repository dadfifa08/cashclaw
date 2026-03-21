import { getSchemaRef } from "./schemas.js";
import type {
  CateoAdapterCapability,
  CateoApprovalState,
  CateoArtifactContent,
  CateoArtifactEnterpriseMetadata,
  CateoArtifactRecord,
  CateoArtifactType,
  CateoConfidence,
  CateoContextBundle,
  CateoDiagnosticReasoningLog,
  CateoFinalSynthesis,
  CateoInstructionTemplate,
  CateoPartsToolsList,
  CateoRequesterInfo,
  CateoReviewerDecision,
  CateoRuleResult,
  CateoServiceReport,
  CateoSkillActivation,
  CateoTroubleshootingProcedure,
  CateoInspectionChecklist,
} from "./types.js";

const unique = (values: Array<string | undefined | null>) => [
  ...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
];

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

  return {
    artifactTitle: args.summary,
    artifactSummary: args.summary,
    taskClass: args.context.taskClass,
    approvalState: args.reviewerDecision.approvalState,
    confidence: args.reviewerDecision.confidence,
    riskLevel: inferRiskLevel({
      confidence: args.reviewerDecision.confidence,
      approvalState: args.reviewerDecision.approvalState,
      content: args.content,
    }),
    lifecycleState: "active",
    taxonomyTags: unique([
      args.context.failureCode?.code,
      args.context.failureCode?.label,
      args.context.asset?.assetType,
      args.context.machine?.manufacturer,
      args.context.machine?.model,
      args.context.workOrder?.priority,
      ...(args.activeSkills ?? []).map((skill) => skill.id),
    ]),
    componentTitle: args.context.asset?.assetId || args.context.machine?.model || undefined,
    partNumber: requiredParts[0]?.split(":")[0],
    partDescription: requiredParts[0],
    sourceTemplateId: args.template.templateId,
    sourceTemplateVersion: args.template.version,
    classification: {
      failureCode: args.context.failureCode?.code,
      failureLabel: args.context.failureCode?.label,
      failureMode: args.context.failureCode?.label || args.finalSynthesis.rootCauseStatement,
      symptomSummary,
      rootCause: args.artifactType === "diagnostic-reasoning-log"
        ? (args.content as CateoDiagnosticReasoningLog).rootCauseStatement
        : args.finalSynthesis.rootCauseStatement,
      riskStatement: args.reviewerDecision.summary,
    },
    asset: {
      assetId: args.context.asset?.assetId,
      assetType: args.context.asset?.assetType,
      manufacturer: args.context.machine?.manufacturer,
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
    evidence: {
      attachmentIds: args.context.attachments.map((attachment) => attachment.attachmentId),
      attachmentNames: args.context.attachments.map((attachment) => attachment.name),
      evidenceSummary: unique([...args.context.contextSummary, ...symptomSummary]),
      serviceHistoryCount: args.context.serviceHistory.length,
      documentRefs: args.context.attachments.filter((attachment) => attachment.kind === "document").map((attachment) => attachment.name),
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
      recommendedActions: unique([...args.finalSynthesis.nextActions, ...args.reviewerDecision.requiredFollowUp]),
      validationSteps,
      requiredParts,
      requiredTools,
      followUpActions: unique([...args.finalSynthesis.operatorNotes, ...args.reviewerDecision.findings]),
    },
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
        args.context.failureCode?.code,
        args.context.failureCode?.label,
        ...requiredParts,
        ...requiredTools,
        ...(args.activeSkills ?? []).map((skill) => skill.id),
      ]),
      recurringSignals: unique([...args.context.serviceHistory.map((entry) => entry.failureCode), ...args.context.observedConditions]),
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
    marketplace: args.marketplace,
  };
}

export function deriveConversationTitleFromArtifacts(artifacts: CateoArtifactRecord[]): string {
  for (const artifact of artifacts) {
    const revision = artifact.revisions.at(-1);
    const title = revision?.metadata?.partDescription || revision?.metadata?.partNumber;
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

