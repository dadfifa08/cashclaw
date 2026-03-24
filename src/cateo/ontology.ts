import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import type { CateoArtifactRecord, CateoArtifactRelation, CateoCaseRecord } from "./types.js";

const ONTOLOGY_DB_VERSION = "cateo-ontology-db-v1";

export interface CateoOntologyEntityRow {
  entityType: "artifact" | "asset" | "work-order" | "part" | "component" | "failure-mode" | "document" | "conversation" | "case" | "external-record" | "software-version" | "geography";
  entityId: string;
  title: string;
  labels: string[];
  linkedArtifactIds: string[];
  linkedCaseIds: string[];
  updatedAt: string;
}

export interface CateoOntologyRelationRow {
  relationId: string;
  sourceArtifactId: string;
  kind: CateoArtifactRelation["kind"];
  targetType: CateoArtifactRelation["targetType"];
  targetId: string;
  label?: string;
  strength: CateoArtifactRelation["strength"];
  updatedAt: string;
}

export interface CateoOntologySnapshot {
  version: string;
  updatedAt: string;
  stats: {
    artifactCount: number;
    canonicalArtifacts: number;
    duplicateArtifacts: number;
    duplicateGroups: number;
    entityCount: number;
    relationCount: number;
  };
  entities: CateoOntologyEntityRow[];
  relations: CateoOntologyRelationRow[];
}

function ontologyPath(): string {
  return path.join(getConfigDir(), "cateo", "db", "ontology.json");
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function entityKey(entityType: CateoOntologyEntityRow["entityType"], entityId: string): string {
  return `${entityType}:${entityId}`;
}

function entityTitleFromRelation(relation: CateoArtifactRelation): string {
  return relation.label?.trim() || relation.targetId;
}

function pushEntity(map: Map<string, CateoOntologyEntityRow>, params: CateoOntologyEntityRow): void {
  const key = entityKey(params.entityType, params.entityId);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      ...params,
      labels: unique(params.labels),
      linkedArtifactIds: unique(params.linkedArtifactIds),
      linkedCaseIds: unique(params.linkedCaseIds),
    });
    return;
  }

  existing.title = existing.title || params.title;
  existing.labels = unique([...existing.labels, ...params.labels]);
  existing.linkedArtifactIds = unique([...existing.linkedArtifactIds, ...params.linkedArtifactIds]);
  existing.linkedCaseIds = unique([...existing.linkedCaseIds, ...params.linkedCaseIds]);
  existing.updatedAt = existing.updatedAt > params.updatedAt ? existing.updatedAt : params.updatedAt;
}

