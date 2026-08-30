import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { getCateoRawNotesDir } from "./store.js";
import { accumulateConversationMetadata, attachCaseMetadataAndDatasetCandidate } from "./case_metadata.js";
import { loadArtifactRecord, loadCaseRecord, saveCaseRecord } from "./store.js";
import { isCurrentContentReleased } from "./release_policy.js";
import type { CateoArtifactRecord, CateoAssistInput, CateoAssistResult, CateoConversationContext, CateoConversationTurnKind, CateoDynamicCaseMetadata, CateoInteractionArtifactPreview, CateoInteractionCheckpoint, CateoInteractionSection, CateoResponseDetail } from "./types.js";

const CONV_DB = "cateo-conversations-v1";
const SHARE_DB = "cateo-conversation-shares-v1";

export interface CateoConversationAttachmentRef { name: string; kind?: string; mimeType?: string; sizeBytes?: number; }
export interface CateoConversationMessageRecord {
  messageId: string;
  role: "user" | "assistant" | "system";
  kind?: CateoConversationTurnKind;
  clientMessageId?: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  status: "queued" | "running" | "completed" | "failed";
  jobId?: string;
  caseId?: string;
  artifactIds?: string[];
  highlights?: string[];
  nextActions?: string[];
  confidence?: "low" | "medium" | "high";
  artifactCount?: number;
  detailLevel?: CateoResponseDetail;
  sections?: CateoInteractionSection[];
  artifactPreviews?: CateoInteractionArtifactPreview[];
  checkpoints: CateoInteractionCheckpoint[];
  attachments?: CateoConversationAttachmentRef[];
  error?: string;
}
export interface CateoConversationRecord {
  conversationId: string;
  ownerUserId?: string;
  requesterId: string;
  profileId?: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  titleSource: "system" | "prompt" | "asset" | "part" | "artifact";
  saved: boolean;
  shareId?: string;
  lastMessagePreview?: string;
  caseIds: string[];
  artifactIds: string[];
  messages: CateoConversationMessageRecord[];
  dynamicMetadata?: CateoDynamicCaseMetadata;
}
export interface CateoConversationSummary {
  conversationId: string;
  ownerUserId?: string;
  requesterId: string;
  profileId?: string;
  title: string;
  titleSource: CateoConversationRecord["titleSource"];
  saved: boolean;
  shareId?: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
  messageCount: number;
  pendingCount: number;
}
interface ConvFile { version: string; updatedAt: string; rows: CateoConversationSummary[]; }
interface ShareRec { shareId: string; token: string; conversationId: string; createdAt: number; createdByUserId?: string; revokedAt?: number; }
interface ShareFile { version: string; updatedAt: string; rows: ShareRec[]; }
interface Viewer { requesterId?: string; userId?: string; admin?: boolean; }

