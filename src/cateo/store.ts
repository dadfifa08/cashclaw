import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import type {
  CateoArtifactContent,
  CateoArtifactRecord,
  CateoArtifactRevision,
  CateoCaseRecord,
  CateoJsonDiffEntry,
} from "./types.js";

function getCateoDir(): string {
  return path.join(getConfigDir(), "cateo");
}

function getArtifactDir(): string {
  return path.join(getCateoDir(), "artifacts");
}

function getCaseDir(): string {
  return path.join(getCateoDir(), "cases");
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
  return record;
}

export function loadArtifactRecord(artifactId: string): CateoArtifactRecord | null {
  const record = readProtectedJson<CateoArtifactRecord | null>(artifactPath(artifactId), null);
  return record;
}

export function saveCaseRecord(record: CateoCaseRecord): CateoCaseRecord {
  writeProtectedJson(casePath(record.caseId), record);
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
