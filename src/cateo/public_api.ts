import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { CashClawConfig } from "../config.js";
import { readRequestBody } from "../system/request_body.js";
import { buildCommandCenterSnapshot } from "./metrics.js";
import { createReportingPack, deleteAdminView, listReportingPacks, listSavedAdminViews, saveAdminView } from "./admin_packs.js";
import { fetchRedditReviewQueue, listAdminArtifacts, listAdminCases, listAdminConversations, listAdminPartMaster, listViewerCases, loadAdminArtifactDetail, loadAdminCaseDetail, loadAdminPartDetail, loadAdminTaxonomy, submitRedditReviewDecision } from "./admin_views.js";
import {
  beginPublicUserTwoFactorSetup,
  CateoPublicAuthError,
  changePublicUserPassword,
  confirmPublicUserTwoFactor,
  disablePublicUserTwoFactor,
  getPublicSession,
  listDeletedPublicUsers,
  listPublicUsers,
  loginPublicUser,
  logoutPublicSession,
  reauthorizePublicUser,
  registerPublicUser,
  updatePublicUserProfile,
} from "./accounts.js";
import {
  adoptRequesterConversations,
  completeConversationTurn,
  createConversationShare,
  failConversationTurn,
  getSharedConversation,
  listConversationSummaries,
  loadConversationRecord,
  queueConversationTurn,
  saveConversationRecord,
  setConversationSaved,
  updateConversationCheckpoint,
} from "./conversations.js";
import { transcribeAudioWithOpenAI } from "./openai_media.js";
import { getAssistJob } from "./site_jobs.js";
import { listProcedureFeedback, listProcedureFeedbackForConversation, reviewProcedureFeedback, submitProcedureFeedback } from "./feedback.js";
import { toggleProcedureFavorite } from "./favorites.js";
import { listProcedureLibrary, loadProcedureLibraryDetail } from "./plm.js";
import { signOffCateoArtifact } from "./service.js";
import { persistTroubleshootingReportPackage } from "./report_exports.js";
import { buildStoredReviewFile, buildTechnicalRedlineRtf, deriveCaseReviewWorkflow, ensureCaseReviewWorkflow, hasQualityReviewerRole, hasReviewDeskAccessRoles, hasTechnicalReviewerRole, reviewLaneForRoles, syncCaseReviewPackageFiles } from "./review_workflow.js";
import { loadArtifactRecord, loadCaseRecord, listArtifactCatalogRows, listCaseCatalogRows, saveCaseRecord } from "./store.js";
import { listPilotProfiles, updatePilotProfileAdmin } from "./profiles.js";
import type { CateoArtifactRecord, CateoAssistInput, CateoAssistResult, CateoCaseRecord } from "./types.js";

export const CATEO_SITE_PUBLIC_PREFIX = "/internal/cateo/site";
const USER_SESSION_HEADER = "x-cateo-user-session";
const MAX_BODY_BYTES = 20_971_520;
const MAX_USERS = 30;
const MAX_CONVERSATIONS = 60;
const MAX_ARTIFACTS = 240;

interface AdminReviewItem {
  caseId: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  conversationId?: string;
  requesterId?: string;
  userId?: string;
  profileId?: string;
  displayName?: string;
  organization?: string;
  serviceTier?: string;
  taskClass?: string;
  productOffering?: string;
  partNumber?: string;
  confidence?: string;
  releaseStatus?: string;
  artifactCount: number;
  draftArtifactCount: number;
  approvedArtifactCount: number;
  artifactIds: string[];
  artifactTypes: string[];
  summary?: string;
  clarifyingQuestion?: string;
}

