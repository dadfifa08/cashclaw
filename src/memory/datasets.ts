import path from "node:path";
import type { CateoInteractionCheckpoint, CateoUsageSummary } from "../cateo/types.js";
import type { CateoRuntimeModelInfo } from "../llm/runtime.js";
import { getConfigDir, loadConfig } from "../config.js";
import { redactText } from "../security/redact.js";
import { appendProtectedText, readProtectedText, writeProtectedText } from "../security/secure_store.js";

const MAX_LINES: Record<string, number> = {
  "task_interactions.jsonl": 500,
  "study_sessions.jsonl": 500,
  "cateo_interactions.jsonl": 1000,
};

const MAX_AGE_MS: Record<string, number> = {
  "task_interactions.jsonl": 30 * 24 * 60 * 60 * 1000,
  "study_sessions.jsonl": 30 * 24 * 60 * 60 * 1000,
  "cateo_interactions.jsonl": 90 * 24 * 60 * 60 * 1000,
};

function getDatasetDir(): string {
  return path.join(getConfigDir(), "datasets");
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistDatasets ?? false;
}

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  const trimmed = redactText(value.trim());
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function getRecordTimestamp(record: unknown): number | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const timestamp = (record as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function trimJsonl(filePath: string, filename: string): void {
  const maxLines = MAX_LINES[filename] ?? 500;
  if (maxLines <= 0) return;
  const raw = readProtectedText(filePath);
  if (!raw) return;

  const originalLines = raw.split(/\r?\n/).filter(Boolean);
  const maxAgeMs = MAX_AGE_MS[filename] ?? 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const retained = originalLines
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        const timestamp = getRecordTimestamp(parsed);
        return timestamp && timestamp >= cutoff ? line : null;
      } catch {
        return null;
      }
    })
    .filter((line): line is string => Boolean(line));

  const trimmed = retained.slice(-maxLines);
  if (trimmed.length === 0) {
    writeProtectedText(filePath, "");
    return;
  }

  if (trimmed.length !== originalLines.length) {
    writeProtectedText(filePath, `${trimmed.join("\n")}\n`);
  }
}

function appendJsonl(filename: string, record: unknown): void {
  if (!shouldPersist()) return;
  const filePath = path.join(getDatasetDir(), filename);
  appendProtectedText(filePath, `${JSON.stringify(record)}\n`);
  trimJsonl(filePath, filename);
}

export interface TaskInteractionRecord {
  schemaVersion: "1.0";
  kind: "task_interaction";
  timestamp: number;
  taskId: string;
  agentId: string;
  status: string;
  task: string;
  category?: string;
  clientAddress: string;
  quotedPriceWei?: string;
  revisionCount?: number;
  messages?: Array<{
    role: string;
    content: string;
    timestamp?: number;
  }>;
  files?: Array<{
    key?: string;
    name: string;
    size: number;
    uploadedAt?: number;
  }>;
  resultRaw?: string;
  ratedScore?: number;
  ratedComment?: string;
  modelProvider?: string;
  modelName?: string;
  toolCalls?: Array<{
    name: string;
    success: boolean;
  }>;
  orchestrationRoute?: {
    taskClass: string;
    artifactKind: string;
    complexity: string;
    usedChallenger: boolean;
    usedStructure: boolean;
  };
  orchestrationStages?: Array<{
    role: string;
    status: string;
  }>;
  toolScope?: string[];
  activeSkillIds?: string[];
  capabilityTags?: string[];
}

export interface StudySessionRecord {
  schemaVersion: "1.0";
  kind: "study_session";
  timestamp: number;
  topic: string;
  specialty: string;
  insight: string;
  source: string;
  tokensUsed: number;
  modelProvider?: string;
  modelName?: string;
}