const convDir = () => path.join(getConfigDir(), "cateo", "conversations");
const dbDir = () => path.join(getConfigDir(), "cateo", "db");
const convPath = (id: string) => path.join(convDir(), `${id}.json`);
const catalogPath = () => path.join(dbDir(), "conversations.json");
const sharePath = () => path.join(dbDir(), "conversation_shares.json");
const rawNotesDir = () => getCateoRawNotesDir();
const rawNotePath = (conversationId: string, messageId: string, createdAt: number, role: string) => path.join(rawNotesDir(), conversationId, `${String(createdAt)}-${role}-${messageId}.json`);
const loadCatalog = () => readProtectedJson<ConvFile>(catalogPath(), { version: CONV_DB, updatedAt: new Date(0).toISOString(), rows: [] });
const saveCatalog = (file: ConvFile) => writeProtectedJson(catalogPath(), file);
const loadShares = () => readProtectedJson<ShareFile>(sharePath(), { version: SHARE_DB, updatedAt: new Date(0).toISOString(), rows: [] });
const saveShares = (file: ShareFile) => writeProtectedJson(sharePath(), file);
const unique = (values: Array<string | undefined | null>) => [...new Set(values.map((v) => v?.trim()).filter((v): v is string => Boolean(v)))];
const trunc = (text?: string, max = 120) => { const v = text?.replace(/\s+/g, " ").trim(); if (!v) return undefined; return v.length <= max ? v : `${v.slice(0, Math.max(0, max - 3)).trimEnd()}...`; };
function persistRawNote(payload: { conversationId: string; messageId: string; createdAt: number; role: "user" | "assistant" | "system"; title: string; text: string; status: string; caseId?: string; artifactIds?: string[]; input?: CateoAssistInput; error?: string; highlights?: string[]; nextActions?: string[]; detailLevel?: CateoResponseDetail; sections?: CateoInteractionSection[]; artifactPreviews?: CateoInteractionArtifactPreview[] }) {
  const filePath = rawNotePath(payload.conversationId, payload.messageId, payload.createdAt, payload.role);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeProtectedJson(filePath, {
    conversationId: payload.conversationId,
    messageId: payload.messageId,
    createdAt: payload.createdAt,
    role: payload.role,
    title: payload.title,
    text: payload.text,
    status: payload.status,
    caseId: payload.caseId,
    artifactIds: payload.artifactIds ?? [],
    highlights: payload.highlights ?? [],
    nextActions: payload.nextActions ?? [],
    detailLevel: payload.detailLevel,
    sections: payload.sections ?? [],
    artifactPreviews: payload.artifactPreviews ?? [],
    error: payload.error,
    input: payload.input ?? null,
  });
}
const loadConversationRecord = (id: string) => readProtectedJson<CateoConversationRecord | null>(convPath(id), null);
export { loadConversationRecord };
function summary(record: CateoConversationRecord): CateoConversationSummary { return { conversationId: record.conversationId, ownerUserId: record.ownerUserId, requesterId: record.requesterId, profileId: record.profileId, title: record.title, titleSource: record.titleSource, saved: record.saved, shareId: record.shareId, createdAt: record.createdAt, updatedAt: record.updatedAt, lastMessagePreview: record.lastMessagePreview, messageCount: record.messages.length, pendingCount: record.messages.filter((m) => m.role === "assistant" && (m.status === "queued" || m.status === "running")).length }; }
function canSee(record: CateoConversationRecord, viewer: Viewer) { if (viewer.admin) return true; if (viewer.userId) return record.ownerUserId === viewer.userId || (!record.ownerUserId && viewer.requesterId && record.requesterId === viewer.requesterId); return Boolean(viewer.requesterId && record.requesterId === viewer.requesterId); }
function promptTitle(input: CateoAssistInput) { const asset = input.asset?.assetId?.trim(); if (asset) return { title: asset, source: "asset" as const }; const model = [input.machine?.manufacturer, input.machine?.model].filter(Boolean).join(" ").trim(); if (model) return { title: trunc(model, 64) ?? "Cateo conversation", source: "asset" as const }; const text = trunc(input.title?.trim() || input.symptomDescription?.trim() || input.query?.trim(), 64) ?? "Cateo conversation"; return { title: text, source: "prompt" as const }; }
function resultTitle(result: CateoAssistResult, fallback: string) { const parts = result.artifacts.find((artifact) => artifact.artifactType === "parts-tools-list")?.revisions.at(-1)?.content as { parts?: Array<{ sku?: string; description?: string }> } | undefined; const part = parts?.parts?.[0]; const label = [part?.sku, part?.description].filter(Boolean).join(" ").trim(); if (label) return { title: trunc(label, 64) ?? fallback, source: "part" as const }; if (result.interaction.conversationTitle?.trim()) return { title: trunc(result.interaction.conversationTitle, 64) ?? fallback, source: "artifact" as const }; if (result.context.asset?.assetId?.trim()) return { title: result.context.asset.assetId, source: "asset" as const }; return { title: fallback, source: "prompt" as const }; }
export function saveConversationRecord(record: CateoConversationRecord) { writeProtectedJson(convPath(record.conversationId), record); const file = loadCatalog(); const rows = file.rows.filter((entry) => entry.conversationId !== record.conversationId); rows.push(summary(record)); rows.sort((a, b) => b.updatedAt - a.updatedAt); saveCatalog({ version: CONV_DB, updatedAt: new Date().toISOString(), rows }); return record; }
export function listConversationSummaries(viewer: Viewer) { return loadCatalog().rows.filter((entry) => viewer.admin || (viewer.userId ? entry.ownerUserId === viewer.userId : entry.requesterId === viewer.requesterId)).sort((a, b) => b.updatedAt - a.updatedAt); }
export function toCustomerConversationSummary(record: CateoConversationSummary) {
  return {
    conversationId: record.conversationId,
    title: record.title,
    saved: record.saved,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastMessagePreview: record.lastMessagePreview,
    messageCount: record.messageCount,
    pendingCount: record.pendingCount,
  };
}
function resolveConversation(params: { conversationId?: string | null; viewer: Viewer; requesterId: string; ownerUserId?: string; profileId?: string; input: CateoAssistInput }) {
  const requestedId = params.conversationId?.trim();
  const existing = requestedId ? loadConversationRecord(requestedId) : null;
  if (existing) {
    if (!canSee(existing, params.viewer)) {
      throw new Error("Conversation not found");
    }
    if (params.ownerUserId && !existing.ownerUserId) existing.ownerUserId = params.ownerUserId;
    if (params.profileId && !existing.profileId) existing.profileId = params.profileId;
    return existing;
  }
  const title = promptTitle(params.input);
  return {
    conversationId: requestedId || crypto.randomUUID(),
    ownerUserId: params.ownerUserId,
    requesterId: params.requesterId,
    profileId: params.profileId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: title.title,
    titleSource: title.source,
    saved: false,
    caseIds: [],
    artifactIds: [],
    messages: [],
  } satisfies CateoConversationRecord;
}