function json(res: http.ServerResponse, data: unknown, status = 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
async function readBody(req: http.IncomingMessage) { return readRequestBody(req, { maxBytes: MAX_BODY_BYTES }); }
function parseJson<T>(raw: string) { try { return JSON.parse(raw) as T; } catch { throw new Error("Invalid JSON"); } }
function userSessionId(req: http.IncomingMessage) { const raw = req.headers[USER_SESSION_HEADER]; return (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined; }
function isAdmin(session: Awaited<ReturnType<typeof getSession>>) { return Boolean(session?.user.roles.includes("admin")); }
function rolesFor(session: Awaited<ReturnType<typeof getSession>>) { return session?.user.roles ?? []; }
function isTechnicalReviewer(session: Awaited<ReturnType<typeof getSession>>) { return hasTechnicalReviewerRole(rolesFor(session)); }
function isQualityReviewer(session: Awaited<ReturnType<typeof getSession>>) { return hasQualityReviewerRole(rolesFor(session)); }
function hasReviewDeskAccess(session: Awaited<ReturnType<typeof getSession>>) { return hasReviewDeskAccessRoles(rolesFor(session)); }
function reviewLaneForSession(session: Awaited<ReturnType<typeof getSession>>) { return reviewLaneForRoles(rolesFor(session)); }
function requestUrl(req: http.IncomingMessage) { return new URL(req.url ?? "/", "http://127.0.0.1"); }
async function getSession(config: CashClawConfig | null, req: http.IncomingMessage, requesterId: string | null, requestId: string) { return config ? getPublicSession(config, userSessionId(req), requesterId ?? undefined, requestId) : null; }
function trimPreview(text: string | undefined, max = 160) { const normalized = text?.replace(/\s+/g, " ").trim(); if (!normalized) return undefined; return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`; }
function maskPendingEngineerReviewResult(result: CateoAssistResult): CateoAssistResult { return { ...result, interaction: { ...result.interaction, releaseStatus: result.interaction.releaseStatus === "clarification-required" ? "clarification-required" : "available", requiresEngineerReview: false } }; }
async function syncConversationJobs(conversationId: string, requesterId: string | null) { const record = loadConversationRecord(conversationId); if (!record) return null; if (!requesterId) return record; for (const message of record.messages.filter((entry) => entry.role === "assistant" && entry.jobId && (entry.status === "queued" || entry.status === "running"))) { const jobId = message.jobId; if (!jobId) continue; const job = getAssistJob(jobId, requesterId); if (!job) continue; const known = message.checkpoints.length; for (const checkpoint of job.checkpoints.slice(known)) { updateConversationCheckpoint({ conversationId, assistantMessageId: message.messageId, checkpoint }); } if (job.status === "completed" && job.result) { const result = job.result.interaction.requiresEngineerReview ? maskPendingEngineerReviewResult(job.result) : job.result; completeConversationTurn({ conversationId, assistantMessageId: message.messageId, result }); } else if (job.status === "failed") { failConversationTurn({ conversationId, assistantMessageId: message.messageId, error: job.error || "Cateo could not complete that request." }); } } return loadConversationRecord(conversationId); }
function requireSession(config: CashClawConfig, req: http.IncomingMessage, requesterId: string | null, requestId: string) { const session = getPublicSession(config, userSessionId(req), requesterId ?? undefined, requestId); if (!session) throw new CateoPublicAuthError("AUTH_REQUIRED", "Login required.", 401); return session; }
function canAccess(conversation: NonNullable<ReturnType<typeof loadConversationRecord>>, viewer: { requesterId?: string; userId?: string; admin?: boolean }) { if (viewer.admin) return true; if (viewer.userId) return conversation.ownerUserId === viewer.userId || (!conversation.ownerUserId && viewer.requesterId && conversation.requesterId === viewer.requesterId); return Boolean(viewer.requesterId && conversation.requesterId === viewer.requesterId); }
function toArtifactProjection(record: NonNullable<ReturnType<typeof loadArtifactRecord>>, viewer: { requesterId?: string; userId?: string; profileId?: string; admin?: boolean }) {
  const latest = record.revisions.at(-1);
  const metadata = latest?.metadata;
  const owned = Boolean(
    viewer.admin
    || (viewer.userId && metadata?.traceability.userId === viewer.userId)
    || (viewer.profileId && metadata?.traceability.profileId === viewer.profileId)
    || (viewer.requesterId && metadata?.traceability.requesterId === viewer.requesterId)
  );
  const publicAvailable = latest?.approvalState === "approved" || latest?.approvalState === "reviewed";
  return {
    artifactId: record.artifactId,
    artifactType: record.artifactType,
    summary: latest?.summary,
    title: metadata?.artifactTitle || latest?.summary,
    approvalState: latest?.approvalState,
    confidence: metadata?.confidence,
    partNumber: metadata?.parts?.primaryPartNumber || metadata?.partNumber,
    partDescription: metadata?.parts?.primaryPartDescription || metadata?.partDescription,
    manufacturer: metadata?.asset?.manufacturer,
    assetId: record.assetId,
    workOrderId: record.workOrderId,
    updatedAt: record.updatedAt,
    revisionNumber: latest?.revisionNumber,
    lifecycleState: metadata?.lifecycleState,
    duplicateState: record.duplicateState,
    serviceTierGate: metadata?.traceability.profileId ? "owned" : "shared",
    downloadAvailable: Boolean(viewer.admin || publicAvailable),
    owned,
  };
}
function artifactVisible(record: NonNullable<ReturnType<typeof loadArtifactRecord>>, viewer: { requesterId?: string; userId?: string; profileId?: string; admin?: boolean }) {
  if (viewer.admin) return true;
  const latest = record.revisions.at(-1);
  return Boolean(latest && (latest.approvalState === "approved" || latest.approvalState === "reviewed"));
}

function loadConversationTroubleshootingReportPackage(conversationId: string, viewer: { requesterId?: string; userId?: string; profileId?: string; admin?: boolean }) {
  const conversation = loadConversationRecord(conversationId);
  if (!conversation || !canAccess(conversation, viewer)) return null;

  const latestCaseId =
    [...conversation.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.status === "completed" && message.caseId)
      ?.caseId ?? conversation.caseIds.at(-1);

  if (!latestCaseId) return null;

  const caseRecord = loadCaseRecord(latestCaseId);
  if (!caseRecord) return null;

  const artifacts = caseRecord.artifacts
    .map((artifactId) => loadArtifactRecord(artifactId))
    .filter((artifact): artifact is NonNullable<ReturnType<typeof loadArtifactRecord>> => Boolean(artifact));

  if (artifacts.length === 0) return null;

  return {
    conversation,
    caseRecord,
    reportPackage: persistTroubleshootingReportPackage(caseRecord, artifacts),
  };
}
function latestConversationCase(conversation: NonNullable<ReturnType<typeof loadConversationRecord>>) {
  const latestCaseId =
    [...conversation.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.caseId)
      ?.caseId ?? conversation.caseIds.at(-1);
  return latestCaseId ? loadCaseRecord(latestCaseId) : null;
}
function buildConversationState(conversation: NonNullable<ReturnType<typeof loadConversationRecord>>, viewer: { requesterId?: string; userId?: string; profileId?: string; admin?: boolean }) {
  const caseRecord = latestConversationCase(conversation);
  const latestUserMessage = [...conversation.messages].reverse().find((message) => message.role === "user");
  const latestAssistantMessage = [...conversation.messages].reverse().find((message) => message.role === "assistant");
  const reportPayload = loadConversationTroubleshootingReportPackage(conversation.conversationId, viewer);
  const releaseStatus = caseRecord?.interaction?.releaseStatus;
  const pending = Boolean(latestAssistantMessage && (latestAssistantMessage.status === "queued" || latestAssistantMessage.status === "running"));
  const reportAvailable = Boolean(reportPayload?.reportPackage && releaseStatus === "available" && !pending);
  const clarificationRequired = releaseStatus === "clarification-required";
  const canRespond = !pending && !reportAvailable && (clarificationRequired || latestAssistantMessage?.status === "failed");
  return {
    conversationId: conversation.conversationId,
    caseId: caseRecord?.caseId,
    releaseStatus,
    pending,
    reportAvailable,
    closed: reportAvailable,
    canRespond,
    canDownload: reportAvailable,
    canLeaveFeedback: reportAvailable,
    clarificationRequired,
    clarifyingQuestion: caseRecord?.interaction?.clarifyingQuestion,
    latestRequestPreview: trimPreview(latestUserMessage?.text, 160),
    latestResponsePreview: trimPreview(latestAssistantMessage?.text || latestAssistantMessage?.error, 220),
    latestAssistantStatus: latestAssistantMessage?.status,
    artifactCount: caseRecord?.artifacts.length ?? 0,
    reportFolder: reportPayload?.reportPackage?.indexing.folderPath,
    updatedAt: caseRecord?.updatedAt ?? (conversation.updatedAt ? new Date(conversation.updatedAt).toISOString() : undefined),
  };
}
function buildConversationFollowUpContext(conversation: NonNullable<ReturnType<typeof loadConversationRecord>>, viewer: { requesterId?: string; userId?: string; profileId?: string; admin?: boolean }) {
  const caseRecord = latestConversationCase(conversation);
  const artifacts = (caseRecord?.artifacts ?? [])
    .map((artifactId) => loadArtifactRecord(artifactId))
    .filter((artifact): artifact is NonNullable<ReturnType<typeof loadArtifactRecord>> => Boolean(artifact))
    .filter((artifact) => artifactVisible(artifact, viewer));
  return {
    conversationId: conversation.conversationId,
    caseId: caseRecord?.caseId,
    title: caseRecord?.context.title ?? conversation.title,
    input: caseRecord?.input ?? null,
    contextSummary: caseRecord?.context.contextSummary ?? [],
    clarifyingQuestion: caseRecord?.interaction?.clarifyingQuestion,
    latestResponse: caseRecord?.interaction?.message,
    preserved: {
      partNumber: caseRecord?.context.partResolution?.partNumber ?? caseRecord?.input.partNumber,
      businessType: caseRecord?.input.businessType ?? caseRecord?.context.businessType,
      issueType: caseRecord?.context.issueType ?? caseRecord?.input.issueType ?? caseRecord?.input.errorCode,
      assetId: caseRecord?.context.asset?.assetId,
      assetType: caseRecord?.context.asset?.assetType,
      machineModel: caseRecord?.context.machine?.model,
      manufacturer: caseRecord?.context.machine?.manufacturer,
      serialNumber: caseRecord?.context.machine?.serialNumber,
      workOrderId: caseRecord?.context.workOrder?.workOrderId,
      geography: caseRecord?.context.machine?.geography ?? caseRecord?.context.asset?.geography,
      responseDetail: caseRecord?.input.responseDetail,
    },
    artifactPreviews: caseRecord?.interaction?.artifactPreviews ?? artifacts.map((artifact) => {
      const revision = artifact.revisions.at(-1);
      return {
        artifactId: artifact.artifactId,
        artifactType: artifact.artifactType,
        title: revision?.metadata?.artifactTitle || revision?.summary || artifact.artifactType,
        summary: revision?.summary || artifact.artifactType,
        approvalState: revision?.approvalState || 'draft',
        revisionNumber: revision?.revisionNumber || 1,
      };
    }),
  };
}
function loadConversationCaseDetail(conversationId: string, viewer: { requesterId?: string; userId?: string; profileId?: string; admin?: boolean }) {
  const conversation = loadConversationRecord(conversationId);
  if (!conversation || !canAccess(conversation, viewer)) return null;
  const caseRecord = latestConversationCase(conversation);
  if (!caseRecord) return null;
  const artifacts = caseRecord.artifacts
    .map((artifactId) => loadArtifactRecord(artifactId))
    .filter((artifact): artifact is NonNullable<ReturnType<typeof loadArtifactRecord>> => Boolean(artifact))
    .filter((artifact) => artifactVisible(artifact, viewer));
  return {
    conversationId: conversation.conversationId,
    conversationTitle: conversation.title,
    caseId: caseRecord.caseId,
    title: caseRecord.context.title,
    releaseStatus: caseRecord.interaction?.releaseStatus,
    interaction: caseRecord.interaction,
    request: {
      productOffering: caseRecord.input.productOffering,
      businessType: caseRecord.input.businessType ?? caseRecord.context.businessType,
      issueType: caseRecord.context.issueType ?? caseRecord.input.issueType ?? caseRecord.input.errorCode,
      partNumber: caseRecord.context.partResolution?.partNumber ?? caseRecord.input.partNumber,
      assetId: caseRecord.context.asset?.assetId,
      assetType: caseRecord.context.asset?.assetType,
      machineModel: caseRecord.context.machine?.model,
      manufacturer: caseRecord.context.machine?.manufacturer,
      serialNumber: caseRecord.context.machine?.serialNumber,
      workOrderId: caseRecord.context.workOrder?.workOrderId,
      updatedAt: caseRecord.updatedAt,
    },
    contextSummary: caseRecord.context.contextSummary,
    observedConditions: caseRecord.context.observedConditions,
    artifacts: artifacts.map((artifact) => ({
      projection: toArtifactProjection(artifact, viewer),
      latestContent: artifact.revisions.at(-1)?.content,
      latestMetadata: artifact.revisions.at(-1)?.metadata,
    })),
  };
}
function loadCaseArtifacts(caseRecord: CateoCaseRecord): CateoArtifactRecord[] {
  return caseRecord.artifacts
    .map((artifactId) => loadArtifactRecord(artifactId))
    .filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact));
}

function reviewActor(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  return {
    userId: session.user.userId,
    displayName: session.user.displayName || session.user.email || session.user.username || session.user.userId,
  };
}

function refreshReviewPackage(caseRecord: CateoCaseRecord, artifacts: CateoArtifactRecord[]) {
  const reportPackage = persistTroubleshootingReportPackage(caseRecord, artifacts);
  syncCaseReviewPackageFiles(caseRecord, reportPackage.documentControl.files);
  return reportPackage;
}

function buildAdminReviewItems(lane: "technical-review" | "quality-review"): AdminReviewItem[] {
  return listCaseCatalogRows()
    .map((row) => loadCaseRecord(row.caseId))
    .filter((record): record is CateoCaseRecord => Boolean(record))
    .map<AdminReviewItem | null>((record) => {
      const interaction = record.interaction;
      if (!interaction) return null;
      const artifacts = loadCaseArtifacts(record);
      const workflow = deriveCaseReviewWorkflow(record, artifacts);
      if (!workflow || workflow.stage !== lane) return null;
      const draftArtifacts = artifacts.filter((artifact) => artifact.revisions.at(-1)?.approvalState === "draft");
      const approvedArtifacts = artifacts.filter((artifact) => artifact.revisions.at(-1)?.approvalState === "approved");
      return {
        caseId: record.caseId,
        title: record.context.title,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
        conversationId: record.conversationId,
        requesterId: record.requester?.requesterId,
        userId: record.userId,
        profileId: record.requester?.profileId,
        displayName: record.requester?.displayName,
        organization: record.requester?.organization,
        serviceTier: record.requester?.serviceTier,
        taskClass: record.context.taskClass,
        productOffering: record.input.productOffering,
        partNumber: record.context.partResolution?.partNumber,
        confidence: interaction.confidence,
        releaseStatus: interaction.releaseStatus,
        artifactCount: artifacts.length,
        draftArtifactCount: draftArtifacts.length,
        approvedArtifactCount: approvedArtifacts.length,
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
        artifactTypes: artifacts.map((artifact) => artifact.artifactType),
        summary: interaction.message,
        clarifyingQuestion: interaction.clarifyingQuestion,
      } as AdminReviewItem;
    })
    .filter((item): item is AdminReviewItem => item !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function releaseReviewedCase(caseRecord: CateoCaseRecord, actor: { userId: string; displayName: string }, note: string | undefined, requestId: string): { caseRecord: CateoCaseRecord; releasedArtifactIds: string[] } {
  const interaction = caseRecord.interaction;
  if (!interaction) {
    throw new Error(`Case ${caseRecord.caseId} does not have a releasable interaction payload.`);
  }

  const existingArtifacts = loadCaseArtifacts(caseRecord);
  const workflow = deriveCaseReviewWorkflow(caseRecord, existingArtifacts);
  if (workflow) {
    if (workflow.stage === "technical-review" || workflow.technical.status === "pending") {
      throw new Error("Technical review must complete before quality release.");
    }
    caseRecord.reviewWorkflow = {
      ...workflow,
      stage: "released",
      technical: {
        ...workflow.technical,
        status: workflow.technical.status,
      },
      quality: {
        ...workflow.quality,
        status: "released",
        reviewerUserId: actor.userId,
        reviewerDisplayName: actor.displayName,
        note: note?.trim() || workflow.quality.note,
        decidedAt: new Date().toISOString(),
      },
    };
  }

  const releasedArtifactIds: string[] = [];
  for (const artifactId of caseRecord.artifacts) {
    const artifact = loadArtifactRecord(artifactId);
    const latest = artifact?.revisions.at(-1);
    if (!artifact || !latest || latest.approvalState === "approved") continue;
    signOffCateoArtifact({
      artifactId,
      actor: actor.displayName,
      role: "quality-reviewer",
      meaning: "Quality release and controlled customer publication",
      state: "approved",
      note: note?.trim() || `Approved for customer release for case ${caseRecord.caseId}`,
    }, { requestId });
    releasedArtifactIds.push(artifactId);
  }

  caseRecord.interaction = { ...interaction, releaseStatus: "available", requiresEngineerReview: false };
  caseRecord.updatedAt = new Date().toISOString();
  const refreshedArtifacts = loadCaseArtifacts(caseRecord);
  if (caseRecord.reviewWorkflow) {
    refreshReviewPackage(caseRecord, refreshedArtifacts);
  }
  saveCaseRecord(caseRecord);

  if (caseRecord.conversationId) {
    const conversation = loadConversationRecord(caseRecord.conversationId);
    if (conversation) {
      const assistant = [...conversation.messages].reverse().find((message) => message.role === "assistant" && message.caseId === caseRecord.caseId);
      if (assistant) {
        assistant.text = caseRecord.interaction.message;
        assistant.highlights = caseRecord.interaction.highlights;
        assistant.nextActions = caseRecord.interaction.nextActions;
        assistant.confidence = caseRecord.interaction.confidence;
        assistant.artifactCount = caseRecord.interaction.artifactCount;
        assistant.error = undefined;
        assistant.status = "completed";
        assistant.updatedAt = Date.now();
        conversation.updatedAt = assistant.updatedAt;
        conversation.lastMessagePreview = trimPreview(caseRecord.interaction.message, 160);
        saveConversationRecord(conversation);
      }
    }
  }

  return { caseRecord, releasedArtifactIds };
}

function submitTechnicalReviewDecision(caseRecord: CateoCaseRecord, actor: { userId: string; displayName: string }, action: "approve" | "redline", note: string | undefined, requestId: string): { caseRecord: CateoCaseRecord } {
  const interaction = caseRecord.interaction;
  if (!interaction) {
    throw new Error(`Case ${caseRecord.caseId} does not have a reviewable interaction payload.`);
  }

  const trimmedNote = note?.trim() || undefined;
  if (action === "redline" && !trimmedNote) {
    throw new Error("Enter technical review notes before sending redlines to quality.");
  }

  const workflow = ensureCaseReviewWorkflow(caseRecord, loadCaseArtifacts(caseRecord));
  if (!workflow) {
    throw new Error("This case is not in the controlled review workflow.");
  }
  if (workflow.stage !== "technical-review") {
    throw new Error("This case is not waiting for technical review.");
  }

  const reviewedArtifacts = loadCaseArtifacts(caseRecord).map((artifact) => {
    const latest = artifact.revisions.at(-1);
    if (!latest || latest.approvalState === "reviewed" || latest.approvalState === "approved") {
      return artifact;
    }
    return signOffCateoArtifact({
      artifactId: artifact.artifactId,
      actor: actor.displayName,
      role: "technical-reviewer",
      meaning: action === "redline" ? "Technical review added redlines for quality review" : "Technical review approved package for quality review",
      state: "reviewed",
      note: trimmedNote || `Technical review completed for case ${caseRecord.caseId}`,
    }, { requestId });
  });

  const decidedAt = new Date().toISOString();
  caseRecord.reviewWorkflow = {
    ...workflow,
    stage: "quality-review",
    technical: {
      ...workflow.technical,
      status: action === "redline" ? "redlined" : "approved",
      reviewerUserId: actor.userId,
      reviewerDisplayName: actor.displayName,
      note: trimmedNote,
      decidedAt,
      redlineFile: action === "redline" ? workflow.technical.redlineFile : undefined,
    },
    quality: {
      ...workflow.quality,
      status: "pending",
    },
  };
  caseRecord.interaction = { ...interaction, releaseStatus: "pending-engineer-review", requiresEngineerReview: true };
  caseRecord.updatedAt = decidedAt;

  let reportPackage = refreshReviewPackage(caseRecord, reviewedArtifacts);
  if (action === "redline" && trimmedNote) {
    const reportFolder = path.dirname(reportPackage.indexing.jsonPath);
    const fileName = `${caseRecord.caseId}-technical-redline.rtf`;
    const redlineFile = buildStoredReviewFile({
      kind: "technical-redline",
      folderPath: reportPackage.indexing.folderPath,
      fileName,
      mimeType: "application/rtf",
      uploadedAt: decidedAt,
      uploadedBy: actor.displayName,
    });
    fs.writeFileSync(path.join(reportFolder, fileName), buildTechnicalRedlineRtf({
      title: caseRecord.context.title,
      caseId: caseRecord.caseId,
      partNumber: caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber,
      reviewer: actor.displayName,
      decidedAt,
      note: trimmedNote,
      artifactIds: reviewedArtifacts.map((artifact) => artifact.artifactId),
    }), "utf8");
    caseRecord.reviewWorkflow.technical.redlineFile = redlineFile;
    reportPackage = refreshReviewPackage(caseRecord, reviewedArtifacts);
  }

  syncCaseReviewPackageFiles(caseRecord, reportPackage.documentControl.files);
  saveCaseRecord(caseRecord);
  return { caseRecord };
}
export async function handleCateoSitePublicApi(args: { pathname: string; req: http.IncomingMessage; res: http.ServerResponse; config: CashClawConfig | null; requestId: string; requesterId: string | null }): Promise<boolean> {
  const { pathname, req, res, config, requestId, requesterId } = args;
  if (!pathname.startsWith(CATEO_SITE_PUBLIC_PREFIX)) return false;
  if (!config) { json(res, { error: "Cateo runtime is not configured" }, 503); return true; }
  const session = await getSession(config, req, requesterId, requestId);
  const viewer = { requesterId: requesterId ?? undefined, userId: session?.user.userId, profileId: session?.user.profileId, admin: isAdmin(session) };
  const url = requestUrl(req);
  try {
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/auth/session`) { json(res, { ok: true, session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/auth/register`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!requesterId) { json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400); return true; } const body = parseJson<{ email: string; password: string; displayName?: string; organization?: string; username?: string }>(await readBody(req)); const created = registerPublicUser(config, { ...body, requesterId }, requestId); adoptRequesterConversations(created.user.userId, requesterId, created.user.profileId); json(res, { ok: true, session: created }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/auth/login`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!requesterId) { json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400); return true; } const body = parseJson<{ identifier: string; password: string; otpCode?: string }>(await readBody(req)); const loggedIn = loginPublicUser(config, { ...body, requesterId }, requestId); adoptRequesterConversations(loggedIn.user.userId, requesterId, loggedIn.user.profileId); json(res, { ok: true, session: loggedIn }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/auth/logout`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } logoutPublicSession(userSessionId(req), requestId); json(res, { ok: true }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/overview`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const items = listConversationSummaries({ requesterId: requesterId ?? undefined, userId: activeSession.user.userId, admin: false }).slice(0, MAX_CONVERSATIONS); const cases = listViewerCases(viewer, {}).slice(0, MAX_CONVERSATIONS); const favorites = listProcedureLibrary({}, activeSession.user.userId).filter((item) => item.favorited).slice(0, MAX_CONVERSATIONS); json(res, { ok: true, session: activeSession, profile: activeSession.user.profile, stats: { conversations: items.length, saved: items.filter((entry) => entry.saved).length, shared: items.filter((entry) => Boolean(entry.shareId)).length, pending: items.reduce((sum, entry) => sum + entry.pendingCount, 0), cases: cases.length, closedCases: cases.filter((entry) => entry.releaseStatus === "available").length, clarificationRequired: cases.filter((entry) => entry.releaseStatus === "clarification-required").length, favorites: favorites.length }, conversations: items, cases, favorites, tokenHistory: activeSession.user.profile?.history ?? [] }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); json(res, { ok: true, session: activeSession, settings: { displayName: activeSession.user.displayName, organization: activeSession.user.organization, email: activeSession.user.email, username: activeSession.user.username, preferences: activeSession.user.preferences, security: activeSession.user.security } }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/profile`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ displayName?: string; organization?: string; email?: string; username?: string; timezone?: string; responseDetail?: "balanced" | "concise" | "detailed"; emailUpdates?: boolean }>(await readBody(req)); const user = updatePublicUserProfile(config, activeSession.user.userId, body, requestId); json(res, { ok: true, session: { ...activeSession, user } }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/password`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ currentPassword: string; newPassword: string }>(await readBody(req)); const user = changePublicUserPassword(config, activeSession.user.userId, body, requestId); json(res, { ok: true, session: { ...activeSession, user } }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/2fa/setup`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const setup = beginPublicUserTwoFactorSetup(config, activeSession.user.userId, requestId); json(res, { ok: true, session: activeSession, setup }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/2fa/confirm`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ code: string }>(await readBody(req)); const confirmed = confirmPublicUserTwoFactor(config, activeSession.user.userId, body.code, requestId); json(res, { ok: true, session: { ...activeSession, user: confirmed.user }, recoveryCodes: confirmed.recoveryCodes }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/2fa/disable`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ code: string }>(await readBody(req)); const user = disablePublicUserTwoFactor(config, activeSession.user.userId, body.code, requestId); json(res, { ok: true, session: { ...activeSession, user } }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/conversations`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } const items = listConversationSummaries(viewer).slice(0, MAX_CONVERSATIONS); const synced = []; for (const item of items) { const record = await syncConversationJobs(item.conversationId, requesterId); synced.push(record ? { ...item, pendingCount: record.messages.filter((m) => m.role === "assistant" && (m.status === "queued" || m.status === "running")).length, updatedAt: record.updatedAt, lastMessagePreview: record.lastMessagePreview, title: record.title, titleSource: record.titleSource, saved: record.saved, shareId: record.shareId, messageCount: record.messages.length } : item); } json(res, { ok: true, items: synced, session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/conversations/queue-turn`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!requesterId) { json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400); return true; } const body = parseJson<{ conversationId?: string; jobId: string; promptText: string; input: import("./types.js").CateoAssistInput }>(await readBody(req)); try { const queued = queueConversationTurn({ conversationId: body.conversationId, viewer, requesterId, ownerUserId: session?.user.userId, profileId: session?.user.profileId, jobId: body.jobId, input: body.input, promptText: body.promptText }); json(res, { ok: true, conversation: queued.summary, assistantMessageId: queued.assistantMessage.messageId, userMessageId: queued.userMessage.messageId }); } catch (error) { const message = error instanceof Error ? error.message : "Conversation queueing failed."; json(res, { error: message }, message.includes("already has a request in progress") ? 409 : 500); } return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/conversations/sync-job`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!requesterId) { json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400); return true; } const body = parseJson<{ conversationId: string; assistantMessageId: string; jobId: string }>(await readBody(req)); const job = getAssistJob(body.jobId, requesterId); if (!job) { json(res, { error: "Job not found" }, 404); return true; } if (job.status === "completed" && job.result) { const result = job.result.interaction.requiresEngineerReview ? maskPendingEngineerReviewResult(job.result) : job.result; completeConversationTurn({ conversationId: body.conversationId, assistantMessageId: body.assistantMessageId, result }); } else if (job.status === "failed") failConversationTurn({ conversationId: body.conversationId, assistantMessageId: body.assistantMessageId, error: job.error || "Cateo could not complete that request." }); else for (const checkpoint of job.checkpoints) updateConversationCheckpoint({ conversationId: body.conversationId, assistantMessageId: body.assistantMessageId, checkpoint }); json(res, { ok: true, conversation: loadConversationRecord(body.conversationId) }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/artifacts`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      const q = url.searchParams.get("q")?.trim().toLowerCase();
      const artifactType = url.searchParams.get("artifactType")?.trim();
      const approvalState = url.searchParams.get("approvalState")?.trim();
      const partNumber = url.searchParams.get("partNumber")?.trim().toLowerCase();
      const records = listArtifactCatalogRows()
        .slice(0, MAX_ARTIFACTS)
        .map((row) => loadArtifactRecord(row.artifactId))
        .filter((record): record is NonNullable<ReturnType<typeof loadArtifactRecord>> => Boolean(record))
        .filter((record) => artifactVisible(record, viewer))
        .filter((record) => {
          const latest = record.revisions.at(-1);
          const metadata = latest?.metadata;
          const haystack = JSON.stringify({
            artifactId: record.artifactId,
            artifactType: record.artifactType,
            summary: latest?.summary,
            title: metadata?.artifactTitle,
            partNumber: metadata?.parts?.primaryPartNumber || metadata?.partNumber,
            partDescription: metadata?.parts?.primaryPartDescription || metadata?.partDescription,
            assetId: record.assetId,
            workOrderId: record.workOrderId,
          }).toLowerCase();
          if (q && !haystack.includes(q)) return false;
          if (artifactType && record.artifactType !== artifactType) return false;
          if (approvalState && latest?.approvalState !== approvalState) return false;
          if (partNumber) {
            const currentPart = (metadata?.parts?.primaryPartNumber || metadata?.partNumber || "").toLowerCase();
            if (!currentPart.includes(partNumber)) return false;
          }
          return true;
        });
      const items = records.map((record) => toArtifactProjection(record, viewer));
      json(res, {
        ok: true,
        session: activeSession,
        items,
        stats: {
          total: items.length,
          approved: items.filter((item) => item.approvalState === "approved").length,
          reviewed: items.filter((item) => item.approvalState === "reviewed").length,
          draft: items.filter((item) => item.approvalState === "draft").length,
          owned: items.filter((item) => item.owned).length,
        },
      });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/library`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      const filters = {
        q: url.searchParams.get("q")?.trim() || undefined,
        partNumber: url.searchParams.get("partNumber")?.trim() || undefined,
        businessType: url.searchParams.get("businessType")?.trim() || undefined,
        issueType: url.searchParams.get("issueType")?.trim() || undefined,
        manufacturer: url.searchParams.get("manufacturer")?.trim() || undefined,
      };
      const items = listProcedureLibrary(filters, activeSession.user.userId);
      json(res, { ok: true, session: activeSession, items, stats: { total: items.length, favorites: items.filter((item) => item.favorited).length, downloadable: items.filter((item) => item.downloadable).length } });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/favorites`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      const items = listProcedureLibrary({}, activeSession.user.userId).filter((item) => item.favorited);
      json(res, { ok: true, session: activeSession, items, stats: { total: items.length } });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/favorites/toggle`) {
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      const body = parseJson<{ caseId: string; favorited?: boolean }>(await readBody(req));
      const result = toggleProcedureFavorite({ caseId: body.caseId, favorited: body.favorited, userId: activeSession.user.userId, profileId: activeSession.user.profileId }, requestId);
      json(res, { ok: true, ...result, items: listProcedureLibrary({}, activeSession.user.userId).filter((item) => item.favorited), session: activeSession });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/cases`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      const filters = {
        q: url.searchParams.get("q")?.trim() || undefined,
        productOffering: url.searchParams.get("productOffering")?.trim() || undefined,
        releaseStatus: url.searchParams.get("releaseStatus")?.trim() || undefined,
        workflowMode: url.searchParams.get("workflowMode")?.trim() || undefined,
        partNumber: url.searchParams.get("partNumber")?.trim() || undefined,
      };
      const items = listViewerCases(viewer, filters);
      json(res, {
        ok: true,
        session: activeSession,
        items,
        stats: {
          total: items.length,
          pendingReview: items.filter((item) => item.releaseStatus === "pending-engineer-review").length,
          available: items.filter((item) => item.releaseStatus === "available").length,
          clarificationRequired: items.filter((item) => item.releaseStatus === "clarification-required").length,
          reviewedDocuments: items.filter((item) => item.workflowMode === "reviewed-document").length,
        },
      });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/cases`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!hasReviewDeskAccess(session)) { json(res, { error: "Review access required" }, 403); return true; }
      const filters = {
        q: url.searchParams.get("q")?.trim() || undefined,
        productOffering: url.searchParams.get("productOffering")?.trim() || undefined,
        releaseStatus: url.searchParams.get("releaseStatus")?.trim() || undefined,
        serviceTier: url.searchParams.get("serviceTier")?.trim() || undefined,
        workflowMode: url.searchParams.get("workflowMode")?.trim() || undefined,
        taskClass: url.searchParams.get("taskClass")?.trim() || undefined,
        partNumber: url.searchParams.get("partNumber")?.trim() || undefined,
      };
      let items = listAdminCases(filters);
      const lane = reviewLaneForSession(session);
      if (!isAdmin(session) && lane) {
        items = items.filter((item) => {
          const record = loadCaseRecord(item.caseId);
          if (!record) return false;
          const workflow = deriveCaseReviewWorkflow(record, loadCaseArtifacts(record));
          return workflow?.stage === lane;
        });
      }
      json(res, {
        ok: true,
        items,
        stats: {
          total: items.length,
          pendingReview: items.filter((item) => item.releaseStatus === "pending-engineer-review").length,
          available: items.filter((item) => item.releaseStatus === "available").length,
          clarificationRequired: items.filter((item) => item.releaseStatus === "clarification-required").length,
          reviewedDocuments: items.filter((item) => item.workflowMode === "reviewed-document").length,
          enterprise: items.filter((item) => item.serviceTier === "enterprise").length,
        },
        session,
      });
      return true;
    }    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/conversations`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const filters = {
        q: url.searchParams.get("q")?.trim() || undefined,
        productOffering: url.searchParams.get("productOffering")?.trim() || undefined,
        releaseStatus: url.searchParams.get("releaseStatus")?.trim() || undefined,
        serviceTier: url.searchParams.get("serviceTier")?.trim() || undefined,
        saved: url.searchParams.get("saved")?.trim() || undefined,
      };
      const items = listAdminConversations(filters);
      json(res, { ok: true, items, stats: { total: items.length, saved: items.filter((item) => item.saved).length, pending: items.filter((item) => item.pendingCount > 0).length }, session });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/artifacts`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const filters = {
        q: url.searchParams.get("q")?.trim() || undefined,
        artifactType: url.searchParams.get("artifactType")?.trim() || undefined,
        approvalState: url.searchParams.get("approvalState")?.trim() || undefined,
        productOffering: url.searchParams.get("productOffering")?.trim() || undefined,
        serviceTier: url.searchParams.get("serviceTier")?.trim() || undefined,
        partNumber: url.searchParams.get("partNumber")?.trim() || undefined,
      };
      const items = listAdminArtifacts(filters);
      json(res, { ok: true, items, stats: { total: items.length, approved: items.filter((item) => item.approvalState === "approved").length, reviewed: items.filter((item) => item.approvalState === "reviewed").length, draft: items.filter((item) => item.approvalState === "draft").length }, session });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/parts`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const filters = {
        q: url.searchParams.get("q")?.trim() || undefined,
        manufacturer: url.searchParams.get("manufacturer")?.trim() || undefined,
        productOffering: url.searchParams.get("productOffering")?.trim() || undefined,
        failureCode: url.searchParams.get("failureCode")?.trim() || undefined,
        partNumber: url.searchParams.get("partNumber")?.trim() || undefined,
      };
      const items = listAdminPartMaster(filters);
      json(res, {
        ok: true,
        items,
        stats: {
          total: items.length,
          released: items.filter((item) => item.releasedArtifactCount > 0).length,
          duplicateArtifacts: items.reduce((sum, item) => sum + item.duplicateArtifactCount, 0),
        },
        session,
      });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/taxonomy`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      json(res, { ok: true, taxonomy: loadAdminTaxonomy(), session });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/views`) {
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      if (req.method === "GET") {
        json(res, { ok: true, items: listSavedAdminViews(activeSession.user.userId), session: activeSession });
        return true;
      }
      if (req.method === "POST") {
        const body = parseJson<{ title: string; description?: string; scope: "command-center" | "cases" | "conversations" | "artifacts" | "parts"; filters: Record<string, string | undefined> }>(await readBody(req));
        const item = saveAdminView({
          title: body.title,
          description: body.description,
          scope: body.scope,
          filters: body.filters,
          ownerUserId: activeSession.user.userId,
          ownerDisplayName: activeSession.user.displayName,
        });
        json(res, { ok: true, item, items: listSavedAdminViews(activeSession.user.userId), session: activeSession });
        return true;
      }
      json(res, { error: "GET or POST only" }, 405);
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/views/delete`) {
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; }
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      const body = parseJson<{ viewId: string }>(await readBody(req));
      deleteAdminView(body.viewId, activeSession.user.userId);
      json(res, { ok: true, items: listSavedAdminViews(activeSession.user.userId), session: activeSession });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reporting-packs`) {
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      if (req.method === "GET") {
        json(res, { ok: true, items: listReportingPacks(), session: activeSession });
        return true;
      }
      if (req.method === "POST") {
        const body = parseJson<{ title: string; description?: string; filters: Record<string, string | undefined> }>(await readBody(req));
        const item = createReportingPack({
          title: body.title,
          description: body.description,
          filters: body.filters,
          generatedBy: activeSession.user.displayName || activeSession.user.email || activeSession.user.username || activeSession.user.userId,
        });
        json(res, { ok: true, item, items: listReportingPacks(), session: activeSession });
        return true;
      }
      json(res, { error: "GET or POST only" }, 405);
      return true;
    }    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reddit/reviews`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const reddit = await fetchRedditReviewQueue();
      json(res, { ok: true, ...reddit, session });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reddit/reviews/decision`) {
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; }
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const body = parseJson<{ replyQueueId: number; action: "approve" | "reject"; reviewerNotes?: string }>(await readBody(req));
      const result = await submitRedditReviewDecision(body);
      if (!result.configured) { json(res, { error: "Reddit reviewer service is not configured" }, 503); return true; }
      if (!result.reachable) { json(res, { error: result.error || "Reddit reviewer service is unavailable" }, 502); return true; }
      json(res, { ok: true, ...result, queue: await fetchRedditReviewQueue(), session });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/overview`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } json(res, { ok: true, metrics: buildCommandCenterSnapshot(), users: listPublicUsers(config).slice(0, MAX_USERS), deletedUsers: listDeletedPublicUsers(config).slice(0, MAX_USERS), profiles: listPilotProfiles(config).slice(0, MAX_USERS), conversations: listConversationSummaries({ admin: true }).slice(0, MAX_CONVERSATIONS), session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reviews`) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!hasReviewDeskAccess(session)) { json(res, { error: "Review access required" }, 403); return true; }
      const lane = reviewLaneForSession(session);
      if (!lane) { json(res, { error: "Review access required" }, 403); return true; }
      const items = buildAdminReviewItems(lane);
      json(res, { ok: true, items, stats: { pendingCases: items.length, pendingArtifacts: items.reduce((sum, item) => sum + item.draftArtifactCount, 0), enterpriseCases: items.filter((item) => item.serviceTier === "enterprise").length, reviewedTierCases: items.filter((item) => item.serviceTier === "reviewed").length }, session });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reviews/technical-decision`) {
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      if (!isTechnicalReviewer(activeSession)) { json(res, { error: "Technical reviewer access required" }, 403); return true; }
      const body = parseJson<{ caseId: string; action: "approve" | "redline"; note?: string }>(await readBody(req));
      const caseRecord = loadCaseRecord(body.caseId);
      if (!caseRecord) { json(res, { error: "Case not found" }, 404); return true; }
      const decision = submitTechnicalReviewDecision(caseRecord, reviewActor(activeSession), body.action, body.note, requestId);
      json(res, { ok: true, caseId: decision.caseRecord.caseId, reviewWorkflow: decision.caseRecord.reviewWorkflow, pending: buildAdminReviewItems("technical-review"), session: activeSession });
      return true;
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reviews/release`) {
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      if (!isQualityReviewer(activeSession)) { json(res, { error: "Quality reviewer access required" }, 403); return true; }
      const body = parseJson<{ caseId: string; password: string; otpCode?: string; note?: string }>(await readBody(req));
      reauthorizePublicUser(config, activeSession.user.userId, { password: body.password, otpCode: body.otpCode }, requestId);
      const caseRecord = loadCaseRecord(body.caseId);
      if (!caseRecord) { json(res, { error: "Case not found" }, 404); return true; }
      const released = releaseReviewedCase(caseRecord, reviewActor(activeSession), body.note, requestId);
      json(res, { ok: true, caseId: released.caseRecord.caseId, releaseStatus: released.caseRecord.interaction?.releaseStatus, releasedArtifactIds: released.releasedArtifactIds, pending: buildAdminReviewItems("quality-review"), session: activeSession });
      return true;
    }    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/feedback`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } const items = listProcedureFeedback("pending-review"); json(res, { ok: true, items, stats: { pending: items.length, approved: listProcedureFeedback("approved").length, rejected: listProcedureFeedback("rejected").length }, session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/feedback/decision`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ feedbackId: string; action: "approve" | "reject"; note?: string }>(await readBody(req)); const actor = activeSession.user.displayName || activeSession.user.email || activeSession.user.username || activeSession.user.userId; const item = reviewProcedureFeedback({ feedbackId: body.feedbackId, action: body.action, actor, note: body.note }, requestId); json(res, { ok: true, item, items: listProcedureFeedback("pending-review"), session: activeSession }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/profiles`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } json(res, { ok: true, items: listPilotProfiles(config), session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/profiles/update`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } const body = parseJson<{ profileId: string; status?: "active" | "suspended"; serviceTier?: "free" | "reviewed" | "enterprise"; reviewedOutputs?: boolean; artifactDownloadAccess?: boolean; displayName?: string; organization?: string }>(await readBody(req)); const profile = updatePilotProfileAdmin(config, body.profileId, body, requestId); json(res, { ok: true, profile, session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/transcribe`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!requesterId) { json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400); return true; } const body = parseJson<{ name?: string; mimeType?: string; contentBase64: string }>(await readBody(req)); const transcript = await transcribeAudioWithOpenAI(config, { ...body, requesterId }, requestId); json(res, { ok: true, transcript, session }); return true; }

    const libraryDetailMatch = pathname.match(/^\/internal\/cateo\/site\/library\/([^/]+)$/);
    if (libraryDetailMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const activeSession = requireSession(config, req, requesterId, requestId);
      const detail = loadProcedureLibraryDetail(decodeURIComponent(libraryDetailMatch[1]), activeSession.user.userId);
      if (!detail) { json(res, { error: "Procedure not found" }, 404); return true; }
      json(res, { ok: true, detail, session: activeSession });
      return true;
    }
    const adminCaseMatch = pathname.match(/^\/internal\/cateo\/site\/admin\/cases\/([^/]+)$/);
    if (adminCaseMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!hasReviewDeskAccess(session)) { json(res, { error: "Review access required" }, 403); return true; }
      const detail = loadAdminCaseDetail(decodeURIComponent(adminCaseMatch[1]));
      if (!detail) { json(res, { error: "Case not found" }, 404); return true; }
      json(res, { ok: true, detail, session });
      return true;
    }
    const adminArtifactMatch = pathname.match(/^\/internal\/cateo\/site\/admin\/artifacts\/([^/]+)$/);
    if (adminArtifactMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!hasReviewDeskAccess(session)) { json(res, { error: "Review access required" }, 403); return true; }
      const detail = loadAdminArtifactDetail(decodeURIComponent(adminArtifactMatch[1]));
      if (!detail) { json(res, { error: "Artifact not found" }, 404); return true; }
      json(res, { ok: true, detail, session });
      return true;
    }    const adminPartMatch = pathname.match(/^\/internal\/cateo\/site\/admin\/parts\/([^/]+)$/);
    if (adminPartMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const detail = loadAdminPartDetail(decodeURIComponent(adminPartMatch[1]));
      if (!detail) { json(res, { error: "Part not found" }, 404); return true; }
      json(res, { ok: true, detail, session });
      return true;
    }
    const conversationMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)$/);
    if (conversationMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const conversation = await syncConversationJobs(decodeURIComponent(conversationMatch[1]), requesterId);
      if (!conversation || !canAccess(conversation, viewer)) { json(res, { error: "Conversation not found" }, 404); return true; }
      json(res, { ok: true, conversation, session });
      return true;
    }
    const conversationStateMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)\/state$/);
    if (conversationStateMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const conversation = await syncConversationJobs(decodeURIComponent(conversationStateMatch[1]), requesterId);
      if (!conversation || !canAccess(conversation, viewer)) { json(res, { error: "Conversation not found" }, 404); return true; }
      json(res, { ok: true, state: buildConversationState(conversation, viewer), session });
      return true;
    }
    const conversationFollowUpMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)\/follow-up-context$/);
    if (conversationFollowUpMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const conversation = await syncConversationJobs(decodeURIComponent(conversationFollowUpMatch[1]), requesterId);
      if (!conversation || !canAccess(conversation, viewer)) { json(res, { error: "Conversation not found" }, 404); return true; }
      json(res, { ok: true, followUp: buildConversationFollowUpContext(conversation, viewer), session });
      return true;
    }
    const conversationCaseMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)\/case$/);
    if (conversationCaseMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const detail = loadConversationCaseDetail(decodeURIComponent(conversationCaseMatch[1]), viewer);
      if (!detail) { json(res, { error: "Case detail not found" }, 404); return true; }
      json(res, { ok: true, detail, session });
      return true;
    }
    const conversationReportMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)\/report$/);
    if (conversationReportMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      const payload = loadConversationTroubleshootingReportPackage(decodeURIComponent(conversationReportMatch[1]), viewer);
      if (!payload) { json(res, { error: "Troubleshooting report not found" }, 404); return true; }
      json(res, { ok: true, conversationId: payload.conversation.conversationId, caseId: payload.caseRecord.caseId, report: payload.reportPackage, feedback: listProcedureFeedbackForConversation(payload.conversation.conversationId), session });
      return true;
    }
    const conversationFeedbackMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)\/feedback$/);
    if (conversationFeedbackMatch) {
      const conversationId = decodeURIComponent(conversationFeedbackMatch[1]);
      const conversation = loadConversationRecord(conversationId);
      if (!conversation || !canAccess(conversation, viewer)) { json(res, { error: "Conversation not found" }, 404); return true; }
      const latestCaseId = [...conversation.messages].reverse().find((message) => message.role === "assistant" && message.caseId)?.caseId ?? conversation.caseIds.at(-1);
      const caseRecord = latestCaseId ? loadCaseRecord(latestCaseId) : null;
      if (!caseRecord) { json(res, { error: "No completed troubleshooting case is available for feedback." }, 404); return true; }
      if (req.method === "GET") { json(res, { ok: true, items: listProcedureFeedbackForConversation(conversationId), session }); return true; }
      if (req.method !== "POST") { json(res, { error: "GET or POST only" }, 405); return true; }
      const body = parseJson<{ rating: import("./types.js").CateoProcedureFeedbackRating; comments?: string; userAction?: "accept" | "reject"; requestReevaluation?: boolean }>(await readBody(req));
      const trimmedComments = body.comments?.trim();
      if (body.userAction === "reject" && !trimmedComments) { json(res, { error: "Explain why you are declining the AI-generated output before Cateo reevaluates it." }, 400); return true; }
      const comments = trimmedComments || (body.userAction === "accept" ? "Requester accepted the AI-generated troubleshooting output without requesting changes." : "Requester submitted procedure feedback.");
      const submitterName = session?.user.displayName || session?.user.email || session?.user.username || undefined;
      const submitterUsername = session?.user.username || undefined;
      const item = submitProcedureFeedback({ conversationId, caseId: caseRecord.caseId, artifactIds: caseRecord.artifacts, requesterId: viewer.requesterId, profileId: viewer.profileId, userId: viewer.userId, submitterName, submitterUsername, rating: body.rating, comments, userAction: body.userAction, requestReevaluation: body.requestReevaluation, reevaluationConversationId: conversationId, businessType: caseRecord.input.businessType, systemName: caseRecord.context.machine?.model || caseRecord.context.asset?.assetType || caseRecord.context.asset?.assetId, partNumber: caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber, issueType: caseRecord.context.issueType }, requestId);
      json(res, { ok: true, item, items: listProcedureFeedbackForConversation(conversationId), session });
      return true;
    }
    const saveMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)\/save$/);
    if (saveMatch) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const body = parseJson<{ saved: boolean }>(await readBody(req)); const conversation = setConversationSaved(decodeURIComponent(saveMatch[1]), viewer, !!body.saved); json(res, { ok: true, conversation }); return true; }
    const shareMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)\/share$/);
    if (shareMatch) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const share = createConversationShare(decodeURIComponent(shareMatch[1]), viewer); json(res, { ok: true, shareId: share.shareId, token: share.token, conversation: share.conversation }); return true; }
    const artifactMatch = pathname.match(/^\/internal\/cateo\/site\/artifacts\/([^/]+)$/);
    if (artifactMatch) {
      if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; }
      requireSession(config, req, requesterId, requestId);
      const artifact = loadArtifactRecord(decodeURIComponent(artifactMatch[1]));
      if (!artifact || !artifactVisible(artifact, viewer)) { json(res, { error: "Artifact not found" }, 404); return true; }
      json(res, { ok: true, artifact, projection: toArtifactProjection(artifact, viewer), session });
      return true;
    }
    const sharedMatch = pathname.match(/^\/internal\/cateo\/site\/shared\/([^/]+)$/);
    if (sharedMatch) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } const conversation = getSharedConversation(decodeURIComponent(sharedMatch[1])); if (!conversation) { json(res, { error: "Shared conversation not found" }, 404); return true; } json(res, { ok: true, conversation }); return true; }
  } catch (error) {
    if (error instanceof CateoPublicAuthError) { json(res, { error: error.message, code: error.code }, error.status); return true; }
    json(res, { error: error instanceof Error ? error.message : "Internal server error" }, 500); return true;
  }
  return false;
}

























