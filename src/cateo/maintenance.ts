import crypto from "node:crypto";
import { appendAuditEvent } from "../security/audit.js";
import { validateArtifactContent } from "./schemas.js";
import { createRevision, listArtifactCatalogRows, listCaseCatalogRows, loadArtifactRecord, loadCaseRecord, mergeContentPatch, saveArtifactRecord, saveCaseRecord } from "./store.js";
import { persistTroubleshootingReportPackage } from "./report_exports.js";
import { syncCaseReviewPackageFiles } from "./review_workflow.js";
import type { CateoArtifactContent, CateoArtifactRecord, CateoArtifactRelation } from "./types.js";

export interface CateoDuplicateGroup {
  duplicateGroupId: string;
  artifactType: string;
  signature: string;
  summary: string;
  canonicalArtifactId: string;
  artifactIds: string[];
}

export interface CateoDuplicateReconcileResult {
  duplicateGroups: CateoDuplicateGroup[];
  canonicalizedArtifacts: string[];
  supersededArtifacts: string[];
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function currentSummary(record: CateoArtifactRecord): string {
  return record.revisions.at(-1)?.summary?.trim() || record.revisions.at(-1)?.metadata?.artifactSummary?.trim() || record.artifactId;
}

function currentMetadata(record: CateoArtifactRecord) {
  return record.revisions.at(-1)?.metadata;
}

function currentSignature(record: CateoArtifactRecord): string {
  const metadata = currentMetadata(record);
  return [
    record.artifactType,
    metadata?.asset.assetId || record.assetId || "na",
    metadata?.workOrder.workOrderId || record.workOrderId || "na",
    metadata?.classification.failureCode || metadata?.classification.failureLabel || "na",
    metadata?.partNumber || metadata?.componentTitle || "na",
    currentSummary(record).toLowerCase(),
  ].join("::");
}

function makeArtifactRelation(params: {
  kind: CateoArtifactRelation["kind"];
  targetType: CateoArtifactRelation["targetType"];
  targetId: string;
  label?: string;
  strength?: CateoArtifactRelation["strength"];
  source?: CateoArtifactRelation["source"];
  tags?: string[];
}): CateoArtifactRelation {
  return {
    relationId: crypto.randomUUID(),
    kind: params.kind,
    targetType: params.targetType,
    targetId: params.targetId,
    label: params.label,
    strength: params.strength ?? "high",
    source: params.source ?? "inferred",
    tags: params.tags,
  };
}

function ensureMetadataDefaults(record: CateoArtifactRecord): void {
  const revision = record.revisions.at(-1);
  if (!revision?.metadata) {
    return;
  }
  revision.metadata.relations = revision.metadata.relations ?? [];
  revision.metadata.documentControl = revision.metadata.documentControl ?? {
    recordClass: `${record.artifactType}.legacy`,
    retentionClass: "long-term-engineering-record",
    confidentiality: "internal",
    electronicSignoffRequired: true,
    relatedArtifactIds: [],
    regulatoryContexts: [],
  };
}

function ensureRelation(record: CateoArtifactRecord, relation: CateoArtifactRelation): void {
  const revision = record.revisions.at(-1);
  if (!revision?.metadata) {
    return;
  }
  ensureMetadataDefaults(record);
  const existing = revision.metadata.relations ?? [];
  if (existing.some((entry) => entry.kind === relation.kind && entry.targetType === relation.targetType && entry.targetId === relation.targetId)) {
    return;
  }
  revision.metadata.relations = [...existing, relation];
}

function duplicateGroups(): CateoDuplicateGroup[] {
  const records = listArtifactCatalogRows()
    .map((row) => loadArtifactRecord(row.artifactId))
    .filter((record): record is CateoArtifactRecord => Boolean(record))
    .filter((record) => record.duplicateState !== "duplicate" && record.revisions.at(-1)?.metadata?.lifecycleState !== "obsolete" && record.revisions.at(-1)?.metadata?.lifecycleState !== "superseded");

  const groups = new Map<string, CateoArtifactRecord[]>();
  for (const record of records) {
    const signature = currentSignature(record);
    const current = groups.get(signature) ?? [];
    current.push(record);
    groups.set(signature, current);
  }

  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([signature, items]) => {
      const sorted = [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.revisions.length - left.revisions.length);
      const canonical = sorted[0];
      return {
        duplicateGroupId: crypto.createHash("sha1").update(signature).digest("hex").slice(0, 16),
        artifactType: canonical.artifactType,
        signature,
        summary: currentSummary(canonical),
        canonicalArtifactId: canonical.artifactId,
        artifactIds: sorted.map((record) => record.artifactId),
      } satisfies CateoDuplicateGroup;
    })
    .sort((left, right) => right.artifactIds.length - left.artifactIds.length || left.summary.localeCompare(right.summary));
}