function classifyUserTurn(text: string): CateoConversationTurnKind {
  if (/^(?:correction\b|actually\b|to correct that\b|i meant\b|not\b)/i.test(text.trim())) return "correction";
  if (/\b(?:i see|we see|observed|shows|reads|measured|after that|still)\b/i.test(text)) return "observation";
  return "request";
}

export function queueConversationTurn(params: { conversationId?: string | null; viewer: Viewer; requesterId: string; ownerUserId?: string; profileId?: string; jobId: string; input: CateoAssistInput; promptText: string; clientMessageId?: string }) {
  const record = resolveConversation(params);
  const clientMessageId = params.clientMessageId?.trim();
  if (clientMessageId) {
    const existingUser = record.messages.find((message) => message.role === "user" && message.clientMessageId === clientMessageId);
    if (existingUser) {
      const index = record.messages.indexOf(existingUser);
      const assistantMessage = record.messages.slice(index + 1).find((message) => message.role === "assistant");
      if (!assistantMessage) throw new Error("Idempotent conversation turn is incomplete.");
      return { conversation: record, summary: summary(record), userMessage: existingUser, assistantMessage, idempotent: true };
    }
  }
  if (record.messages.some((message) => message.role === "assistant" && (message.status === "queued" || message.status === "running"))) {
    throw new Error("This troubleshooting thread already has a request in progress. Wait for the current evaluation to finish before replying.");
  }
  const now = Date.now();
  const attachments = (params.input.attachments ?? []).map((attachment) => ({ name: attachment.name, kind: attachment.kind, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }));
  const userMessage: CateoConversationMessageRecord = { messageId: crypto.randomUUID(), clientMessageId, role: "user", kind: classifyUserTurn(params.promptText), text: params.promptText, createdAt: now, updatedAt: now, status: "completed", checkpoints: [], attachments };
  const assistantMessage: CateoConversationMessageRecord = { messageId: crypto.randomUUID(), role: "assistant", kind: "instruction", text: "", createdAt: now, updatedAt: now, status: "queued", checkpoints: [], jobId: params.jobId };
  record.messages.push(userMessage, assistantMessage);
  record.dynamicMetadata = accumulateConversationMetadata({ current: record.dynamicMetadata, messageId: userMessage.messageId, text: params.promptText, input: params.input, timestamp: new Date(now).toISOString() });
  const priorCaseId = record.caseIds.at(-1);
  const priorCase = priorCaseId ? loadCaseRecord(priorCaseId) : null;
  if (priorCase) {
    const priorArtifacts = priorCase.artifacts.map((artifactId) => loadArtifactRecord(artifactId)).filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact));
    attachCaseMetadataAndDatasetCandidate({ caseRecord: priorCase, metadata: record.dynamicMetadata, artifacts: priorArtifacts });
    saveCaseRecord(priorCase);
  }
  record.updatedAt = now;
  record.lastMessagePreview = trunc(params.promptText, 160);
  const saved = saveConversationRecord(record);
  persistRawNote({ conversationId: saved.conversationId, messageId: userMessage.messageId, createdAt: userMessage.createdAt, role: "user", title: saved.title, text: params.promptText, status: userMessage.status, input: params.input });
  appendAuditEvent({ actor: "server", category: "conversation", action: "queue_turn", outcome: "success", message: `Queued conversation turn for ${saved.conversationId}`, metadata: { conversationId: saved.conversationId, jobId: params.jobId, ownerUserId: saved.ownerUserId, requesterId: saved.requesterId, clientMessageId } });
  return { conversation: saved, summary: summary(saved), userMessage, assistantMessage, idempotent: false };
}
function patchAssistant(record: CateoConversationRecord, assistantMessageId: string, update: (message: CateoConversationMessageRecord) => void, persist = true) { const message = record.messages.find((entry) => entry.messageId === assistantMessageId && entry.role === "assistant"); if (!message) throw new Error(`Conversation ${record.conversationId} does not contain assistant message ${assistantMessageId}`); update(message); message.updatedAt = Date.now(); record.updatedAt = message.updatedAt; return persist ? saveConversationRecord(record) : record; }
export function updateConversationCheckpoint(params: { conversationId: string; assistantMessageId: string; checkpoint: CateoInteractionCheckpoint }) { const record = loadConversationRecord(params.conversationId); if (!record) throw new Error(`Conversation ${params.conversationId} was not found`); return patchAssistant(record, params.assistantMessageId, (message) => { message.status = params.checkpoint.status === "failed" ? "failed" : "running"; message.checkpoints = [...message.checkpoints, params.checkpoint]; }); }
const SAFE_EVIDENCE_GAP_MESSAGE = "I don’t have enough verified information to give a safe next step yet. Share the exact instrument model, error code, and what you observed, or contact an authorized service specialist.";
const INTERNAL_TEXT_PATTERN = /(?:\b(?:artifact|case|job|chunk)[ _-]?id\b|\bretrieval score\b|\bembedding(?:s)?\b|\bprompt (?:text|version)\b|\bapproval (?:state|workflow)\b|\btool call\b|\bsystem prompt\b|\bstack trace\b|\b(?:localhost|127\.0\.0\.1):\d+\b|[A-Za-z]:\\[^\s]+|\/Users\/[^\s]+)/i;

