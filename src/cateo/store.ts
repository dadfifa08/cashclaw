import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { toProjectedEffectivityRules, toProjectedExternalSystemLinks, toProjectedObjectMetadata, toProjectedRelationships } from "./cplm_projection.js";
import { syncCateoOntology } from "./ontology.js";
import { syncCateoPartMaster } from "./part_master.js";
import { searchVectorIndex, upsertArtifactVectorEntry, upsertCaseVectorEntry } from "./vector_index.js";
import type {
  CateoArtifactContent,
  CateoArtifactRecord,
  CateoArtifactRevision,
  CateoCaseRecord,
  CateoJsonDiffEntry,
} from "./types.js";

const DATABASE_VERSION = "cateo-document-db-v1";

export interface ArtifactCatalogRow {
  artifactId: string;
  caseId: string;
  artifactType: string;
  title?: string;
  assetId?: string;
  workOrderId?: string;
  schemaId: string;
  schemaVersion: string;
  approvalState: string;
  revisionNumber: number;
  summary: string;
  updatedAt: string;
  partNumber?: string;
  businessType?: string;
  issueType?: string;
  componentTitle?: string;
  failureCode?: string;
  lifecycleState?: string;
  duplicateState?: string;
  canonicalArtifactId?: string;
  duplicateGroupId?: string;
  relationCount?: number;
  documentType?: string;
  persistentObjectId?: string;
  objectMetadata?: ReturnType<typeof toProjectedObjectMetadata>;
  effectivity?: ReturnType<typeof toProjectedEffectivityRules>;
  relationships?: ReturnType<typeof toProjectedRelationships>;
  externalSystemLinks?: ReturnType<typeof toProjectedExternalSystemLinks>;
  taxonomyTags: string[];
}

interface ArtifactCatalogFile {
  version: string;
  updatedAt: string;
  rows: ArtifactCatalogRow[];
}

export interface CaseCatalogRow {
  caseId: string;
  runId: string;
  title: string;
  taskClass: string;
  createdAt: string;
  productOffering?: string;
  workflowMode?: string;
  partNumber?: string;
  businessType?: string;
  issueType?: string;
  releaseStatus?: string;
  confidence?: string;
  serviceTier?: string;
  requesterId?: string;
  ownerUserId?: string;
  profileId?: string;
  displayName?: string;
  organization?: string;
  assetId?: string;
  workOrderId?: string;
  conversationId?: string;
  requiresEngineerReview?: boolean;
  artifactIds: string[];
  interactionSummary?: string;
  businessJustification?: string;
  drjJustification?: string;
  documentIntent?: string;
  complianceScope: string[];
  riskTier?: string;
  reviewStage?: string;
  technicalReviewStatus?: string;
  technicalReviewNote?: string;
  qualityReviewStatus?: string;
  qualityReviewNote?: string;
  reviewerDecisionStatus?: string;
  reviewerDecisionSummary?: string;
  updatedAt: string;
}

interface CaseCatalogFile {
  version: string;
  updatedAt: string;
  rows: CaseCatalogRow[];
}

const artifactRebuildCache = new Map<string, { updatedAt: string; record: CateoArtifactRecord }>();
const caseRebuildCache = new Map<string, { updatedAt: string; record: CateoCaseRecord }>();