export function buildCateoOntology(args: { artifactRecords: CateoArtifactRecord[]; caseRecords: CateoCaseRecord[] }): CateoOntologySnapshot {
  const entities = new Map<string, CateoOntologyEntityRow>();
  const relations = new Map<string, CateoOntologyRelationRow>();
  const duplicateGroupIds = new Set<string>();
  let canonicalArtifacts = 0;
  let duplicateArtifacts = 0;

  for (const artifact of args.artifactRecords) {
    const revision = artifact.revisions.at(-1);
    const metadata = revision?.metadata;
    const updatedAt = artifact.updatedAt;
    const title = metadata?.artifactTitle || revision?.summary || artifact.artifactId;

    pushEntity(entities, {
      entityType: "artifact",
      entityId: artifact.artifactId,
      title,
      labels: unique([
        artifact.artifactType,
        metadata?.componentTitle,
        metadata?.classification?.failureCode,
        metadata?.classification?.failureLabel,
        metadata?.partNumber,
      ]),
      linkedArtifactIds: [artifact.artifactId],
      linkedCaseIds: [artifact.caseId],
      updatedAt,
    });

    if ((artifact.duplicateState ?? "canonical") === "canonical") {
      canonicalArtifacts += 1;
    }
    if ((artifact.duplicateState ?? "canonical") !== "canonical") {
      duplicateArtifacts += 1;
    }
    if (artifact.duplicateGroupId) {
      duplicateGroupIds.add(artifact.duplicateGroupId);
    }

    const assetId = metadata?.asset?.assetId ?? artifact.assetId;
    if (assetId) {
      pushEntity(entities, {
        entityType: "asset",
        entityId: assetId,
        title: metadata?.componentTitle || assetId,
        labels: unique([metadata?.asset?.assetType, metadata?.asset?.manufacturer, metadata?.asset?.model]),
        linkedArtifactIds: [artifact.artifactId],
        linkedCaseIds: [artifact.caseId],
        updatedAt,
      });
    }

    const workOrderId = metadata?.workOrder?.workOrderId ?? artifact.workOrderId;
    if (workOrderId) {
      pushEntity(entities, {
        entityType: "work-order",
        entityId: workOrderId,
        title: metadata?.workOrder?.title || workOrderId,
        labels: unique([metadata?.workOrder?.priority, metadata?.workOrder?.status]),
        linkedArtifactIds: [artifact.artifactId],
        linkedCaseIds: [artifact.caseId],
        updatedAt,
      });
    }

    const failureId = metadata?.classification?.failureCode || metadata?.classification?.failureLabel;
    if (failureId) {
      pushEntity(entities, {
        entityType: "failure-mode",
        entityId: failureId,
        title: metadata?.classification?.failureLabel || metadata?.classification?.failureMode || failureId,
        labels: unique([metadata?.classification?.failureCode, metadata?.classification?.failureMode]),
        linkedArtifactIds: [artifact.artifactId],
        linkedCaseIds: [artifact.caseId],
        updatedAt,
      });
    }

    for (const partLine of metadata?.parts?.requiredPartLines ?? []) {
      pushEntity(entities, {
        entityType: "part",
        entityId: partLine.partNumber || partLine.description,
        title: partLine.description || partLine.partNumber,
        labels: unique([partLine.partNumber, partLine.partFamily, partLine.manufacturer]),
        linkedArtifactIds: [artifact.artifactId],
        linkedCaseIds: [artifact.caseId],
        updatedAt,
      });
    }

    for (const documentRef of metadata?.evidence?.documentRefs ?? []) {
      pushEntity(entities, {
        entityType: "document",
        entityId: documentRef,
        title: documentRef,
        labels: ["attachment"],
        linkedArtifactIds: [artifact.artifactId],
        linkedCaseIds: [artifact.caseId],
        updatedAt,
      });
    }

    for (const relation of metadata?.relations ?? []) {
      const relationKey = `${artifact.artifactId}:${relation.kind}:${relation.targetType}:${relation.targetId}`;
      relations.set(relationKey, {
        relationId: relation.relationId,
        sourceArtifactId: artifact.artifactId,
        kind: relation.kind,
        targetType: relation.targetType,
        targetId: relation.targetId,
        label: relation.label,
        strength: relation.strength,
        updatedAt,
      });
      pushEntity(entities, {
        entityType: relation.targetType,
        entityId: relation.targetId,
        title: entityTitleFromRelation(relation),
        labels: relation.tags ?? [],
        linkedArtifactIds: [artifact.artifactId],
        linkedCaseIds: [artifact.caseId],
        updatedAt,
      });
    }
  }

  for (const record of args.caseRecords) {
    pushEntity(entities, {
      entityType: "case",
      entityId: record.caseId,
      title: record.context.title,
      labels: unique([record.context.taskClass, record.context.asset?.assetId, record.context.workOrder?.workOrderId]),
      linkedArtifactIds: record.artifacts,
      linkedCaseIds: [record.caseId],
      updatedAt: record.updatedAt,
    });

    if (record.conversationId) {
      pushEntity(entities, {
        entityType: "conversation",
        entityId: record.conversationId,
        title: record.interaction?.conversationTitle || record.context.title,
        labels: unique([record.context.taskClass, record.userId]),
        linkedArtifactIds: record.artifacts,
        linkedCaseIds: [record.caseId],
        updatedAt: record.updatedAt,
      });
    }
  }

  return {
    version: ONTOLOGY_DB_VERSION,
    updatedAt: new Date().toISOString(),
    stats: {
      artifactCount: args.artifactRecords.length,
      canonicalArtifacts,
      duplicateArtifacts,
      duplicateGroups: duplicateGroupIds.size,
      entityCount: entities.size,
      relationCount: relations.size,
    },
    entities: [...entities.values()].sort((left, right) => left.entityType.localeCompare(right.entityType) || left.title.localeCompare(right.title)),
    relations: [...relations.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.targetType.localeCompare(right.targetType) || left.targetId.localeCompare(right.targetId)),
  };
}

export function syncCateoOntology(args: { artifactRecords: CateoArtifactRecord[]; caseRecords: CateoCaseRecord[] }): CateoOntologySnapshot {
  const snapshot = buildCateoOntology(args);
  writeProtectedJson(ontologyPath(), snapshot);
  return snapshot;
}

export function loadCateoOntology(): CateoOntologySnapshot {
  return readProtectedJson<CateoOntologySnapshot>(ontologyPath(), {
    version: ONTOLOGY_DB_VERSION,
    updatedAt: new Date(0).toISOString(),
    stats: {
      artifactCount: 0,
      canonicalArtifacts: 0,
      duplicateArtifacts: 0,
      duplicateGroups: 0,
      entityCount: 0,
      relationCount: 0,
    },
    entities: [],
    relations: [],
  });
}

export function getCateoOntologySummary(): CateoOntologySnapshot["stats"] {
  return loadCateoOntology().stats;
}