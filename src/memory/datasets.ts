import path from "node:path";
import { getConfigDir, loadConfig } from "../config.js";
import { redactText } from "../security/redact.js";
import { appendProtectedText, readProtectedText, writeProtectedText } from "../security/secure_store.js";

const MAX_LINES: Record<string, number> = {
  "task_interactions.jsonl": 500,
  "study_sessions.jsonl": 500,
};

function getDatasetDir(): string {
  return path.join(getConfigDir(), "datasets");
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistDatasets ?? true;
}

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  const trimmed = redactText(value.trim());
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function trimJsonl(filePath: string, maxLines: number): void {
  if (maxLines <= 0) return;
  const raw = readProtectedText(filePath);
  if (!raw) return;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) return;

  writeProtectedText(filePath, `${lines.slice(-maxLines).join("\n")}\n`);
}

function appendJsonl(filename: string, record: unknown): void {
  if (!shouldPersist()) return;
  const filePath = path.join(getDatasetDir(), filename);
  appendProtectedText(filePath, `${JSON.stringify(record)}\n`);
  trimJsonl(filePath, MAX_LINES[filename] ?? 500);
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
    model?: string;
  }>;
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

export function appendTaskInteraction(record: TaskInteractionRecord): void {
  appendJsonl("task_interactions.jsonl", sanitizeTaskInteraction(record));
}

export function appendStudySession(record: StudySessionRecord): void {
  appendJsonl("study_sessions.jsonl", sanitizeStudySession(record));
}
