import http from "node:http";
import type { CashClawConfig } from "../config.js";
import { readRequestBody } from "../system/request_body.js";
import { buildCommandCenterSnapshot } from "./metrics.js";
import { fetchRedditReviewQueue, listAdminArtifacts, listAdminCases, listAdminConversations, listViewerCases, submitRedditReviewDecision } from "./admin_views.js";
import {
  beginPublicUserTwoFactorSetup,
  CateoPublicAuthError,
  changePublicUserPassword,
  confirmPublicUserTwoFactor,
  disablePublicUserTwoFactor,
  getPublicSession,
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
import { signOffCateoArtifact } from "./service.js";
import { loadArtifactRecord, loadCaseRecord, listArtifactCatalogRows, listCaseCatalogRows, saveCaseRecord } from "./store.js";
import { listPilotProfiles, updatePilotProfileAdmin } from "./profiles.js";
import type { CateoAssistInput, CateoAssistResult, CateoCaseRecord } from "./types.js";

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
function requestUrl(req: http.IncomingMessage) { return new URL(req.url ?? "/", "http://127.0.0.1"); }
async function getSession(config: CashClawConfig | null, req: http.IncomingMessage, requesterId: string | null, requestId: string) { return config ? getPublicSession(config, userSessionId(req), requesterId ?? undefined, requestId) : null; }
function trimPreview(text: string | undefined, max = 160) { const normalized = text?.replace(/\s+/g, " ").trim(); if (!normalized) return undefined; return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`; }
function maskPendingEngineerReviewResult(result: CateoAssistResult): CateoAssistResult { return { ...result, interaction: { ...result.interaction, message: "Cateo assembled the requested engineering package and sent it to the engineer review bucket. It will be released to the customer profile after password-backed admin sign-off.", highlights: ["The requested artifact package was generated and fully logged.", "A human engineer review is required before customer release."], nextActions: ["Wait for engineer sign-off before downloading or acting on the final released package."], releaseStatus: "pending-engineer-review", requiresEngineerReview: true } }; }
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

function buildAdminReviewItems(): AdminReviewItem[] {
  return listCaseCatalogRows()
    .map((row) => loadCaseRecord(row.caseId))
    .filter((record): record is CateoCaseRecord => Boolean(record))
    .map<AdminReviewItem | null>((record) => {
      const interaction = record.interaction;
      if (!interaction) return null;
      const artifacts = record.artifacts
        .map((artifactId) => loadArtifactRecord(artifactId))
        .filter((artifact): artifact is NonNullable<ReturnType<typeof loadArtifactRecord>> => Boolean(artifact));
      const draftArtifacts = artifacts.filter((artifact) => artifact.revisions.at(-1)?.approvalState === "draft");
      const approvedArtifacts = artifacts.filter((artifact) => artifact.revisions.at(-1)?.approvalState === "approved");
      const pending = interaction.releaseStatus === "pending-engineer-review" || draftArtifacts.length > 0;
      if (!pending) return null;
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
function releaseReviewedCase(caseRecord: CateoCaseRecord, actor: string, note: string | undefined, requestId: string): { caseRecord: CateoCaseRecord; releasedArtifactIds: string[] } {
  const interaction = caseRecord.interaction;
  if (!interaction) {
    throw new Error(`Case ${caseRecord.caseId} does not have a releasable interaction payload.`);
  }
  const releasedArtifactIds: string[] = [];
  for (const artifactId of caseRecord.artifacts) {
    const artifact = loadArtifactRecord(artifactId);
    const latest = artifact?.revisions.at(-1);
    if (!artifact || !latest || latest.approvalState === "approved") continue;
    signOffCateoArtifact({
      artifactId,
      actor,
      role: "admin-approver",
      meaning: "Engineer review and controlled customer release",
      state: "approved",
      note: note?.trim() || `Approved for customer release for case ${caseRecord.caseId}`,
    }, { requestId });
    releasedArtifactIds.push(artifactId);
  }
  caseRecord.interaction = { ...interaction, releaseStatus: "available", requiresEngineerReview: false };
  caseRecord.updatedAt = new Date().toISOString();
  saveCaseRecord(caseRecord);
  if (caseRecord.conversationId) {
    const conversation = loadConversationRecord(caseRecord.conversationId);
    if (conversation) {
      const assistant = [...conversation.messages].reverse().find((message) => message.role === "assistant" && message.caseId === caseRecord.caseId);
      if (assistant) {
        assistant.text = interaction.message;
        assistant.highlights = interaction.highlights;
        assistant.nextActions = interaction.nextActions;
        assistant.confidence = interaction.confidence;
        assistant.artifactCount = interaction.artifactCount;
        assistant.error = undefined;
        assistant.status = "completed";
        assistant.updatedAt = Date.now();
        conversation.updatedAt = assistant.updatedAt;
        conversation.lastMessagePreview = trimPreview(interaction.message, 160);
        saveConversationRecord(conversation);
      }
    }
  }
  return { caseRecord, releasedArtifactIds };
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
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/overview`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const items = listConversationSummaries({ requesterId: requesterId ?? undefined, userId: activeSession.user.userId, admin: false }).slice(0, MAX_CONVERSATIONS); json(res, { ok: true, session: activeSession, profile: activeSession.user.profile, stats: { conversations: items.length, saved: items.filter((entry) => entry.saved).length, shared: items.filter((entry) => Boolean(entry.shareId)).length, pending: items.reduce((sum, entry) => sum + entry.pendingCount, 0) }, conversations: items, tokenHistory: activeSession.user.profile?.history ?? [] }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); json(res, { ok: true, session: activeSession, settings: { displayName: activeSession.user.displayName, organization: activeSession.user.organization, email: activeSession.user.email, username: activeSession.user.username, preferences: activeSession.user.preferences, security: activeSession.user.security } }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/profile`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ displayName?: string; organization?: string; email?: string; username?: string; timezone?: string; responseDetail?: "balanced" | "concise" | "detailed"; emailUpdates?: boolean }>(await readBody(req)); const user = updatePublicUserProfile(config, activeSession.user.userId, body, requestId); json(res, { ok: true, session: { ...activeSession, user } }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/password`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ currentPassword: string; newPassword: string }>(await readBody(req)); const user = changePublicUserPassword(config, activeSession.user.userId, body, requestId); json(res, { ok: true, session: { ...activeSession, user } }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/2fa/setup`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const setup = beginPublicUserTwoFactorSetup(config, activeSession.user.userId, requestId); json(res, { ok: true, session: activeSession, setup }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/2fa/confirm`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ code: string }>(await readBody(req)); const confirmed = confirmPublicUserTwoFactor(config, activeSession.user.userId, body.code, requestId); json(res, { ok: true, session: { ...activeSession, user: confirmed.user }, recoveryCodes: confirmed.recoveryCodes }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/me/settings/2fa/disable`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ code: string }>(await readBody(req)); const user = disablePublicUserTwoFactor(config, activeSession.user.userId, body.code, requestId); json(res, { ok: true, session: { ...activeSession, user } }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/conversations`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } const items = listConversationSummaries(viewer).slice(0, MAX_CONVERSATIONS); const synced = []; for (const item of items) { const record = await syncConversationJobs(item.conversationId, requesterId); synced.push(record ? { ...item, pendingCount: record.messages.filter((m) => m.role === "assistant" && (m.status === "queued" || m.status === "running")).length, updatedAt: record.updatedAt, lastMessagePreview: record.lastMessagePreview, title: record.title, titleSource: record.titleSource, saved: record.saved, shareId: record.shareId, messageCount: record.messages.length } : item); } json(res, { ok: true, items: synced, session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/conversations/queue-turn`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!requesterId) { json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400); return true; } const body = parseJson<{ conversationId?: string; jobId: string; promptText: string; input: import("./types.js").CateoAssistInput }>(await readBody(req)); const queued = queueConversationTurn({ conversationId: body.conversationId, viewer, requesterId, ownerUserId: session?.user.userId, profileId: session?.user.profileId, jobId: body.jobId, input: body.input, promptText: body.promptText }); json(res, { ok: true, conversation: queued.summary, assistantMessageId: queued.assistantMessage.messageId, userMessageId: queued.userMessage.messageId }); return true; }
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
      if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; }
      const filters = {
        q: url.searchParams.get("q")?.trim() || undefined,
        productOffering: url.searchParams.get("productOffering")?.trim() || undefined,
        releaseStatus: url.searchParams.get("releaseStatus")?.trim() || undefined,
        serviceTier: url.searchParams.get("serviceTier")?.trim() || undefined,
        workflowMode: url.searchParams.get("workflowMode")?.trim() || undefined,
        taskClass: url.searchParams.get("taskClass")?.trim() || undefined,
        partNumber: url.searchParams.get("partNumber")?.trim() || undefined,
      };
      const items = listAdminCases(filters);
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
    }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/conversations`) {
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
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reddit/reviews`) {
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
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/overview`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } json(res, { ok: true, metrics: buildCommandCenterSnapshot(), users: listPublicUsers(config).slice(0, MAX_USERS), profiles: listPilotProfiles(config).slice(0, MAX_USERS), conversations: listConversationSummaries({ admin: true }).slice(0, MAX_CONVERSATIONS), session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reviews`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } const items = buildAdminReviewItems(); json(res, { ok: true, items, stats: { pendingCases: items.length, pendingArtifacts: items.reduce((sum, item) => sum + item.draftArtifactCount, 0), enterpriseCases: items.filter((item) => item.serviceTier === "enterprise").length, reviewedTierCases: items.filter((item) => item.serviceTier === "reviewed").length }, session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/reviews/release`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } const activeSession = requireSession(config, req, requesterId, requestId); const body = parseJson<{ caseId: string; password: string; otpCode?: string; note?: string }>(await readBody(req)); reauthorizePublicUser(config, activeSession.user.userId, { password: body.password, otpCode: body.otpCode }, requestId); const caseRecord = loadCaseRecord(body.caseId); if (!caseRecord) { json(res, { error: "Case not found" }, 404); return true; } const actor = activeSession.user.displayName || activeSession.user.email || activeSession.user.username || activeSession.user.userId; const released = releaseReviewedCase(caseRecord, actor, body.note, requestId); json(res, { ok: true, caseId: released.caseRecord.caseId, releaseStatus: released.caseRecord.interaction?.releaseStatus, releasedArtifactIds: released.releasedArtifactIds, pending: buildAdminReviewItems(), session: activeSession }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/profiles`) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } json(res, { ok: true, items: listPilotProfiles(config), session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/admin/profiles/update`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!isAdmin(session)) { json(res, { error: "Admin access required" }, 403); return true; } const body = parseJson<{ profileId: string; status?: "active" | "suspended"; serviceTier?: "free" | "reviewed" | "enterprise"; reviewedOutputs?: boolean; artifactDownloadAccess?: boolean; displayName?: string; organization?: string }>(await readBody(req)); const profile = updatePilotProfileAdmin(config, body.profileId, body, requestId); json(res, { ok: true, profile, session }); return true; }
    if (pathname === `${CATEO_SITE_PUBLIC_PREFIX}/transcribe`) { if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return true; } if (!requesterId) { json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400); return true; } const body = parseJson<{ name?: string; mimeType?: string; contentBase64: string }>(await readBody(req)); const transcript = await transcribeAudioWithOpenAI(config, { ...body, requesterId }, requestId); json(res, { ok: true, transcript, session }); return true; }

    const conversationMatch = pathname.match(/^\/internal\/cateo\/site\/conversations\/([^/]+)$/);
    if (conversationMatch) { if (req.method !== "GET") { json(res, { error: "GET only" }, 405); return true; } const conversation = await syncConversationJobs(decodeURIComponent(conversationMatch[1]), requesterId); if (!conversation || !canAccess(conversation, viewer)) { json(res, { error: "Conversation not found" }, 404); return true; } json(res, { ok: true, conversation, session }); return true; }
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