export function toCustomerSafeText(text: string | undefined): string {
  const normalized = text?.trim();
  if (!normalized) return SAFE_EVIDENCE_GAP_MESSAGE;
  if (normalized.startsWith("{") || normalized.startsWith("[") || INTERNAL_TEXT_PATTERN.test(normalized)) {
    return SAFE_EVIDENCE_GAP_MESSAGE;
  }
  return normalized
    .replace(/\b(?:build|generate|prepare) the controlled artifact package\b/gi, "provide the next safe troubleshooting step")
    .replace(/\bcontrolled artifact package\b/gi, "safe troubleshooting guidance")
    .replace(/\bartifact package\b/gi, "troubleshooting guidance")
    .replace(/\bartifacts\b/gi, "instructions")
    .replace(/\bartifact\b/gi, "instruction");
}

function customerTextForResult(result: CateoAssistResult, metadata?: CateoDynamicCaseMetadata): string {
  if (metadata?.pendingClarification) {
    return toCustomerSafeText(metadata.pendingClarification);
  }
  if (result.interaction.releaseStatus === "clarification-required") {
    return toCustomerSafeText(result.interaction.clarifyingQuestion || result.interaction.message);
  }
  if (result.interaction.releaseStatus === "available" && !result.interaction.requiresEngineerReview) {
    return toCustomerSafeText(result.interaction.message);
  }
  return SAFE_EVIDENCE_GAP_MESSAGE;
}