function mergeDuplicateContent(canonical: CateoArtifactRecord, duplicates: CateoArtifactRecord[], actor: string): CateoArtifactRecord {
  let nextRecord = canonical;
  let nextContent = canonical.revisions.at(-1)?.content as CateoArtifactContent;
  const mergedIds: string[] = [];

  for (const duplicate of duplicates) {
    const duplicateContent = duplicate.revisions.at(-1)?.content;
    if (!duplicateContent) {
      continue;
    }
    const candidate = mergeContentPatch(nextContent as unknown as Record<string, unknown>, duplicateContent as unknown as Record<string, unknown>) as unknown as CateoArtifactContent;
    const validationErrors = validateArtifactContent(canonical.artifactType, candidate);
    if (validationErrors.length === 0) {
      nextContent = candidate;
      mergedIds.push(duplicate.artifactId);
    }
  }

  if (mergedIds.length === 0) {
    return canonical;
  }

  const revision = canonical.revisions.at(-1);
  const provenance = revision?.provenance;
  const metadata = revision?.metadata ? structuredClone(revision.metadata) : undefined;
  if (metadata) {
    metadata.lifecycleState = "released";
    metadata.changeHistory = [
      ...(metadata.changeHistory ?? []),
      {
        changeId: crypto.randomUUID(),
        changedAt: new Date().toISOString(),
        actor,
        action: "canonicalized-duplicates",
        summary: `Canonicalized duplicate artifacts into ${canonical.artifactId}`,
        relatedCaseId: canonical.caseId,
        relatedArtifactId: canonical.artifactId,
      },
    ];
    metadata.relations = metadata.relations ?? [];
    metadata.documentControl = metadata.documentControl ?? {
      recordClass: `${canonical.artifactType}.legacy`,
      retentionClass: "long-term-engineering-record",
      confidentiality: "internal",
      electronicSignoffRequired: true,
      relatedArtifactIds: [],
      regulatoryContexts: [],
    };
    metadata.documentControl.changeReason = `Canonicalized duplicate artifacts: ${mergedIds.join(", ")}`;
    metadata.documentControl.relatedArtifactIds = unique([...(metadata.documentControl.relatedArtifactIds ?? []), ...mergedIds]);
  }

  nextRecord = createRevision({
    record: canonical,
    createdBy: actor,
    summary: `Canonicalized ${mergedIds.length} duplicate artifact(s) into ${canonical.artifactId}`,
    approvalState: revision?.approvalState ?? "reviewed",
    content: nextContent,
    note: `Merged content from duplicate artifact(s): ${mergedIds.join(", ")}`,
    signoffs: revision?.signoffs ?? [],
    provenance: {
      ...(provenance ?? {
        runId: canonical.caseId,
        createdAt: new Date().toISOString(),
        createdBy: actor,
        source: "cateo-v1" as const,
        taskClass: metadata?.taskClass ?? "mixed",
        modelsUsed: [],
        evidenceFingerprint: metadata?.traceability.evidenceFingerprint ?? crypto.randomUUID(),
      }),
      createdAt: new Date().toISOString(),
      createdBy: actor,
    },
    metadata,
  });

  nextRecord.duplicateState = "canonical";
  nextRecord.canonicalArtifactId = nextRecord.artifactId;
  nextRecord.mergedSourceArtifactIds = unique([...(nextRecord.mergedSourceArtifactIds ?? []), ...mergedIds]);
  nextRecord.relatedArtifactIds = unique([...(nextRecord.relatedArtifactIds ?? []), ...mergedIds]);
  saveArtifactRecord(nextRecord);
  return nextRecord;
}

