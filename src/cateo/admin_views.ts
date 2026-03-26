import { listConversationSummaries, loadConversationRecord } from "./conversations.js";
import { buildCateoApprovalMatrix, type CateoApprovalMatrix } from "./approval_matrix.js";
import { getCateoControlledTaxonomy, getCateoPartMasterRecord, listCateoPartMasterRecords, type CateoControlledTaxonomySnapshot, type CateoPartMasterRecord } from "./part_master.js";
import { persistTroubleshootingReportPackage } from "./report_exports.js";
import { loadArtifactRecord, loadCaseRecord, listArtifactCatalogRows, listCaseCatalogRows, saveCaseRecord } from "./store.js";
import type { CateoArtifactRecord, CateoCaseRecord, CateoConfidence, CateoInteractionReleaseStatus, CateoProductOffering, CateoServiceTier, CateoTaskClass, CateoWorkflowMode } from "./types.js";
import { deriveDeepMetadataFromArtifactMetadata, toProjectedChangeHistory, toProjectedConfigurationFingerprint, toProjectedEffectivityRules, toProjectedExternalSystemLinks, toProjectedObjectMetadata, toProjectedRelationships } from "./cplm_projection.js";
import { deriveCaseReviewWorkflow, syncCaseReviewPackageFiles } from "./review_workflow.js";

export interface CateoAdminViewer {
  requesterId?: string;
  userId?: string;
  profileId?: string;
  admin?: boolean;
}

export interface QualityGateItem {
  gateId: string;
  label: string;
  status: "complete" | "pending" | "blocked";
  note?: string;
}

export interface AdminCaseItem {
  caseId: string;
  runId: string;
  title: string;
  taskClass: CateoTaskClass;
  productOffering?: CateoProductOffering;
  workflowMode?: CateoWorkflowMode;
  businessType?: string;
  partNumber?: string;
  issueType?: string;
  serviceTier?: CateoServiceTier;
  releaseStatus?: CateoInteractionReleaseStatus;
  confidence?: CateoConfidence;
  assetId?: string;
  workOrderId?: string;
  conversationId?: string;
  requesterId?: string;
  userId?: string;
  profileId?: string;
  displayName?: string;
  organization?: string;
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
  interactionSummary?: string;
  businessJustification?: string;
  drjJustification?: string;
  documentIntent?: string;
  complianceScope: string[];
  riskTier?: string;
  requiresEngineerReview: boolean;
  qualityGates: QualityGateItem[];
}

export interface AdminConversationItem {
  conversationId: string;
  title: string;
  titleSource?: string;
  saved: boolean;
  pendingCount: number;
  messageCount: number;
  updatedAt: number;
  lastMessagePreview?: string;
  productOffering?: CateoProductOffering;
  workflowMode?: CateoWorkflowMode;
  businessType?: string;
  partNumber?: string;
  issueType?: string;
  releaseStatus?: CateoInteractionReleaseStatus;
  serviceTier?: CateoServiceTier;
  displayName?: string;
  organization?: string;
  caseId?: string;
}

export interface AdminArtifactItem {
  artifactId: string;
  artifactType: string;
  title?: string;
  summary?: string;
  approvalState: string;
  revisionNumber: number;
  updatedAt: string;
  assetId?: string;
  workOrderId?: string;
  partNumber?: string;
  businessType?: string;
  issueType?: string;
  failureCode?: string;
  taxonomyTags: string[];
  serviceTier?: CateoServiceTier;
  workflowMode?: CateoWorkflowMode;
  productOffering?: CateoProductOffering;
  displayName?: string;
  organization?: string;
  duplicateState?: string;
  caseId: string;
  documentType?: string;
  lifecycleState?: string;
  persistentObjectId?: string;
  objectMetadata?: ReturnType<typeof toProjectedObjectMetadata>;
  effectivity?: ReturnType<typeof toProjectedEffectivityRules>;
  relationships?: ReturnType<typeof toProjectedRelationships>;
  externalSystemLinks?: ReturnType<typeof toProjectedExternalSystemLinks>;
}