export function completeConversationTurn(params: { conversationId: string; assistantMessageId: string; result: CateoAssistResult }) {
  const record = loadConversationRecord(params.conversationId);
  if (!record) throw new Error(`Conversation ${params.conversationId} was not found`);
  const customerText = customerTextForResult(params.result, record.dynamicMetadata);
  const released = params.result.interaction.releaseStatus === "available" && !params.result.interaction.requiresEngineerReview;
  const updated = patchAssistant(record, params.assistantMessageId, (message) => {
    message.status = "completed";
    message.kind = params.result.interaction.releaseStatus === "clarification-required" || record.dynamicMetadata?.pendingClarification ? "clarification" : "instruction";
    message.text = customerText;
    message.highlights = released ? params.result.interaction.highlights : undefined;
    message.nextActions = released ? params.result.interaction.nextActions : undefined;
    message.confidence = undefined;
    message.artifactCount = undefined;
    message.detailLevel = released ? params.result.interaction.detailLevel : undefined;
    message.sections = released ? params.result.interaction.sections : undefined;
    message.artifactPreviews = undefined;
    message.caseId = params.result.caseId;
    message.artifactIds = params.result.artifacts.map((artifact) => artifact.artifactId);
    message.checkpoints = params.result.checkpoints;
    message.error = undefined;
  }, false);
  updated.caseIds = unique([...updated.caseIds, params.result.caseId]);
  updated.artifactIds = unique([...updated.artifactIds, ...params.result.artifacts.map((artifact) => artifact.artifactId)]);
  const title = resultTitle(params.result, updated.title);
  updated.title = title.title;
  updated.titleSource = title.source;
  updated.lastMessagePreview = trunc(customerText, 160);
  const caseRecord = loadCaseRecord(params.result.caseId);
  if (caseRecord) {
    caseRecord.conversationId = params.conversationId;
    attachCaseMetadataAndDatasetCandidate({ caseRecord, metadata: updated.dynamicMetadata, artifacts: params.result.artifacts });
    saveCaseRecord(caseRecord);
  }
  // The customer transcript is marked complete only after internal metadata and
  // dataset candidacy have persisted. A metadata failure therefore leaves the
  // prior queued/running message visible and can be retried safely.
  const saved = saveConversationRecord(updated);
  const assistantMessage = saved.messages.find((entry) => entry.messageId === params.assistantMessageId && entry.role === "assistant");
  if (assistantMessage) persistRawNote({ conversationId: saved.conversationId, messageId: assistantMessage.messageId, createdAt: assistantMessage.createdAt, role: "assistant", title: saved.title, text: assistantMessage.text, status: assistantMessage.status, caseId: params.result.caseId, artifactIds: params.result.artifacts.map((artifact) => artifact.artifactId), highlights: assistantMessage.highlights, nextActions: assistantMessage.nextActions, detailLevel: assistantMessage.detailLevel, sections: assistantMessage.sections });
  return saved;
}

export function failConversationTurn(params: { conversationId: string; assistantMessageId: string; error: string; checkpoint?: CateoInteractionCheckpoint }) {
  const record = loadConversationRecord(params.conversationId);
  if (!record) throw new Error(`Conversation ${params.conversationId} was not found`);
  const saved = patchAssistant(record, params.assistantMessageId, (message) => {
    message.status = "failed";
    message.text = "I couldn’t complete that request. Please try again. If the problem is safety-critical, stop and contact an authorized service specialist.";
    message.error = params.error;
    if (params.checkpoint) message.checkpoints = [...message.checkpoints, params.checkpoint];
  });
  const assistantMessage = saved.messages.find((entry) => entry.messageId === params.assistantMessageId && entry.role === "assistant");
  if (assistantMessage) persistRawNote({ conversationId: saved.conversationId, messageId: assistantMessage.messageId, createdAt: assistantMessage.createdAt, role: "assistant", title: saved.title, text: assistantMessage.text, status: assistantMessage.status, caseId: assistantMessage.caseId, artifactIds: assistantMessage.artifactIds, error: assistantMessage.error });
  return saved;
}

