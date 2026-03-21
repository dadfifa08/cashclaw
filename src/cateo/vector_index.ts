import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { renderArtifactSearchText } from "./render.js";
import type { CateoArtifactRecord, CateoCaseRecord } from "./types.js";

const VECTOR_INDEX_VERSION = "cateo-vector-index-v1";
const VECTOR_DIMENSIONS = 128;

export interface VectorIndexEntry {
  id: string;
  kind: "artifact" | "case";
  caseId: string;
  artifactId?: string;
  artifactType?: string;
  assetId?: string;
  workOrderId?: string;
  updatedAt: string;
  preview: string;
  vector: number[];
}

interface VectorIndexFile {
  version: string;
  dimensions: number;
  updatedAt: string;
  entries: VectorIndexEntry[];
}

function getIndexDir(): string {
  return path.join(getConfigDir(), "cateo", "index");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function vectorIndexPath(): string {
  ensureDir(getIndexDir());
  return path.join(getIndexDir(), "vector_index.json");
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
}

function hashToken(token: string, seed: number): number {
  let hash = 2166136261 ^ seed;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function buildVector(text: string): number[] {
  const vector = Array.from({ length: VECTOR_DIMENSIONS }, () => 0);
  for (const token of tokenize(text)) {
    const bucket = hashToken(token, 0) % VECTOR_DIMENSIONS;
    const sign = (hashToken(token, 1) & 1) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  return normalizeVector(vector);
}

function loadVectorIndex(): VectorIndexFile {
  return readProtectedJson<VectorIndexFile>(vectorIndexPath(), {
    version: VECTOR_INDEX_VERSION,
    dimensions: VECTOR_DIMENSIONS,
    updatedAt: new Date(0).toISOString(),
    entries: [],
  });
}

function saveVectorIndex(index: VectorIndexFile): void {
  writeProtectedJson(vectorIndexPath(), index);
}

function upsertEntry(entry: VectorIndexEntry): void {
  const index = loadVectorIndex();
  const nextEntries = index.entries.filter((current) => current.id !== entry.id);
  nextEntries.push(entry);
  nextEntries.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  saveVectorIndex({
    version: VECTOR_INDEX_VERSION,
    dimensions: VECTOR_DIMENSIONS,
    updatedAt: new Date().toISOString(),
    entries: nextEntries,
  });
}

export function upsertArtifactVectorEntry(record: CateoArtifactRecord): void {
  const revision = record.revisions[record.revisions.length - 1];
  const preview = renderArtifactSearchText(record);
  upsertEntry({
    id: `artifact:${record.artifactId}`,
    kind: "artifact",
    caseId: record.caseId,
    artifactId: record.artifactId,
    artifactType: record.artifactType,
    assetId: record.assetId,
    workOrderId: record.workOrderId,
    updatedAt: record.updatedAt,
    preview,
    vector: buildVector(`${record.artifactType}\n${revision.summary}\n${preview}`),
  });
}

export function upsertCaseVectorEntry(record: CateoCaseRecord): void {
  const preview = [
    record.context.title,
    record.input.symptomDescription,
    record.interaction?.message,
    ...(record.interaction?.highlights ?? []),
  ].filter(Boolean).join("\n");

  upsertEntry({
    id: `case:${record.caseId}`,
    kind: "case",
    caseId: record.caseId,
    assetId: record.context.asset?.assetId,
    workOrderId: record.context.workOrder?.workOrderId,
    updatedAt: record.updatedAt,
    preview,
    vector: buildVector(preview),
  });
}

function cosineSimilarity(left: number[], right: number[]): number {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    total += left[index] * right[index];
  }
  return Number(total.toFixed(6));
}

export interface VectorSearchMatch extends VectorIndexEntry {
  score: number;
}

export function listVectorIndexEntries(): VectorIndexEntry[] {
  return [...loadVectorIndex().entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function searchVectorIndex(params: {
  text: string;
  kind?: VectorIndexEntry["kind"];
  artifactType?: string;
  assetId?: string;
  workOrderId?: string;
  minScore?: number;
  limit?: number;
}): VectorSearchMatch[] {
  const query = buildVector(params.text);
  const minScore = params.minScore ?? 0.1;
  const limit = params.limit ?? 5;
  return listVectorIndexEntries()
    .filter((entry) => !params.kind || entry.kind === params.kind)
    .filter((entry) => !params.artifactType || entry.artifactType === params.artifactType)
    .filter((entry) => !params.assetId || entry.assetId === params.assetId || !entry.assetId)
    .filter((entry) => !params.workOrderId || entry.workOrderId === params.workOrderId || !entry.workOrderId)
    .map((entry) => ({ ...entry, score: cosineSimilarity(entry.vector, query) }))
    .filter((entry) => entry.score >= minScore)
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}