export interface AdminRedditReviewItem {
  replyQueueId: number;
  redditPostId?: string | null;
  subreddit?: string | null;
  title?: string | null;
  status?: string | null;
  confidence?: number | null;
  proposedComment?: string | null;
}

export interface AdminRedditReviewEnvelope {
  configured: boolean;
  reachable: boolean;
  items: AdminRedditReviewItem[];
  error?: string;
}

export interface AdminRedditReviewDecisionResult {
  configured: boolean;
  reachable: boolean;
  item?: AdminRedditReviewItem;
  error?: string;
}

function normalized(value: string | undefined | null): string | undefined {
  const next = value?.trim();
  return next ? next.toLowerCase() : undefined;
}

function includesFilter(haystack: Array<string | undefined | null>, query: string | undefined): boolean {
  if (!query) return true;
  const text = haystack.filter(Boolean).join("\n").toLowerCase();
  return text.includes(query);
}

function hasViewerAccess(record: CateoCaseRecord, viewer: CateoAdminViewer): boolean {
  if (viewer.admin) return true;
  if (viewer.userId && record.userId === viewer.userId) return true;
  if (viewer.profileId && record.requester?.profileId === viewer.profileId) return true;
  if (viewer.requesterId && record.requester?.requesterId === viewer.requesterId) return true;
  return false;
}

function buildQualityGates(record: CateoCaseRecord): QualityGateItem[] {
  const reviewerDecision = record.trace.reviewerDecision;
  const releaseStatus = record.interaction?.releaseStatus;
  const artifacts = record.artifacts
    .map((artifactId) => loadArtifactRecord(artifactId))
    .filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact));
  const workflow = deriveCaseReviewWorkflow(record, artifacts);
  const gates: QualityGateItem[] = [
    {
      gateId: "intake",
      label: "Structured intake",
      status: "complete",
      note: record.input.workflow?.mode === "reviewed-document" ? "Deterministic reviewed-document request captured." : "Conversational request captured.",
    },
    {
      gateId: "ai-draft",
      label: "AI draft package",
      status: record.artifacts.length > 0 ? "complete" : "pending",
      note: record.artifacts.length > 0 ? `${record.artifacts.length} artifact(s) generated.` : "Awaiting artifact package generation.",
    },
    {
      gateId: "ai-review",
      label: "Second-agent review",
      status: reviewerDecision?.overallStatus === "needs-revision" ? "blocked" : reviewerDecision ? "complete" : "pending",
      note: reviewerDecision?.summary ?? "Awaiting reviewer stage output.",
    },
  ];

  if (workflow) {
    gates.push({
      gateId: "technical-review",
      label: "Technical review",
      status: workflow.stage === "technical-review" ? "pending" : "complete",
      note: workflow.technical.status === "redlined"
        ? workflow.technical.note || "Technical reviewer added redlines and forwarded the package to quality."
        : workflow.stage === "technical-review"
          ? "Waiting for the technical reviewer to approve or redline the package."
          : workflow.technical.note || "Technical review completed and the package is ready for quality.",
    });
    gates.push({
      gateId: "quality-release",
      label: "Quality release",
      status: workflow.stage === "released" ? "complete" : workflow.stage === "quality-review" ? "pending" : "blocked",
      note: workflow.stage === "released"
        ? workflow.quality.note || "Quality reviewer released the final package."
        : workflow.stage === "quality-review"
          ? "Ready for quality or admin release."
          : "Blocked until technical review completes.",
    });
  }

  gates.push({
    gateId: "customer-release",
    label: "Customer release",
    status: releaseStatus === "available" ? "complete" : releaseStatus === "clarification-required" ? "blocked" : workflow?.stage === "technical-review" ? "blocked" : "pending",
    note: releaseStatus === "available"
      ? "Visible in the customer workspace."
      : releaseStatus === "clarification-required"
        ? "Blocked pending additional customer clarification."
        : workflow?.stage === "quality-review"
          ? "Awaiting the quality release decision."
          : workflow?.stage === "technical-review"
            ? "Not available until technical review completes."
            : "Awaiting release decision.",
  });

  return gates;
}