export function buildBoundedConversationContext(
  record: CateoConversationRecord,
  options: { maxTurns?: number; maxCharacters?: number } = {},
): CateoConversationContext {
  const maxTurns = Math.min(24, Math.max(2, options.maxTurns ?? 16));
  const maxCharacters = Math.min(20_000, Math.max(1_000, options.maxCharacters ?? 12_000));
  const eligible = record.messages
    .filter((message) => message.status === "completed" && message.text.trim())
    .map((message) => ({
      messageId: message.messageId,
      role: message.role,
      kind: message.kind ?? (message.role === "user" ? classifyUserTurn(message.text) : message.role === "system" ? "system" : "instruction"),
      content: message.text.trim(),
      occurredAt: message.createdAt,
    }));
  const selected: typeof eligible = [];
  let characters = 0;
  for (const turn of [...eligible].reverse()) {
    if (selected.length >= maxTurns) break;
    const remaining = maxCharacters - characters;
    if (remaining <= 0) break;
    const content = turn.content.length > remaining ? turn.content.slice(turn.content.length - remaining) : turn.content;
    selected.unshift({ ...turn, content });
    characters += content.length;
  }
  return {
    schemaVersion: "cateo-transcript-v1",
    conversationId: record.conversationId,
    maxTurns,
    maxCharacters,
    truncated: selected.length < eligible.length || characters < eligible.reduce((sum, turn) => sum + turn.content.length, 0),
    turns: selected,
    pendingClarification: record.dynamicMetadata?.pendingClarification,
  };
}

export interface CateoCustomerConversation {
  conversationId: string;
  status: "ready" | "sending" | "reasoning" | "failed";
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    status: "sending" | "reasoning" | "completed" | "failed";
    createdAt: number;
  }>;
  updatedAt: number;
}

export function toCustomerConversation(record: CateoConversationRecord): CateoCustomerConversation {
  const latestAssistant = [...record.messages].reverse().find((message) => message.role === "assistant");
  const status: CateoCustomerConversation["status"] = latestAssistant?.status === "queued"
    ? "sending"
    : latestAssistant?.status === "running"
      ? "reasoning"
      : latestAssistant?.status === "failed"
        ? "failed"
        : "ready";
  return {
    conversationId: record.conversationId,
    status,
    messages: record.messages
      .filter((message): message is CateoConversationMessageRecord & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        text: (() => {
          if (message.role === "assistant" && message.caseId) {
            const caseRecord = loadCaseRecord(message.caseId);
            const artifacts = caseRecord?.artifacts.map((artifactId) => loadArtifactRecord(artifactId)).filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact)) ?? [];
            const clarification = caseRecord?.interaction?.releaseStatus === "clarification-required";
            if (caseRecord && !clarification && !isCurrentContentReleased(caseRecord, artifacts)) {
              return SAFE_EVIDENCE_GAP_MESSAGE;
            }
          }
          return message.text ? toCustomerSafeText(message.text) : (message.status === "queued" ? "Sending your message…" : message.status === "running" ? "Reviewing the available evidence…" : "");
        })(),
        status: message.status === "queued" ? "sending" : message.status === "running" ? "reasoning" : message.status,
        createdAt: message.createdAt,
      })),
    updatedAt: record.updatedAt,
  };
}
export function adoptRequesterConversations(userId: string, requesterId: string, profileId?: string) { let adopted = 0; for (const item of listConversationSummaries({ requesterId })) { const record = loadConversationRecord(item.conversationId); if (!record || record.ownerUserId) continue; record.ownerUserId = userId; if (profileId && !record.profileId) record.profileId = profileId; saveConversationRecord(record); adopted += 1; } return adopted; }
export function setConversationSaved(conversationId: string, viewer: Viewer, saved: boolean) { const record = loadConversationRecord(conversationId); if (!record || !canSee(record, viewer)) throw new Error("Conversation not found"); record.saved = saved; record.updatedAt = Date.now(); return saveConversationRecord(record); }
export function createConversationShare(conversationId: string, viewer: Viewer) { const record = loadConversationRecord(conversationId); if (!record || !canSee(record, viewer)) throw new Error("Conversation not found"); const shares = loadShares(); const existing = shares.rows.find((entry) => entry.conversationId === conversationId && !entry.revokedAt); const share = existing ?? { shareId: crypto.randomUUID(), token: crypto.randomBytes(18).toString("base64url"), conversationId, createdAt: Date.now(), createdByUserId: viewer.userId } satisfies ShareRec; if (!existing) { shares.rows.push(share); saveShares({ version: SHARE_DB, updatedAt: new Date().toISOString(), rows: shares.rows }); } record.shareId = share.shareId; return { shareId: share.shareId, token: share.token, conversation: saveConversationRecord(record) }; }
export function getSharedConversation(token: string) { const share = loadShares().rows.find((entry) => entry.token === token && !entry.revokedAt); return share ? loadConversationRecord(share.conversationId) : null; }


