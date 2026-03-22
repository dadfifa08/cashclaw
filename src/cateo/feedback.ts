import crypto from "node:crypto";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { createRevision, loadArtifactRecord, loadCaseRecord, saveCaseRecord } from "./store.js";
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

export function listProcedureFeedback(status?: CateoProcedureFeedbackStatus): CateoProcedureFeedbackRecord[] {
  return loadStore().items
    .filter((item) => !status || item.status === status)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function listProcedureFeedbackForConversation(conversationId: string): CateoProcedureFeedbackRecord[] {
  return listProcedureFeedback().filter((item) => item.conversationId === conversationId);
}

export function submitProcedureFeedback(input: {
  conversationId: string;
  caseId: string;
  artifactIds: string[];
  requesterId?: string;
  profileId?: string;
  userId?: string;
  rating: CateoProcedureFeedbackRating;
  comments: string;
  businessType?: string;
  systemName?: string;
  partNumber?: string;
  issueType?: string;
}, requestId?: string): CateoProcedureFeedbackRecord {
  const now = new Date().toISOString();
  const store = loadStore();
  const record: CateoProcedureFeedbackRecord = {
    feedbackId: crypto.randomUUID(),
    conversationId: input.conversationId,
    caseId: input.caseId,
    artifactIds: unique(input.artifactIds),
    requesterId: input.requesterId,
    profileId: input.profileId,
    userId: input.userId,
    submittedAt: now,
    updatedAt: now,
    status: "pending-review",
    rating: input.rating,
    comments: normalizeComments(input.comments),
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
    ]),
  };

  store.items = [record, ...store.items].slice(0, 5000);
  store.updatedAt = now;
  saveStore(store);

  appendAuditEvent({
    actor: "server",
    category: "cateo_feedback",
    action: "submit",
    outcome: "pending-review",
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
    },
  });

  return record;
}

function buildDecisionNote(record: CateoProcedureFeedbackRecord, note: string | undefined): string {
  const details = [
    `Feedback ${record.feedbackId}`,
    `rating=${record.rating}`,
    record.partNumber ? `part=${record.partNumber}` : undefined,
    record.issueType ? `issue=${record.issueType}` : undefined,
    record.businessType ? `business=${record.businessType}` : undefined,
    `comments=${record.comments}`,
  ].filter(Boolean).join(" | ");
  return note?.trim() ? `${note.trim()} | ${details}` : details;
}

function reviseArtifactForFeedback(artifact: CateoArtifactRecord, record: CateoProcedureFeedbackRecord, actor: string, note: string | undefined, requestId?: string) {
  const latest = artifact.revisions.at(-1);
  if (!latest) {
    return null;
  }
  const now = new Date().toISOString();
  const metadata = latest.metadata
    ? {
        ...latest.metadata,
        taxonomyTags: unique([...latest.metadata.taxonomyTags, "feedback-reviewed", record.rating, record.issueType, record.businessType]),
        analytics: {
          ...latest.metadata.analytics,
          estimatedRevisionCount: latest.revisionNumber + 1,
        },
        documentControl: {
          ...latest.metadata.documentControl,
          changeReason: `Approved field feedback ${record.feedbackId}`,
        },
      }
    : latest.metadata;

  const updated = createRevision({
    record: artifact,
    createdBy: actor,
    summary: latest.summary,
    approvalState: latest.approvalState,
    content: latest.content,
    note: buildDecisionNote(record, note),
    signoffs: [
      ...latest.signoffs,
      {
        actor,
        role: "feedback-reviewer",
        meaning: "Approved controlled field feedback for traceability and future improvement.",
        state: latest.approvalState,
        signedAt: now,
      },
    ],
    provenance: {
      ...latest.provenance,
      createdAt: now,
      createdBy: actor,
      requestId,
    },
    metadata,
  });

  const revision = updated.revisions.at(-1);
  if (!revision) {
    return null;
  }
  return {
    artifactId: updated.artifactId,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
  };
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

  const releasedRevisionRefs = input.action === "approve"
    ? current.artifactIds
        .map((artifactId) => loadArtifactRecord(artifactId))
        .filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact))
        .map((artifact) => reviseArtifactForFeedback(artifact, current, input.actor, input.note, requestId))
        .filter((entry): entry is NonNullable<ReturnType<typeof reviseArtifactForFeedback>> => Boolean(entry))
    : [];

  const now = new Date().toISOString();
  const decision: CateoProcedureFeedbackDecision = {
    actor: input.actor,
    action: input.action,
    note: input.note?.trim() || undefined,
    decidedAt: now,
    releasedRevisionRefs,
  };

  const updated: CateoProcedureFeedbackRecord = {
    ...current,
    status: input.action === "approve" ? "approved" : "rejected",
    updatedAt: now,
    adminDecision: decision,
  };
  store.items[index] = updated;
  store.updatedAt = now;
  saveStore(store);

  const caseRecord = loadCaseRecord(current.caseId);
  if (caseRecord) {
    caseRecord.updatedAt = now;
    saveCaseRecord(caseRecord);
  }

  appendAuditEvent({
    actor: "operator",
    category: "cateo_feedback",
    action: input.action,
    outcome: "success",
    message: `Feedback ${current.feedbackId} ${input.action}d`,
    requestId,
    metadata: {
      feedbackId: current.feedbackId,
      caseId: current.caseId,
      actor: input.actor,
      releasedRevisionRefs,
    },
  });

  return updated;
}