function toAdminCaseItem(record: CateoCaseRecord): AdminCaseItem {
  return {
    caseId: record.caseId,
    runId: record.runId,
    title: record.context.title,
    taskClass: record.context.taskClass,
    productOffering: record.input.productOffering,
    workflowMode: record.input.workflow?.mode,
    businessType: record.input.businessType ?? record.context.businessType,
    partNumber: record.context.partResolution?.partNumber ?? record.input.partNumber,
    issueType: record.context.issueType ?? record.input.issueType ?? record.input.errorCode,
    serviceTier: record.requester?.serviceTier,
    releaseStatus: record.interaction?.releaseStatus,
    confidence: record.interaction?.confidence,
    assetId: record.context.asset?.assetId,
    workOrderId: record.context.workOrder?.workOrderId,
    conversationId: record.conversationId,
    requesterId: record.requester?.requesterId,
    userId: record.userId,
    profileId: record.requester?.profileId,
    displayName: record.requester?.displayName,
    organization: record.requester?.organization,
    artifactCount: record.artifacts.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    interactionSummary: record.interaction?.message,
    businessJustification: record.input.workflow?.businessJustification,
    drjJustification: record.input.workflow?.drjJustification,
    documentIntent: record.input.workflow?.documentIntent,
    complianceScope: record.input.workflow?.complianceScope ?? [],
    riskTier: record.input.workflow?.riskTier,
    requiresEngineerReview: Boolean(record.interaction?.requiresEngineerReview ?? record.requester?.requiresEngineerReview),
    qualityGates: buildQualityGates(record),
  };
}

function matchesCaseFilters(item: AdminCaseItem, filters: Record<string, string | undefined>): boolean {
  const q = normalized(filters.q);
  if (!includesFilter([
    item.title,
    item.taskClass,
    item.productOffering,
    item.partNumber,
    item.businessType,
    item.issueType,
    item.displayName,
    item.organization,
    item.assetId,
    item.workOrderId,
    item.interactionSummary,
    item.documentIntent,
    item.businessJustification,
    item.drjJustification,
    ...(item.complianceScope ?? []),
  ], q)) {
    return false;
  }
  if (filters.productOffering && item.productOffering !== filters.productOffering) return false;
  if (filters.releaseStatus && item.releaseStatus !== filters.releaseStatus) return false;
  if (filters.serviceTier && item.serviceTier !== filters.serviceTier) return false;
  if (filters.workflowMode && item.workflowMode !== filters.workflowMode) return false;
  if (filters.taskClass && item.taskClass !== filters.taskClass) return false;
  if (filters.partNumber && !(item.partNumber ?? "").toLowerCase().includes(filters.partNumber.trim().toLowerCase())) return false;
  return true;
}