export function reconcileArtifactDuplicates(actor = "cateo-maintenance", requestId?: string): CateoDuplicateReconcileResult {
  const groups = duplicateGroups();
  const canonicalizedArtifacts: string[] = [];
  const supersededArtifacts: string[] = [];

  for (const group of groups) {
    const canonical = loadArtifactRecord(group.canonicalArtifactId);
    if (!canonical) {
      continue;
    }

    const duplicates = group.artifactIds.slice(1)
      .map((artifactId) => loadArtifactRecord(artifactId))
      .filter((record): record is CateoArtifactRecord => Boolean(record));
    if (duplicates.length === 0) {
      continue;
    }

    const canonicalAfterMerge = mergeDuplicateContent(canonical, duplicates, actor);
    canonicalAfterMerge.duplicateState = "canonical";
    canonicalAfterMerge.canonicalArtifactId = canonicalAfterMerge.artifactId;
    canonicalAfterMerge.duplicateGroupId = group.duplicateGroupId;
    canonicalAfterMerge.relatedArtifactIds = unique([...(canonicalAfterMerge.relatedArtifactIds ?? []), ...duplicates.map((record) => record.artifactId)]);
    canonicalAfterMerge.mergedSourceArtifactIds = unique([...(canonicalAfterMerge.mergedSourceArtifactIds ?? []), ...duplicates.map((record) => record.artifactId)]);
    ensureRelation(canonicalAfterMerge, makeArtifactRelation({ kind: "duplicate-of", targetType: "artifact", targetId: canonicalAfterMerge.artifactId, label: "Canonical artifact", strength: "exact", source: "merged" }));
    saveArtifactRecord(canonicalAfterMerge);
    canonicalizedArtifacts.push(canonicalAfterMerge.artifactId);

    for (const duplicate of duplicates) {
      duplicate.duplicateState = "duplicate";
      duplicate.canonicalArtifactId = canonicalAfterMerge.artifactId;
      duplicate.duplicateGroupId = group.duplicateGroupId;
      duplicate.supersededByArtifactId = canonicalAfterMerge.artifactId;
      duplicate.relatedArtifactIds = unique([...(duplicate.relatedArtifactIds ?? []), canonicalAfterMerge.artifactId]);
      const revision = duplicate.revisions.at(-1);
      if (revision?.metadata) {
        ensureMetadataDefaults(duplicate);
        revision.metadata.lifecycleState = "superseded";
        revision.metadata.changeHistory = [
          ...(revision.metadata.changeHistory ?? []),
          {
            changeId: crypto.randomUUID(),
            changedAt: new Date().toISOString(),
            actor,
            action: "superseded",
            summary: `Superseded by canonical artifact ${canonicalAfterMerge.artifactId}`,
            relatedCaseId: duplicate.caseId,
            relatedArtifactId: duplicate.artifactId,
          },
        ];
        revision.metadata.documentControl.supersededByArtifactId = canonicalAfterMerge.artifactId;
        revision.metadata.documentControl.changeReason = `Superseded by canonical artifact ${canonicalAfterMerge.artifactId} during duplicate reconciliation.`;
        revision.metadata.documentControl.relatedArtifactIds = unique([...(revision.metadata.documentControl.relatedArtifactIds ?? []), canonicalAfterMerge.artifactId]);
      }
      ensureRelation(duplicate, makeArtifactRelation({ kind: "duplicate-of", targetType: "artifact", targetId: canonicalAfterMerge.artifactId, label: currentSummary(canonicalAfterMerge), strength: "exact", source: "merged", tags: [group.duplicateGroupId] }));
      saveArtifactRecord(duplicate);
      supersededArtifacts.push(duplicate.artifactId);
    }

    for (const row of listCaseCatalogRows()) {
      const record = loadCaseRecord(row.caseId);
      if (!record) {
        continue;
      }
      const touched = duplicates.some((duplicate) => record.artifacts.includes(duplicate.artifactId));
      if (!touched) {
        continue;
      }
      record.artifacts = unique([canonicalAfterMerge.artifactId, ...record.artifacts]);
      saveCaseRecord(record);
    }

    appendAuditEvent({
      actor: "runtime",
      category: "cateo_deduplication",
      action: "baseline_reconcile",
      outcome: "success",
      message: `Canonicalized duplicate group ${group.duplicateGroupId}`,
      requestId,
      metadata: {
        canonicalArtifactId: canonicalAfterMerge.artifactId,
        duplicateGroupId: group.duplicateGroupId,
        supersededArtifacts: duplicates.map((duplicate) => duplicate.artifactId),
      },
    });
  }

  return {
    duplicateGroups: groups,
    canonicalizedArtifacts: unique(canonicalizedArtifacts),
    supersededArtifacts: unique(supersededArtifacts),
  };
}

export function listArtifactDuplicateGroups(): CateoDuplicateGroup[] {
  return duplicateGroups();
}
export interface CateoLegacyReleaseSweepResult {
  releasedCaseIds: string[];
  releasedArtifactIds: string[];
}

