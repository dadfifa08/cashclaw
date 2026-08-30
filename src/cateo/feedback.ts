import crypto from "node:crypto";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { loadArtifactRecord, loadCaseRecord, saveCaseRecord } from "./store.js";
import { recordCustomerRejection } from "./release_policy.js";
import type {
  CateoArtifactRecord,
  CateoProcedureFeedbackDecision,
  CateoProcedureFeedbackRating,
  CateoProcedureFeedbackRecord,
  CateoProcedureFeedbackStatus,
} from "./types.js";

const FEEDBACK_DB_VERSION = "cateo-feedback-v1";

interface FeedbackStoreFile {
  version: string;
  updatedAt: string;
  items: CateoProcedureFeedbackRecord[];
}

function feedbackPath(): string {
  return path.join(getConfigDir(), "cateo", "db", "feedback.json");
}

function loadStore(): FeedbackStoreFile {
  return readProtectedJson<FeedbackStoreFile>(feedbackPath(), {
    version: FEEDBACK_DB_VERSION,
    updatedAt: new Date(0).toISOString(),
    items: [],
  });
}

function saveStore(file: FeedbackStoreFile): void {
  writeProtectedJson(feedbackPath(), file);
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalizeComments(comments: string): string {
  const trimmed = comments.trim();
  if (!trimmed) {
    throw new Error("Feedback comments are required.");
  }
  return trimmed.slice(0, 4000);
}

function contributorLabel(record: CateoProcedureFeedbackRecord): string | undefined {
  if (record.submitterName && record.submitterUsername) {
    const normalizedName = record.submitterName.trim().toLowerCase();
    const normalizedUsername = record.submitterUsername.trim().toLowerCase();
    return normalizedName === normalizedUsername ? record.submitterName : `${record.submitterName} (@${record.submitterUsername})`;
  }
  return record.submitterName || (record.submitterUsername ? `@${record.submitterUsername}` : undefined);
}

export function listProcedureFeedback(status?: CateoProcedureFeedbackStatus): CateoProcedureFeedbackRecord[] {
  return loadStore().items
    .filter((item) => !status || item.status === status)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function listProcedureFeedbackForConversation(conversationId: string): CateoProcedureFeedbackRecord[] {
  return listProcedureFeedback().filter((item) => item.conversationId === conversationId);
}

function finalizeFeedbackRecord(args: {
  current: CateoProcedureFeedbackRecord;
  action: "approve" | "reject";
  actor: string;
  note?: string;
  requestId?: string;
}): CateoProcedureFeedbackRecord {
  const { current, action, actor, note, requestId } = args;
  const releasedRevisionRefs: CateoProcedureFeedbackDecision["releasedRevisionRefs"] = [];

  const now = new Date().toISOString();
  const decision: CateoProcedureFeedbackDecision = {
    actor,
    action,
    note: note?.trim() || undefined,
    decidedAt: now,
    releasedRevisionRefs,
  };

  const updated: CateoProcedureFeedbackRecord = {
    ...current,
    status: action === "approve" ? "approved" : "rejected",
    updatedAt: now,
    adminDecision: decision,
  };

  const caseRecord = loadCaseRecord(current.caseId);
  if (caseRecord) {
    caseRecord.updatedAt = now;
    saveCaseRecord(caseRecord);
  }

  appendAuditEvent({
    actor: action === "approve" ? "system" : "operator",
    category: "cateo_feedback",
    action,
    outcome: "success",
    message: `Feedback ${current.feedbackId} ${action}d`,
    requestId,
    metadata: {
      feedbackId: current.feedbackId,
      caseId: current.caseId,
      actor,
      releasedRevisionRefs,
    },
  });

  return updated;
}

export function submitProcedureFeedback(input: {
  conversationId: string;
  caseId: string;
  artifactIds: string[];
  requesterId?: string;
  profileId?: string;
  userId?: string;
  submitterName?: string;
  submitterUsername?: string;
  rating: CateoProcedureFeedbackRating;
  comments: string;
  userAction?: "accept" | "reject";
  requestReevaluation?: boolean;
  reevaluationConversationId?: string;
  businessType?: string;
  systemName?: string;
  partNumber?: string;
  issueType?: string;
  idempotencyKey?: string;
}, requestId?: string): CateoProcedureFeedbackRecord {
  const now = new Date().toISOString();
  const store = loadStore();
  const idempotencyKey = input.idempotencyKey?.trim();
  const existing = idempotencyKey ? store.items.find((item) => item.idempotencyKey === idempotencyKey && item.conversationId === input.conversationId) : undefined;
  if (existing) {
    return existing;
  }
  const baseRecord: CateoProcedureFeedbackRecord = {
    feedbackId: crypto.randomUUID(),
    idempotencyKey,
    conversationId: input.conversationId,
    caseId: input.caseId,
    artifactIds: unique(input.artifactIds),
    requesterId: input.requesterId,
    profileId: input.profileId,
    userId: input.userId,
    submitterName: input.submitterName?.trim() || undefined,
    submitterUsername: input.submitterUsername?.trim() || undefined,
    submittedAt: now,
    updatedAt: now,
    status: "pending-review",
    rating: input.rating,
    comments: normalizeComments(input.comments),
    userAction: input.userAction,
    requestReevaluation: input.requestReevaluation,
    reevaluationQueuedAt: input.requestReevaluation ? now : undefined,
    reevaluationConversationId: input.requestReevaluation ? input.reevaluationConversationId || input.conversationId : undefined,
    businessType: input.businessType as CateoProcedureFeedbackRecord["businessType"],
    systemName: input.systemName?.trim() || undefined,
    partNumber: input.partNumber?.trim() || undefined,
    issueType: input.issueType?.trim() || undefined,
    feedbackTags: unique([
      input.rating,
      input.businessType,
      input.systemName,
      input.partNumber,
      input.issueType,
      input.userAction,
      input.requestReevaluation ? "reevaluation-requested" : undefined,
      "crowdsource-feedback",
      "ai-generated-initial-output",
    ]),
  };

  const record = baseRecord;
  if (record.userAction === "reject") {
    const caseRecord = loadCaseRecord(record.caseId);
    if (caseRecord) {
      const artifacts = record.artifactIds
        .map((artifactId) => loadArtifactRecord(artifactId))
        .filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact));
      recordCustomerRejection({
        caseRecord,
        artifacts,
        actorId: record.userId || record.requesterId || "anonymous-customer",
        actorDisplayName: contributorLabel(record) || "Customer",
        reason: record.comments,
        idempotencyKey: idempotencyKey || `feedback:${record.feedbackId}`,
      });
      if (caseRecord.interaction) {
        caseRecord.interaction = { ...caseRecord.interaction, releaseStatus: "pending-engineer-review", requiresEngineerReview: true };
      }
      saveCaseRecord(caseRecord);
    }
  }

  store.items = [record, ...store.items].slice(0, 5000);
  store.updatedAt = now;
  saveStore(store);

  appendAuditEvent({
    actor: "server",
    category: "cateo_feedback",
    action: "submit",
    outcome: record.status,
    message: `Procedure feedback ${record.feedbackId} submitted for case ${record.caseId}`,
    requestId,
    metadata: {
      feedbackId: record.feedbackId,
      conversationId: record.conversationId,
      caseId: record.caseId,
      artifactIds: record.artifactIds,
      rating: record.rating,
      businessType: record.businessType,
      partNumber: record.partNumber,
      issueType: record.issueType,
      requestReevaluation: record.requestReevaluation,
    },
  });

  return record;
}

export function reviewProcedureFeedback(input: {
  feedbackId: string;
  action: "approve" | "reject";
  actor: string;
  note?: string;
}, requestId?: string): CateoProcedureFeedbackRecord {
  const store = loadStore();
  const index = store.items.findIndex((item) => item.feedbackId === input.feedbackId);
  if (index === -1) {
    throw new Error("Feedback item not found.");
  }

  const current = store.items[index];
  if (current.status !== "pending-review") {
    throw new Error("Feedback item has already been reviewed.");
  }

  const updated = finalizeFeedbackRecord({
    current,
    action: input.action,
    actor: input.actor,
    note: input.note,
    requestId,
  });

  store.items[index] = updated;
  store.updatedAt = updated.updatedAt;
  saveStore(store);
  return updated;
}