export function listAdminCases(filters: Record<string, string | undefined> = {}): AdminCaseItem[] {
  return listCaseCatalogRows()
    .map((row) => loadCaseRecord(row.caseId))
    .filter((record): record is CateoCaseRecord => Boolean(record))
    .map(toAdminCaseItem)
    .filter((item) => matchesCaseFilters(item, filters))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function listViewerCases(viewer: CateoAdminViewer, filters: Record<string, string | undefined> = {}): AdminCaseItem[] {
  return listCaseCatalogRows()
    .map((row) => loadCaseRecord(row.caseId))
    .filter((record): record is CateoCaseRecord => Boolean(record))
    .filter((record) => hasViewerAccess(record, viewer))
    .map(toAdminCaseItem)
    .filter((item) => matchesCaseFilters(item, filters))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function latestCaseByConversationId(): Map<string, AdminCaseItem> {
  const map = new Map<string, AdminCaseItem>();
  for (const item of listAdminCases()) {
    if (!item.conversationId) continue;
    const current = map.get(item.conversationId);
    if (!current || item.updatedAt > current.updatedAt) {
      map.set(item.conversationId, item);
    }
  }
  return map;
}

export function listAdminConversations(filters: Record<string, string | undefined> = {}): AdminConversationItem[] {
  const caseMap = latestCaseByConversationId();
  const q = normalized(filters.q);
  return listConversationSummaries({ admin: true })
    .map((summary) => {
      const related = caseMap.get(summary.conversationId);
      return {
        conversationId: summary.conversationId,
        title: summary.title,
        titleSource: summary.titleSource,
        saved: summary.saved,
        pendingCount: summary.pendingCount,
        messageCount: summary.messageCount,
        updatedAt: summary.updatedAt,
        lastMessagePreview: summary.lastMessagePreview,
        productOffering: related?.productOffering,
        workflowMode: related?.workflowMode,
        businessType: related?.businessType,
        partNumber: related?.partNumber,
        issueType: related?.issueType,
        releaseStatus: related?.releaseStatus,
        serviceTier: related?.serviceTier,
        displayName: related?.displayName,
        organization: related?.organization,
        caseId: related?.caseId,
      } satisfies AdminConversationItem;
    })
    .filter((item) => includesFilter([item.title, item.lastMessagePreview, item.productOffering, item.businessType, item.partNumber, item.issueType, item.displayName, item.organization], q))
    .filter((item) => !filters.productOffering || item.productOffering === filters.productOffering)
    .filter((item) => !filters.releaseStatus || item.releaseStatus === filters.releaseStatus)
    .filter((item) => !filters.serviceTier || item.serviceTier === filters.serviceTier)
    .filter((item) => !filters.saved || String(item.saved) === filters.saved)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function listAdminArtifacts(filters: Record<string, string | undefined> = {}): AdminArtifactItem[] {
  const q = normalized(filters.q);
  return listArtifactCatalogRows()
    .map((row): AdminArtifactItem | null => {
      const artifact = loadArtifactRecord(row.artifactId);
      const latest = artifact?.revisions.at(-1);
      const linkedCase = row.caseId ? loadCaseRecord(row.caseId) : null;
      if (!artifact || !latest) {
        return null;
      }
      return {
        artifactId: row.artifactId,
        artifactType: row.artifactType,
        title: latest.metadata?.artifactTitle,
        summary: latest.summary,
        approvalState: latest.approvalState,
        revisionNumber: latest.revisionNumber,
        updatedAt: row.updatedAt,
        assetId: row.assetId,
        workOrderId: row.workOrderId,
        partNumber: row.partNumber,
        businessType: row.businessType,
        issueType: row.issueType,
        failureCode: row.failureCode,
        taxonomyTags: row.taxonomyTags,
        serviceTier: linkedCase?.requester?.serviceTier,
        workflowMode: linkedCase?.input.workflow?.mode,
        productOffering: linkedCase?.input.productOffering,
        displayName: linkedCase?.requester?.displayName,
        organization: linkedCase?.requester?.organization,
        duplicateState: row.duplicateState,
        caseId: row.caseId,
        documentType: latest.metadata?.documentType,
        lifecycleState: latest.metadata?.lifecycleState,
        persistentObjectId: latest.metadata?.objectMetadata?.persistentObjectId,
        objectMetadata: toProjectedObjectMetadata(latest.metadata),
        effectivity: toProjectedEffectivityRules(latest.metadata?.effectivity),
        relationships: toProjectedRelationships(latest.metadata?.relations),
        externalSystemLinks: toProjectedExternalSystemLinks(latest.metadata?.externalSystemIds),
      };
    })
    .filter((item): item is AdminArtifactItem => item !== null)
    .filter((item) => includesFilter([
      item.title,
      item.summary,
      item.partNumber,
      item.businessType,
      item.issueType,
      item.failureCode,
      item.assetId,
      item.workOrderId,
      item.productOffering,
      item.displayName,
      item.organization,
      item.documentType,
      item.lifecycleState,
      item.persistentObjectId,
      JSON.stringify(item.objectMetadata ?? {}),
      JSON.stringify(item.relationships ?? []),
      JSON.stringify(item.externalSystemLinks ?? []),
      ...(item.taxonomyTags ?? []),
    ], q))
    .filter((item) => !filters.artifactType || item.artifactType === filters.artifactType)
    .filter((item) => !filters.approvalState || item.approvalState === filters.approvalState)
    .filter((item) => !filters.productOffering || item.productOffering === filters.productOffering)
    .filter((item) => !filters.serviceTier || item.serviceTier === filters.serviceTier)
    .filter((item) => !filters.partNumber || (item.partNumber ?? "").toLowerCase().includes(filters.partNumber.trim().toLowerCase()))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function fetchRedditReviewQueue(): Promise<AdminRedditReviewEnvelope> {
  const baseUrl = process.env.CATEO_REDDIT_REVIEWER_URL?.trim()?.replace(/\/+$/, "");
  const reviewKey = process.env.CATEO_REDDIT_REVIEW_KEY?.trim();
  if (!baseUrl || !reviewKey) {
    return { configured: false, reachable: false, items: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/replies`, {
      headers: {
        "X-Review-Key": reviewKey,
      },
      signal: controller.signal,
    });
    const payload = await response.json() as Array<{ reply_queue_id?: number; reddit_post_id?: string | null; subreddit?: string | null; title?: string | null; status?: string | null; confidence?: number | null; proposed_comment?: string | null }> | { detail?: string };
    if (!response.ok || !Array.isArray(payload)) {
      return {
        configured: true,
        reachable: false,
        items: [],
        error: Array.isArray(payload) ? `Reviewer service returned ${response.status}` : payload?.detail || `Reviewer service returned ${response.status}`,
      };
    }
    return {
      configured: true,
      reachable: true,
      items: payload.map((item) => ({
        replyQueueId: item.reply_queue_id ?? 0,
        redditPostId: item.reddit_post_id,
        subreddit: item.subreddit,
        title: item.title,
        status: item.status,
        confidence: item.confidence,
        proposedComment: item.proposed_comment,
      })),
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      items: [],
      error: error instanceof Error ? error.message : "Reviewer service unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function submitRedditReviewDecision(input: { replyQueueId: number; action: "approve" | "reject"; reviewerNotes?: string }): Promise<AdminRedditReviewDecisionResult> {
  const baseUrl = process.env.CATEO_REDDIT_REVIEWER_URL?.trim()?.replace(/\/+$/, "");
  const reviewKey = process.env.CATEO_REDDIT_REVIEW_KEY?.trim();
  if (!baseUrl || !reviewKey) {
    return { configured: false, reachable: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/replies/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Review-Key": reviewKey,
      },
      body: JSON.stringify({
        reply_queue_id: input.replyQueueId,
        action: input.action,
        reviewer_notes: input.reviewerNotes?.trim() || undefined,
      }),
      signal: controller.signal,
    });
    const payload = await response.json() as { reply_queue_id?: number; review_status?: string; detail?: string };
    if (!response.ok) {
      return {
        configured: true,
        reachable: false,
        error: payload?.detail || `Reviewer service returned ${response.status}`,
      };
    }
    return {
      configured: true,
      reachable: true,
      item: {
        replyQueueId: payload.reply_queue_id ?? input.replyQueueId,
        status: payload.review_status,
      },
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      error: error instanceof Error ? error.message : "Reviewer service unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}



function toAdminArtifactItemFromRecord(artifact: CateoArtifactRecord, linkedCase?: CateoCaseRecord | null): AdminArtifactItem | null {
  const latest = artifact.revisions.at(-1);
  if (!latest) return null;
  return {
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    title: latest.metadata?.artifactTitle,
    summary: latest.summary,
    approvalState: latest.approvalState,
    revisionNumber: latest.revisionNumber,
    updatedAt: artifact.updatedAt,
    assetId: artifact.assetId,
    workOrderId: artifact.workOrderId,
    partNumber: latest.metadata?.parts?.primaryPartNumber ?? latest.metadata?.partNumber,
    businessType: latest.metadata?.businessType,
    issueType: latest.metadata?.classification?.failureLabel ?? latest.metadata?.classification?.failureMode,
    failureCode: latest.metadata?.classification?.failureCode,
    taxonomyTags: latest.metadata?.taxonomyTags ?? [],
    serviceTier: linkedCase?.requester?.serviceTier,
    workflowMode: linkedCase?.input.workflow?.mode,
    productOffering: linkedCase?.input.productOffering,
    displayName: linkedCase?.requester?.displayName,
    organization: linkedCase?.requester?.organization,
    duplicateState: artifact.duplicateState,
    caseId: artifact.caseId,
    documentType: latest.metadata?.documentType,
    lifecycleState: latest.metadata?.lifecycleState,
    persistentObjectId: latest.metadata?.objectMetadata?.persistentObjectId,
    objectMetadata: toProjectedObjectMetadata(latest.metadata),
    effectivity: toProjectedEffectivityRules(latest.metadata?.effectivity),
    relationships: toProjectedRelationships(latest.metadata?.relations),
    externalSystemLinks: toProjectedExternalSystemLinks(latest.metadata?.externalSystemIds),
  };
}

export interface AdminTimelineItem {
  timelineId: string;
  label: string;
  detail: string;
  timestamp: string;
  tone: "info" | "warn" | "critical";
}

export interface AdminCaseDetail {
  item: AdminCaseItem;
  record: CateoCaseRecord;
  approvalMatrix: CateoApprovalMatrix;
  partRecord: CateoPartMasterRecord | null;
  relatedArtifacts: AdminArtifactItem[];
  conversation: ReturnType<typeof loadConversationRecord>;
  timeline: AdminTimelineItem[];
  taxonomy: CateoControlledTaxonomySnapshot;
}

export interface AdminArtifactDetail {
  item: AdminArtifactItem;
  record: CateoArtifactRecord;
  caseItem: AdminCaseItem | null;
  approvalMatrix: CateoApprovalMatrix | null;
  partRecord: CateoPartMasterRecord | null;
  timeline: AdminTimelineItem[];
}

export interface AdminPartDetail {
  part: CateoPartMasterRecord;
  relatedCases: AdminCaseItem[];
  relatedArtifacts: AdminArtifactItem[];
  taxonomy: CateoControlledTaxonomySnapshot;
}

function buildCaseTimeline(record: CateoCaseRecord, artifacts: CateoArtifactRecord[]): AdminTimelineItem[] {
  const items: AdminTimelineItem[] = [
    {
      timelineId: `${record.caseId}-created`,
      label: "Case created",
      detail: record.input.workflow?.mode === "reviewed-document" ? "Structured reviewed-document intake captured." : "Conversational request captured.",
      timestamp: record.createdAt,
      tone: "info",
    },
    {
      timelineId: `${record.caseId}-updated`,
      label: "Latest case update",
      detail: record.interaction?.releaseStatus === "available" ? "Released to the requester profile." : record.interaction?.releaseStatus === "clarification-required" ? "Blocked pending clarifying information." : "Awaiting controlled release or additional review.",
      timestamp: record.updatedAt,
      tone: record.interaction?.releaseStatus === "clarification-required" ? "warn" : "info",
    },
  ];

  for (const artifact of artifacts) {
    const latest = artifact.revisions.at(-1);
    if (!latest) continue;
    items.push({
      timelineId: `${artifact.artifactId}-${latest.revisionId}`,
      label: `${artifact.artifactType} rev ${latest.revisionNumber}`,
      detail: `${latest.approvalState} · ${latest.summary}`,
      timestamp: latest.createdAt,
      tone: latest.approvalState === "approved" ? "info" : latest.approvalState === "reviewed" ? "info" : "warn",
    });
  }

  return items.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function buildArtifactTimeline(record: CateoArtifactRecord): AdminTimelineItem[] {
  return [...record.revisions]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((revision) => ({
      timelineId: revision.revisionId,
      label: `Revision ${revision.revisionNumber}`,
      detail: `${revision.approvalState} · ${revision.summary}`,
      timestamp: revision.createdAt,
      tone: revision.approvalState === "approved" ? "info" : revision.approvalState === "reviewed" ? "info" : "warn",
    }));
}

function hydrateCaseReviewWorkflow(record: CateoCaseRecord, relatedArtifacts: CateoArtifactRecord[]): CateoCaseRecord {
  const workflow = deriveCaseReviewWorkflow(record, relatedArtifacts);
  if (!workflow) return record;

  let changed = false;
  if (!record.reviewWorkflow) {
    record.reviewWorkflow = workflow;
    changed = true;
  }

  const missingPackageFiles = !record.reviewWorkflow.packageFiles?.generatedWord || !record.reviewWorkflow.packageFiles?.generatedPdf;
  if (missingPackageFiles && relatedArtifacts.length > 0) {
    const reportPackage = persistTroubleshootingReportPackage(record, relatedArtifacts);
    syncCaseReviewPackageFiles(record, reportPackage.documentControl.files);
    changed = true;
  }

  if (changed) {
    saveCaseRecord(record);
  }
  return record;
}

export function loadAdminCaseDetail(caseId: string): AdminCaseDetail | null {
  let record = loadCaseRecord(caseId);
  if (!record) return null;
  const relatedArtifacts = record.artifacts
    .map((artifactId) => loadArtifactRecord(artifactId))
    .filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact));
  record = hydrateCaseReviewWorkflow(record, relatedArtifacts);
  const item = toAdminCaseItem(record);
  return {
    item,
    record,
    approvalMatrix: buildCateoApprovalMatrix(record, relatedArtifacts),
    partRecord: getCateoPartMasterRecord(record.context.partResolution?.partNumber ?? record.input.partNumber ?? ""),
    relatedArtifacts: relatedArtifacts
      .map((artifact) => toAdminArtifactItemFromRecord(artifact, record))
      .filter((artifact): artifact is AdminArtifactItem => Boolean(artifact)),
    conversation: record.conversationId ? loadConversationRecord(record.conversationId) : null,
    timeline: buildCaseTimeline(record, relatedArtifacts),
    taxonomy: getCateoControlledTaxonomy(),
  };
}

export function loadAdminArtifactDetail(artifactId: string): AdminArtifactDetail | null {
  const record = loadArtifactRecord(artifactId);
  if (!record) return null;
  const linkedCase = loadCaseRecord(record.caseId);
  const item = toAdminArtifactItemFromRecord(record, linkedCase);
  if (!item) return null;
  return {
    item,
    record,
    caseItem: linkedCase ? toAdminCaseItem(linkedCase) : null,
    approvalMatrix: linkedCase ? buildCateoApprovalMatrix(linkedCase, [record]) : null,
    partRecord: getCateoPartMasterRecord(item.partNumber ?? ""),
    timeline: buildArtifactTimeline(record),
  };
}

export function listAdminPartMaster(filters: Record<string, string | undefined> = {}): CateoPartMasterRecord[] {
  return listCateoPartMasterRecords({
    q: filters.q,
    manufacturer: filters.manufacturer,
    productOffering: filters.productOffering,
    failureCode: filters.failureCode,
    partNumber: filters.partNumber,
  });
}

export function loadAdminPartDetail(partNumber: string): AdminPartDetail | null {
  const part = getCateoPartMasterRecord(partNumber);
  if (!part) return null;
  const relatedCases = listAdminCases({ partNumber: part.canonicalPartNumber }).filter((item) => part.caseIds.includes(item.caseId));
  const relatedArtifacts = listAdminArtifacts({ partNumber: part.canonicalPartNumber }).filter((item) => part.artifactIds.includes(item.artifactId));
  return {
    part,
    relatedCases,
    relatedArtifacts,
    taxonomy: getCateoControlledTaxonomy(),
  };
}

export function loadAdminTaxonomy(): CateoControlledTaxonomySnapshot {
  return getCateoControlledTaxonomy();
}