function getCateoDir(): string {
  return path.join(getConfigDir(), "cateo");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function cateoSubdir(name: string): string {
  const dir = path.join(getCateoDir(), name);
  ensureDir(dir);
  return dir;
}

export function getCateoRootDir(): string {
  const dir = getCateoDir();
  ensureDir(dir);
  return dir;
}

export function getCateoArtifactDir(): string {
  return cateoSubdir("artifacts");
}

export function getCateoCaseDir(): string {
  return cateoSubdir("cases");
}

export function getCateoProcedureDir(): string {
  return cateoSubdir("procedures");
}

export function getCateoTemplateDir(): string {
  return cateoSubdir("templates");
}

export function getCateoRawNotesDir(): string {
  return cateoSubdir("raw_notes");
}

function getArtifactDir(): string {
  return getCateoArtifactDir();
}

function getCaseDir(): string {
  return getCateoCaseDir();
}

function getDatabaseDir(): string {
  return cateoSubdir("db");
}

function artifactPath(artifactId: string): string {
  ensureDir(getArtifactDir());
  return path.join(getArtifactDir(), `${artifactId}.json`);
}

function casePath(caseId: string): string {
  ensureDir(getCaseDir());
  return path.join(getCaseDir(), `${caseId}.json`);
}

function artifactCatalogPath(): string {
  ensureDir(getDatabaseDir());
  return path.join(getDatabaseDir(), "artifacts.json");
}

function caseCatalogPath(): string {
  ensureDir(getDatabaseDir());
  return path.join(getDatabaseDir(), "cases.json");
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalizeArtifactRecord(record: CateoArtifactRecord): CateoArtifactRecord {
  return {
    ...record,
    canonicalArtifactId: record.canonicalArtifactId || record.artifactId,
    duplicateState: record.duplicateState || "canonical",
    relatedArtifactIds: unique(record.relatedArtifactIds ?? []),
    mergedSourceArtifactIds: unique(record.mergedSourceArtifactIds ?? []),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rememberArtifactForRebuild(record: CateoArtifactRecord): void {
  artifactRebuildCache.set(record.artifactId, {
    updatedAt: record.updatedAt,
    record: snapshotRecord(record),
  });
}

function rememberCaseForRebuild(record: CateoCaseRecord): void {
  caseRebuildCache.set(record.caseId, {
    updatedAt: record.updatedAt,
    record: snapshotRecord(record),
  });
}

function artifactForRebuild(row: Pick<ArtifactCatalogRow, "artifactId" | "updatedAt">): CateoArtifactRecord | null {
  const cached = artifactRebuildCache.get(row.artifactId);
  if (cached?.updatedAt === row.updatedAt) {
    return cached.record;
  }
  const record = readProtectedJson<CateoArtifactRecord | null>(artifactPath(row.artifactId), null);
  if (!record) {
    artifactRebuildCache.delete(row.artifactId);
    return null;
  }
  const normalized = normalizeArtifactRecord(record);
  rememberArtifactForRebuild(normalized);
  return artifactRebuildCache.get(row.artifactId)?.record ?? normalized;
}

function caseForRebuild(row: Pick<CaseCatalogRow, "caseId" | "updatedAt">): CateoCaseRecord | null {
  const cached = caseRebuildCache.get(row.caseId);
  if (cached?.updatedAt === row.updatedAt) {
    return cached.record;
  }
  const record = readProtectedJson<CateoCaseRecord | null>(casePath(row.caseId), null);
  if (!record) {
    caseRebuildCache.delete(row.caseId);
    return null;
  }
  rememberCaseForRebuild(record);
  return caseRebuildCache.get(row.caseId)?.record ?? record;
}

function diffRecursive(before: unknown, after: unknown, currentPath: string, diff: CateoJsonDiffEntry[]): void {
  const beforeSerialized = stableStringify(before);
  const afterSerialized = stableStringify(after);
  if (beforeSerialized === afterSerialized) {
    return;
  }

  const beforeObject = before && typeof before === "object" && !Array.isArray(before);
  const afterObject = after && typeof after === "object" && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const keys = [...new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ])].sort();

    for (const key of keys) {
      diffRecursive(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        currentPath ? `${currentPath}.${key}` : key,
        diff,
      );
    }
    return;
  }

  diff.push({
    path: currentPath || "root",
    before: beforeSerialized,
    after: afterSerialized,
  });
}

function loadArtifactCatalog(): ArtifactCatalogFile {
  return readProtectedJson<ArtifactCatalogFile>(artifactCatalogPath(), {
    version: DATABASE_VERSION,
    updatedAt: new Date(0).toISOString(),
    rows: [],
  });
}

function saveArtifactCatalog(file: ArtifactCatalogFile): void {
  writeProtectedJson(artifactCatalogPath(), file);
}

function upsertArtifactCatalog(record: CateoArtifactRecord): void {
  const current = record.revisions[record.revisions.length - 1];
  const metadata = current?.metadata;
  const next: ArtifactCatalogRow = {
    artifactId: record.artifactId,
    caseId: record.caseId,
    artifactType: record.artifactType,
    title: metadata?.artifactTitle,
    assetId: record.assetId,
    workOrderId: record.workOrderId,
    schemaId: record.schema.id,
    schemaVersion: record.schema.version,
    approvalState: current.approvalState,
    revisionNumber: current.revisionNumber,
    summary: current.summary,
    updatedAt: record.updatedAt,
    partNumber: metadata?.parts?.primaryPartNumber ?? metadata?.partNumber,
    businessType: metadata?.businessType,
    issueType: metadata?.classification?.failureLabel ?? metadata?.classification?.failureMode,
    componentTitle: metadata?.componentTitle,
    failureCode: metadata?.classification?.failureCode,
    lifecycleState: metadata?.lifecycleState,
    duplicateState: record.duplicateState,
    canonicalArtifactId: record.canonicalArtifactId,
    duplicateGroupId: record.duplicateGroupId,
    relationCount: metadata?.relations?.length ?? 0,
    documentType: metadata?.documentType,
    persistentObjectId: metadata?.objectMetadata?.persistentObjectId,
    objectMetadata: toProjectedObjectMetadata(metadata),
    effectivity: toProjectedEffectivityRules(metadata?.effectivity),
    relationships: toProjectedRelationships(metadata?.relations),
    externalSystemLinks: toProjectedExternalSystemLinks(metadata?.externalSystemIds),
    taxonomyTags: metadata?.taxonomyTags ?? [],
  };

  const file = loadArtifactCatalog();
  const rows = file.rows.filter((entry) => entry.artifactId !== record.artifactId);
  rows.push(next);
  rows.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  saveArtifactCatalog({ version: DATABASE_VERSION, updatedAt: new Date().toISOString(), rows });
}

function loadCaseCatalog(): CaseCatalogFile {
  return readProtectedJson<CaseCatalogFile>(caseCatalogPath(), {
    version: DATABASE_VERSION,
    updatedAt: new Date(0).toISOString(),
    rows: [],
  });
}

function saveCaseCatalog(file: CaseCatalogFile): void {
  writeProtectedJson(caseCatalogPath(), file);
}

function upsertCaseCatalog(record: CateoCaseRecord): void {
  const workflow = record.reviewWorkflow;
  const next: CaseCatalogRow = {
    caseId: record.caseId,
    runId: record.runId,
    title: record.context.title,
    taskClass: record.context.taskClass,
    createdAt: record.createdAt,
    productOffering: record.input.productOffering,
    workflowMode: record.input.workflow?.mode,
    partNumber: record.context.partResolution?.partNumber ?? record.input.partNumber,
    businessType: record.input.businessType ?? record.context.businessType,
    issueType: record.context.issueType ?? record.input.issueType ?? record.input.errorCode,
    releaseStatus: record.interaction?.releaseStatus,
    confidence: record.interaction?.confidence,
    serviceTier: record.requester?.serviceTier,
    requesterId: record.requester?.requesterId,
    ownerUserId: record.userId,
    profileId: record.requester?.profileId,
    displayName: record.requester?.displayName,
    organization: record.requester?.organization,
    assetId: record.context.asset?.assetId,
    workOrderId: record.context.workOrder?.workOrderId,
    conversationId: record.conversationId,
    requiresEngineerReview: record.interaction?.requiresEngineerReview ?? record.requester?.requiresEngineerReview,
    artifactIds: record.artifacts,
    interactionSummary: record.interaction?.message,
    businessJustification: record.input.workflow?.businessJustification,
    drjJustification: record.input.workflow?.drjJustification,
    documentIntent: record.input.workflow?.documentIntent,
    complianceScope: record.input.workflow?.complianceScope ?? [],
    riskTier: record.input.workflow?.riskTier,
    reviewStage: workflow?.stage,
    technicalReviewStatus: workflow?.technical?.status,
    technicalReviewNote: workflow?.technical?.note,
    qualityReviewStatus: workflow?.quality?.status,
    qualityReviewNote: workflow?.quality?.note,
    reviewerDecisionStatus: record.trace.reviewerDecision?.overallStatus,
    reviewerDecisionSummary: record.trace.reviewerDecision?.summary,
    updatedAt: record.updatedAt,
  };

  const file = loadCaseCatalog();
  const rows = file.rows.filter((entry) => entry.caseId !== record.caseId);
  rows.push(next);
  rows.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  saveCaseCatalog({ version: DATABASE_VERSION, updatedAt: new Date().toISOString(), rows });
}

function rebuildMaterializedIndexes(): void {
  const artifactCatalog = loadArtifactCatalog();
  const caseCatalog = loadCaseCatalog();
  const artifactRecords = artifactCatalog.rows
    .map((row) => artifactForRebuild(row))
    .filter((record): record is CateoArtifactRecord => Boolean(record));
  const caseRecords = caseCatalog.rows
    .map((row) => caseForRebuild(row))
    .filter((record): record is CateoCaseRecord => Boolean(record));
  syncCateoOntology({ artifactRecords, caseRecords });
  syncCateoPartMaster({ artifactRecords, caseRecords });
}

export function buildJsonDiff(before: unknown, after: unknown): CateoJsonDiffEntry[] {
  const diff: CateoJsonDiffEntry[] = [];
  diffRecursive(before, after, "", diff);
  return diff;
}

export function mergeContentPatch<T>(current: T, patch: Record<string, unknown>): T {
  if (Array.isArray(current) || Array.isArray(patch)) {
    return patch as unknown as T;
  }
  if (!current || typeof current !== "object" || !patch || typeof patch !== "object") {
    return patch as unknown as T;
  }

  const result: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    if (value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object" && !Array.isArray(existing)) {
      result[key] = mergeContentPatch(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export function fingerprintEvidence(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function saveArtifactRecord(record: CateoArtifactRecord): CateoArtifactRecord {
  const normalized = normalizeArtifactRecord(record);
  writeProtectedJson(artifactPath(normalized.artifactId), normalized);
  upsertArtifactCatalog(normalized);
  upsertArtifactVectorEntry(normalized);
  rememberArtifactForRebuild(normalized);
  rebuildMaterializedIndexes();
  return normalized;
}

export function loadArtifactRecord(artifactId: string): CateoArtifactRecord | null {
  const record = readProtectedJson<CateoArtifactRecord | null>(artifactPath(artifactId), null);
  return record ? normalizeArtifactRecord(record) : null;
}

export function saveCaseRecord(record: CateoCaseRecord): CateoCaseRecord {
  writeProtectedJson(casePath(record.caseId), record);
  upsertCaseCatalog(record);
  upsertCaseVectorEntry(record);
  rememberCaseForRebuild(record);
  rebuildMaterializedIndexes();
  return record;
}

export function loadCaseRecord(caseId: string): CateoCaseRecord | null {
  return readProtectedJson<CateoCaseRecord | null>(casePath(caseId), null);
}

export function createRevision(params: {
  record: CateoArtifactRecord;
  createdBy: string;
  summary: string;
  approvalState: CateoArtifactRevision["approvalState"];
  content: CateoArtifactContent;
  provenance: CateoArtifactRevision["provenance"];
  metadata?: CateoArtifactRevision["metadata"];
  note?: string;
  signoffs?: CateoArtifactRevision["signoffs"];
}): CateoArtifactRecord {
  const record = normalizeArtifactRecord(params.record);
  const current = record.revisions[record.revisions.length - 1];
  const createdAt = params.provenance.createdAt;
  const revision: CateoArtifactRevision = {
    revisionId: crypto.randomUUID(),
    revisionNumber: record.revisions.length + 1,
    approvalState: params.approvalState,
    createdAt,
    createdBy: params.createdBy,
    note: params.note,
    summary: params.summary,
    diffFromPrevious: current ? buildJsonDiff(current.content, params.content) : [],
    signoffs: params.signoffs ?? current?.signoffs ?? [],
    provenance: params.provenance,
    metadata: params.metadata ?? current?.metadata,
    content: params.content,
  };

  const updated: CateoArtifactRecord = {
    ...record,
    currentRevisionId: revision.revisionId,
    updatedAt: createdAt,
    revisions: [...record.revisions, revision],
  };

  return saveArtifactRecord(updated);
}

export function listArtifactCatalogRows(): ArtifactCatalogRow[] {
  return [...loadArtifactCatalog().rows].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function listCaseCatalogRows(): CaseCatalogRow[] {
  return [...loadCaseCatalog().rows].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export interface SimilarArtifactMatch {
  artifactId: string;
  artifactType: string;
  caseId: string;
  assetId?: string;
  workOrderId?: string;
  partNumber?: string;
  score: number;
  basis: string[];
  revisionNumber: number;
  approvalState: string;
  updatedAt: string;
}

export function findSimilarArtifacts(params: {
  text: string;
  artifactType: string;
  assetId?: string;
  workOrderId?: string;
  partNumber?: string;
  limit?: number;
  minScore?: number;
}): SimilarArtifactMatch[] {
  const rows = listArtifactCatalogRows().filter((row) => row.artifactType === params.artifactType && row.lifecycleState !== "obsolete" && row.lifecycleState !== "superseded");
  const vectorMatches = searchVectorIndex({
    text: [params.artifactType, params.text, params.assetId, params.workOrderId].filter(Boolean).join("\n"),
    kind: "artifact",
    artifactType: params.artifactType,
    assetId: params.assetId,
    workOrderId: params.workOrderId,
    minScore: params.minScore ?? 0.12,
    limit: Math.max(5, params.limit ?? 5),
  });

  const byArtifactId = new Map<string, SimilarArtifactMatch>();
  for (const row of rows) {
    byArtifactId.set(row.artifactId, {
      artifactId: row.artifactId,
      artifactType: row.artifactType,
      caseId: row.caseId,
      assetId: row.assetId,
      workOrderId: row.workOrderId,
      partNumber: row.partNumber,
      score: row.duplicateState === "duplicate" ? -0.25 : 0,
      basis: row.duplicateState === "duplicate" ? ["duplicate_penalty"] : [],
      revisionNumber: row.revisionNumber,
      approvalState: row.approvalState,
      updatedAt: row.updatedAt,
    });
  }

  for (const match of vectorMatches) {
    if (!match.artifactId) continue;
    const current = byArtifactId.get(match.artifactId);
    if (!current) continue;
    current.score = Math.max(current.score, match.score);
    current.basis.push("semantic_match");
  }

  for (const current of byArtifactId.values()) {
    if (params.assetId && current.assetId === params.assetId) {
      current.score += 0.35;
      current.basis.push("asset_exact");
    }
    if (params.workOrderId && current.workOrderId === params.workOrderId) {
      current.score += 0.2;
      current.basis.push("work_order_exact");
    }
    if (params.partNumber && current.partNumber && current.partNumber.toLowerCase() === params.partNumber.toLowerCase()) {
      current.score += 0.45;
      current.basis.push("part_exact");
    }
  }

  return [...byArtifactId.values()]
    .filter((entry) => entry.score >= (params.minScore ?? 0.12))
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, params.limit ?? 5);
}