export interface CateoInteractionRecord {
  schemaVersion: "1.0";
  kind: "cateo_interaction";
  timestamp: number;
  caseId: string;
  runId: string;
  profileId?: string;
  requesterId?: string;
  userId?: string;
  conversationId?: string;
  organization?: string;
  emailHash?: string;
  taskClass: string;
  assetId?: string;
  workOrderId?: string;
  prompt: string;
  errorCode?: string;
  observedConditions?: string[];
  attachmentCount: number;
  requestedArtifacts: string[];
  activeSkillIds?: string[];
  activeAdapterIds?: string[];
  capabilityTags?: string[];
  artifactTypes: string[];
  interactionMessage: string;
  highlights: string[];
  nextActions: string[];
  confidence: string;
  contextSummary: string[];
  checkpoints: Array<{
    stage: CateoInteractionCheckpoint["stage"];
    status: CateoInteractionCheckpoint["status"];
    summary: string;
  }>;
  modelsUsed: CateoRuntimeModelInfo[];
  usage?: CateoUsageSummary;
  executiveSummary?: string;
  rootCauseStatement?: string;
  reviewerSummary?: string;
}

function sanitizeTaskInteraction(record: TaskInteractionRecord): TaskInteractionRecord {
  return {
    ...record,
    task: truncateText(record.task, 1200) ?? "",
    category: truncateText(record.category, 120),
    messages: record.messages?.slice(-8).map((message) => ({
      ...message,
      content: truncateText(message.content, 600) ?? "",
    })),
    files: record.files?.slice(0, 12),
    resultRaw: truncateText(record.resultRaw, 4000),
    ratedComment: truncateText(record.ratedComment, 500),
    toolCalls: record.toolCalls?.slice(0, 20),
    orchestrationStages: record.orchestrationStages?.slice(0, 8),
    toolScope: record.toolScope?.slice(0, 20),
    activeSkillIds: record.activeSkillIds?.slice(0, 16),
    capabilityTags: record.capabilityTags?.slice(0, 24),
  };
}

function sanitizeStudySession(record: StudySessionRecord): StudySessionRecord {
  return {
    ...record,
    specialty: truncateText(record.specialty, 120) ?? "general",
    insight: truncateText(record.insight, 2000) ?? "",
    source: truncateText(record.source, 240) ?? "unknown",
  };
}

function sanitizeCateoInteraction(record: CateoInteractionRecord): CateoInteractionRecord {
  return {
    ...record,
    organization: truncateText(record.organization, 160),
    prompt: truncateText(record.prompt, 2400) ?? "",
    errorCode: truncateText(record.errorCode, 120),
    observedConditions: record.observedConditions?.slice(0, 12).map((entry) => truncateText(entry, 240) ?? "").filter(Boolean),
    requestedArtifacts: record.requestedArtifacts.slice(0, 8),
    activeSkillIds: record.activeSkillIds?.slice(0, 16),
    activeAdapterIds: record.activeAdapterIds?.slice(0, 16),
    capabilityTags: record.capabilityTags?.slice(0, 24),
    artifactTypes: record.artifactTypes.slice(0, 12),
    interactionMessage: truncateText(record.interactionMessage, 4000) ?? "",
    highlights: record.highlights.slice(0, 10).map((entry) => truncateText(entry, 400) ?? "").filter(Boolean),
    nextActions: record.nextActions.slice(0, 10).map((entry) => truncateText(entry, 400) ?? "").filter(Boolean),
    contextSummary: record.contextSummary.slice(0, 12).map((entry) => truncateText(entry, 300) ?? "").filter(Boolean),
    checkpoints: record.checkpoints.slice(0, 16).map((checkpoint) => ({
      stage: checkpoint.stage,
      status: checkpoint.status,
      summary: truncateText(checkpoint.summary, 300) ?? "",
    })),
    executiveSummary: truncateText(record.executiveSummary, 800),
    rootCauseStatement: truncateText(record.rootCauseStatement, 800),
    reviewerSummary: truncateText(record.reviewerSummary, 800),
  };
}

export function appendTaskInteraction(record: TaskInteractionRecord): void {
  appendJsonl("task_interactions.jsonl", sanitizeTaskInteraction(record));
}

export function appendStudySession(record: StudySessionRecord): void {
  appendJsonl("study_sessions.jsonl", sanitizeStudySession(record));
}

export function appendCateoInteraction(record: CateoInteractionRecord): void {
  appendJsonl("cateo_interactions.jsonl", sanitizeCateoInteraction(record));
}




