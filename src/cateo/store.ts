import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
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
  assetId?: string;
  workOrderId?: string;
  schemaId: string;
  schemaVersion: string;
  approvalState: string;
  revisionNumber: number;
  summary: string;
  updatedAt: string;
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
  assetId?: string;
  workOrderId?: string;
  artifactIds: string[];
  interactionSummary?: string;
  updatedAt: string;
}

interface CaseCatalogFile {
  version: string;
  updatedAt: string;
  rows: CaseCatalogRow[];
}

function getCateoDir(): string {
  return path.join(getConfigDir(), "cateo");
}

function getArtifactDir(): string {
  return path.join(getCateoDir(), "artifacts");
}

function getCaseDir(): string {
  return path.join(getCateoDir(), "cases");
}

function getDatabaseDir(): string {
  return path.join(getCateoDir(), "db");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  const next: ArtifactCatalogRow = {
    artifactId: record.artifactId,
    caseId: record.caseId,
    artifactType: record.artifactType,
    assetId: record.assetId,
    workOrderId: record.workOrderId,
    schemaId: record.schema.id,
    schemaVersion: record.schema.version,
    approvalState: current.approvalState,
    revisionNumber: current.revisionNumber,
    summary: current.summary,
    updatedAt: record.updatedAt,
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
  const next: CaseCatalogRow = {
    caseId: record.caseId,
    runId: record.runId,
    title: record.context.title,
    taskClass: record.context.taskClass,
    assetId: record.context.asset?.assetId,
    workOrderId: record.context.workOrder?.workOrderId,
    artifactIds: record.artifacts,
    interactionSummary: record.interaction?.message,
    updatedAt: record.updatedAt,
  };

  const file = loadCaseCatalog();
  const rows = file.rows.filter((entry) => entry.caseId !== record.caseId);
  rows.push(next);
  rows.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  saveCaseCatalog({ version: DATABASE_VERSION, updatedAt: new Date().toISOString(), rows });
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
  writeProtectedJson(artifactPath(record.artifactId), record);
  upsertArtifactCatalog(record);
  upsertArtifactVectorEntry(record);
  return record;
}

export function loadArtifactRecord(artifactId: string): CateoArtifactRecord | null {
  const record = readProtectedJson<CateoArtifactRecord | null>(artifactPath(artifactId), null);
  return record;
}

export function saveCaseRecord(record: CateoCaseRecord): CateoCaseRecord {
  writeProtectedJson(casePath(record.caseId), record);
  upsertCaseCatalog(record);
  upsertCaseVectorEntry(record);
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
  const current = params.record.revisions[params.record.revisions.length - 1];
  const createdAt = params.provenance.createdAt;
  const revision: CateoArtifactRevision = {
    revisionId: crypto.randomUUID(),
    revisionNumber: params.record.revisions.length + 1,
    approvalState: params.approvalState,
    createdAt,
    createdBy: params.createdBy,
    note: params.note,
    summary: params.summary,
    diffFromPrevious: current ? buildJsonDiff(current.content, params.content) : [],
    signoffs: params.signoffs ?? current?.signoffs ?? [],
    provenance: params.provenance,
    metadata: params.metadata,
    content: params.content,
  };

  const updated: CateoArtifactRecord = {
    ...params.record,
    currentRevisionId: revision.revisionId,
    updatedAt: createdAt,
    revisions: [...params.record.revisions, revision],
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
  limit?: number;
  minScore?: number;
}): SimilarArtifactMatch[] {
  const rows = listArtifactCatalogRows().filter((row) => row.artifactType === params.artifactType);
  const vectorMatches = searchVectorIndex({
    text: [params.artifactType, params.text, params.assetId, params.workOrderId].filter(Boolean).join("\n"),
    kind: "artifact",
    artifactType: params.artifactType,
    assetId: params.assetId,
    workOrderId: params.workOrderId,
    minScore: params.minScore ?? 0.12,
    limit: Math.max(5, params.limit ?? 5),
  });

  const byArtifactId = new Map();
  for (const row of rows) {
    byArtifactId.set(row.artifactId, {
      artifactId: row.artifactId,
      artifactType: row.artifactType,
      caseId: row.caseId,
      assetId: row.assetId,
      workOrderId: row.workOrderId,
      score: 0,
      basis: [],
      revisionNumber: row.revisionNumber,
      approvalState: row.approvalState,
      updatedAt: row.updatedAt,
    });
  }

  for (const match of vectorMatches) {
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
  }

  return [...byArtifactId.values()]
    .filter((entry) => entry.score >= (params.minScore ?? 0.12))
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, params.limit ?? 5);
}


