import crypto from "node:crypto";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import type { CateoAssistInput, CateoAssistResult, CateoInteractionCheckpoint } from "./types.js";

const CONV_DB = "cateo-conversations-v1";
const SHARE_DB = "cateo-conversation-shares-v1";

export interface CateoConversationAttachmentRef { name: string; kind?: string; mimeType?: string; sizeBytes?: number; }
export interface CateoConversationMessageRecord {
  messageId: string;
  role: "user" | "assistant" | "system";
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
const loadCatalog = () => readProtectedJson<ConvFile>(catalogPath(), { version: CONV_DB, updatedAt: new Date(0).toISOString(), rows: [] });
const saveCatalog = (file: ConvFile) => writeProtectedJson(catalogPath(), file);
const loadShares = () => readProtectedJson<ShareFile>(sharePath(), { version: SHARE_DB, updatedAt: new Date(0).toISOString(), rows: [] });
const saveShares = (file: ShareFile) => writeProtectedJson(sharePath(), file);
const unique = (values: Array<string | undefined | null>) => [...new Set(values.map((v) => v?.trim()).filter((v): v is string => Boolean(v)))];
const trunc = (text?: string, max = 120) => { const v = text?.replace(/\s+/g, " ").trim(); if (!v) return undefined; return v.length <= max ? v : `${v.slice(0, Math.max(0, max - 3)).trimEnd()}...`; };
const loadConversationRecord = (id: string) => readProtectedJson<CateoConversationRecord | null>(convPath(id), null);
export { loadConversationRecord };
function summary(record: CateoConversationRecord): CateoConversationSummary { return { conversationId: record.conversationId, ownerUserId: record.ownerUserId, requesterId: record.requesterId, profileId: record.profileId, title: record.title, titleSource: record.titleSource, saved: record.saved, shareId: record.shareId, createdAt: record.createdAt, updatedAt: record.updatedAt, lastMessagePreview: record.lastMessagePreview, messageCount: record.messages.length, pendingCount: record.messages.filter((m) => m.role === "assistant" && (m.status === "queued" || m.status === "running")).length }; }
function canSee(record: CateoConversationRecord, viewer: Viewer) { if (viewer.admin) return true; if (viewer.userId) return record.ownerUserId === viewer.userId || (!record.ownerUserId && viewer.requesterId && record.requesterId === viewer.requesterId); return Boolean(viewer.requesterId && record.requesterId === viewer.requesterId); }
function promptTitle(input: CateoAssistInput) { const asset = input.asset?.assetId?.trim(); if (asset) return { title: asset, source: "asset" as const }; const model = [input.machine?.manufacturer, input.machine?.model].filter(Boolean).join(" ").trim(); if (model) return { title: trunc(model, 64) ?? "Cateo conversation", source: "asset" as const }; const text = trunc(input.title?.trim() || input.symptomDescription?.trim() || input.query?.trim(), 64) ?? "Cateo conversation"; return { title: text, source: "prompt" as const }; }
function resultTitle(result: CateoAssistResult, fallback: string) { const parts = result.artifacts.find((artifact) => artifact.artifactType === "parts-tools-list")?.revisions.at(-1)?.content as { parts?: Array<{ sku?: string; description?: string }> } | undefined; const part = parts?.parts?.[0]; const label = [part?.sku, part?.description].filter(Boolean).join(" ").trim(); if (label) return { title: trunc(label, 64) ?? fallback, source: "part" as const }; if (result.interaction.conversationTitle?.trim()) return { title: trunc(result.interaction.conversationTitle, 64) ?? fallback, source: "artifact" as const }; if (result.context.asset?.assetId?.trim()) return { title: result.context.asset.assetId, source: "asset" as const }; return { title: fallback, source: "prompt" as const }; }
export function saveConversationRecord(record: CateoConversationRecord) { writeProtectedJson(convPath(record.conversationId), record); const file = loadCatalog(); const rows = file.rows.filter((entry) => entry.conversationId !== record.conversationId); rows.push(summary(record)); rows.sort((a, b) => b.updatedAt - a.updatedAt); saveCatalog({ version: CONV_DB, updatedAt: new Date().toISOString(), rows }); return record; }
export function listConversationSummaries(viewer: Viewer) { return loadCatalog().rows.filter((entry) => viewer.admin || (viewer.userId ? entry.ownerUserId === viewer.userId : entry.requesterId === viewer.requesterId)).sort((a, b) => b.updatedAt - a.updatedAt); }
function resolveConversation(params: { conversationId?: string | null; viewer: Viewer; requesterId: string; ownerUserId?: string; profileId?: string; input: CateoAssistInput }) { const existing = params.conversationId ? loadConversationRecord(params.conversationId) : null; if (existing && canSee(existing, params.viewer)) { if (params.ownerUserId && !existing.ownerUserId) existing.ownerUserId = params.ownerUserId; if (params.profileId && !existing.profileId) existing.profileId = params.profileId; return existing; } const title = promptTitle(params.input); return { conversationId: params.conversationId?.trim() || crypto.randomUUID(), ownerUserId: params.ownerUserId, requesterId: params.requesterId, profileId: params.profileId, createdAt: Date.now(), updatedAt: Date.now(), title: title.title, titleSource: title.source, saved: false, caseIds: [], artifactIds: [], messages: [] } satisfies CateoConversationRecord; }
export function queueConversationTurn(params: { conversationId?: string | null; viewer: Viewer; requesterId: string; ownerUserId?: string; profileId?: string; jobId: string; input: CateoAssistInput; promptText: string }) { const record = resolveConversation(params); const now = Date.now(); const attachments = (params.input.attachments ?? []).map((attachment) => ({ name: attachment.name, kind: attachment.kind, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes })); const userMessage: CateoConversationMessageRecord = { messageId: crypto.randomUUID(), role: "user", text: params.promptText, createdAt: now, updatedAt: now, status: "completed", checkpoints: [], attachments }; const assistantMessage: CateoConversationMessageRecord = { messageId: crypto.randomUUID(), role: "assistant", text: "", createdAt: now, updatedAt: now, status: "queued", checkpoints: [], jobId: params.jobId }; record.messages.push(userMessage, assistantMessage); record.updatedAt = now; record.lastMessagePreview = trunc(params.promptText, 160); const saved = saveConversationRecord(record); appendAuditEvent({ actor: "server", category: "conversation", action: "queue_turn", outcome: "success", message: `Queued conversation turn for ${saved.conversationId}`, metadata: { conversationId: saved.conversationId, jobId: params.jobId, ownerUserId: saved.ownerUserId, requesterId: saved.requesterId } }); return { conversation: saved, summary: summary(saved), userMessage, assistantMessage }; }
function patchAssistant(record: CateoConversationRecord, assistantMessageId: string, update: (message: CateoConversationMessageRecord) => void) { const message = record.messages.find((entry) => entry.messageId === assistantMessageId && entry.role === "assistant"); if (!message) throw new Error(`Conversation ${record.conversationId} does not contain assistant message ${assistantMessageId}`); update(message); message.updatedAt = Date.now(); record.updatedAt = message.updatedAt; return saveConversationRecord(record); }
export function updateConversationCheckpoint(params: { conversationId: string; assistantMessageId: string; checkpoint: CateoInteractionCheckpoint }) { const record = loadConversationRecord(params.conversationId); if (!record) throw new Error(`Conversation ${params.conversationId} was not found`); return patchAssistant(record, params.assistantMessageId, (message) => { message.status = params.checkpoint.status === "failed" ? "failed" : "running"; message.checkpoints = [...message.checkpoints, params.checkpoint]; }); }
export function completeConversationTurn(params: { conversationId: string; assistantMessageId: string; result: CateoAssistResult }) { const record = loadConversationRecord(params.conversationId); if (!record) throw new Error(`Conversation ${params.conversationId} was not found`); const updated = patchAssistant(record, params.assistantMessageId, (message) => { message.status = "completed"; message.text = params.result.interaction.message; message.highlights = params.result.interaction.highlights; message.nextActions = params.result.interaction.nextActions; message.confidence = params.result.interaction.confidence; message.artifactCount = params.result.interaction.artifactCount; message.caseId = params.result.caseId; message.artifactIds = params.result.artifacts.map((artifact) => artifact.artifactId); message.checkpoints = params.result.checkpoints; message.error = undefined; }); updated.caseIds = unique([...updated.caseIds, params.result.caseId]); updated.artifactIds = unique([...updated.artifactIds, ...params.result.artifacts.map((artifact) => artifact.artifactId)]); const title = resultTitle(params.result, updated.title); updated.title = title.title; updated.titleSource = title.source; updated.lastMessagePreview = trunc(params.result.interaction.message, 160); return saveConversationRecord(updated); }
export function failConversationTurn(params: { conversationId: string; assistantMessageId: string; error: string; checkpoint?: CateoInteractionCheckpoint }) { const record = loadConversationRecord(params.conversationId); if (!record) throw new Error(`Conversation ${params.conversationId} was not found`); return patchAssistant(record, params.assistantMessageId, (message) => { message.status = "failed"; message.text = "Cateo could not complete that request."; message.error = params.error; if (params.checkpoint) message.checkpoints = [...message.checkpoints, params.checkpoint]; }); }
export function adoptRequesterConversations(userId: string, requesterId: string, profileId?: string) { let adopted = 0; for (const item of listConversationSummaries({ requesterId })) { const record = loadConversationRecord(item.conversationId); if (!record || record.ownerUserId) continue; record.ownerUserId = userId; if (profileId && !record.profileId) record.profileId = profileId; saveConversationRecord(record); adopted += 1; } return adopted; }
export function setConversationSaved(conversationId: string, viewer: Viewer, saved: boolean) { const record = loadConversationRecord(conversationId); if (!record || !canSee(record, viewer)) throw new Error("Conversation not found"); record.saved = saved; record.updatedAt = Date.now(); return saveConversationRecord(record); }
export function createConversationShare(conversationId: string, viewer: Viewer) { const record = loadConversationRecord(conversationId); if (!record || !canSee(record, viewer)) throw new Error("Conversation not found"); const shares = loadShares(); const existing = shares.rows.find((entry) => entry.conversationId === conversationId && !entry.revokedAt); const share = existing ?? { shareId: crypto.randomUUID(), token: crypto.randomBytes(18).toString("base64url"), conversationId, createdAt: Date.now(), createdByUserId: viewer.userId } satisfies ShareRec; if (!existing) { shares.rows.push(share); saveShares({ version: SHARE_DB, updatedAt: new Date().toISOString(), rows: shares.rows }); } record.shareId = share.shareId; return { shareId: share.shareId, token: share.token, conversation: saveConversationRecord(record) }; }
export function getSharedConversation(token: string) { const share = loadShares().rows.find((entry) => entry.token === token && !entry.revokedAt); return share ? loadConversationRecord(share.conversationId) : null; }