export function releaseHeldTroubleshootingCases(actor = "cateo-release-migration", requestId?: string): CateoLegacyReleaseSweepResult {
  const releasedCaseIds: string[] = [];
  const releasedArtifactIds: string[] = [];

  for (const row of listCaseCatalogRows()) {
    const record = loadCaseRecord(row.caseId);
    if (!record || record.context.taskClass !== "troubleshooting" || !record.interaction) {
      continue;
    }

    const workflowStage = record.reviewWorkflow?.stage;
    const needsRelease = record.interaction.releaseStatus === "pending-engineer-review"
      || workflowStage === "technical-review"
      || workflowStage === "quality-review";
    if (!needsRelease) {
      continue;
    }

    const now = new Date().toISOString();
    const refreshedArtifacts = record.artifacts
      .map((artifactId) => loadArtifactRecord(artifactId))
      .filter((artifact): artifact is NonNullable<ReturnType<typeof loadArtifactRecord>> => Boolean(artifact))
      .map((artifact) => {
        const latest = artifact.revisions.at(-1);
        if (!latest) {
          return artifact;
        }
        if (latest.approvalState === "approved") {
          return artifact;
        }
        const metadata = latest.metadata ? structuredClone(latest.metadata) : undefined;
        if (metadata) {
          metadata.approvalState = "approved";
          metadata.lifecycleState = "released";
          metadata.changeHistory = [
            ...(metadata.changeHistory ?? []),
            {
              changeId: crypto.randomUUID(),
              changedAt: now,
              actor,
              action: "legacy-review-retired",
              summary: `Released artifact after retiring legacy review workflow for case ${record.caseId}`,
              relatedCaseId: record.caseId,
              relatedArtifactId: artifact.artifactId,
              note: requestId ? `Request ${requestId}` : "Legacy review workflow retired.",
            },
          ];
          metadata.documentControl = metadata.documentControl ?? {
            recordClass: `${artifact.artifactType}.legacy`,
            retentionClass: "long-term-engineering-record",
            confidentiality: "internal",
            electronicSignoffRequired: true,
            relatedArtifactIds: [],
            regulatoryContexts: [],
          };
          metadata.documentControl.changeReason = "Legacy technical and quality review gates were retired and the artifact was promoted to released state.";
        }

        const signoffAt = now;
        const updated = createRevision({
          record: artifact,
          createdBy: actor,
          summary: `Released after legacy review workflow retirement for case ${record.caseId}`,
          approvalState: "approved",
          content: latest.content,
          note: "Cateo retired the legacy manual review workflow and promoted this troubleshooting artifact to released state.",
          signoffs: [...latest.signoffs, {
            actor,
            role: "system-release",
            meaning: "Legacy review retirement release",
            state: "approved",
            signedAt: signoffAt,
          }],
          provenance: {
            ...latest.provenance,
            requestId,
            createdAt: signoffAt,
            createdBy: actor,
          },
          metadata,
        });
        releasedArtifactIds.push(updated.artifactId);
        return updated;
      });

    record.interaction = {
      ...record.interaction,
      releaseStatus: "available",
      requiresEngineerReview: false,
    };
    if (record.reviewWorkflow) {
      record.reviewWorkflow = {
        ...record.reviewWorkflow,
        stage: "released",
        technical: {
          ...record.reviewWorkflow.technical,
          status: "approved",
          reviewerDisplayName: record.reviewWorkflow.technical.reviewerDisplayName || actor,
          decidedAt: record.reviewWorkflow.technical.decidedAt || now,
          note: record.reviewWorkflow.technical.note || "Legacy technical review lane retired and promoted to released state.",
        },
        quality: {
          ...record.reviewWorkflow.quality,
          status: "released",
          reviewerDisplayName: record.reviewWorkflow.quality.reviewerDisplayName || actor,
          decidedAt: record.reviewWorkflow.quality.decidedAt || now,
          note: record.reviewWorkflow.quality.note || "Legacy quality review lane retired and promoted to released state.",
        },
      };
    }
    if (refreshedArtifacts.length > 0) {
      const reportPackage = persistTroubleshootingReportPackage(record, refreshedArtifacts);
      syncCaseReviewPackageFiles(record, reportPackage.documentControl.files);
    }
    record.updatedAt = now;
    saveCaseRecord(record);
    releasedCaseIds.push(record.caseId);

    appendAuditEvent({
      actor: "system",
      category: "cateo_release",
      action: "legacy_review_retire",
      outcome: "success",
      message: `Released legacy held troubleshooting case ${record.caseId}`,
      requestId,
      metadata: {
        releasedBy: actor,
        caseId: record.caseId,
        artifactIds: refreshedArtifacts.map((artifact) => artifact.artifactId),
      },
    });
  }

  return {
    releasedCaseIds: unique(releasedCaseIds),
    releasedArtifactIds: unique(releasedArtifactIds),
  };
}