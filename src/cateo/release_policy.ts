import crypto from "node:crypto";
import { fingerprintEvidence } from "./store.js";
import type {
  CateoArtifactRecord,
  CateoCaseRecord,
  CateoCaseReleaseControl,
  CateoControlledSourceReference,
  CateoReleaseState,
  CateoReleaseTransition,
} from "./types.js";

export const CATEO_REVIEW_POLICY_VERSION = "cateo-human-review-v1";
export const CATEO_RELEASE_CONTROL_SCHEMA_VERSION = "cateo-release-control-v1";
export const CATEO_RETRIEVAL_POLICY_VERSION = "cateo-retrieval-policy-v1";

export interface CateoReviewPolicy {
  version: string;
  humanReviewRequired: true;
  sourceGroundingRequired: true;
  failClosed: true;
}

export function resolveCateoReviewPolicy(_configuration?: unknown): CateoReviewPolicy {
  return {
    version: CATEO_REVIEW_POLICY_VERSION,
    humanReviewRequired: true,
    sourceGroundingRequired: true,
    failClosed: true,
  };
}

function latestRevisions(artifacts: CateoArtifactRecord[]) {
  return artifacts
    .map((artifact) => ({ artifact, revision: artifact.revisions.at(-1) }))
    .filter((entry): entry is { artifact: CateoArtifactRecord; revision: NonNullable<typeof entry.revision> } => Boolean(entry.revision))
    .sort((left, right) => left.artifact.artifactId.localeCompare(right.artifact.artifactId));
}

/** Hashes immutable instruction content only; timestamps and mutable metadata are excluded. */
export function hashCurrentArtifactContent(artifacts: CateoArtifactRecord[]): string {
  return fingerprintEvidence(latestRevisions(artifacts).map(({ artifact, revision }) => ({
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    content: revision.content,
  })));
}

function currentRevisionIds(artifacts: CateoArtifactRecord[]): string[] {
  return latestRevisions(artifacts).map(({ revision }) => revision.revisionId);
}

function modelVersions(artifacts: CateoArtifactRecord[]): string[] {
  return [...new Set(latestRevisions(artifacts).flatMap(({ revision }) => revision.provenance.modelsUsed.map((model) => `${model.provider}:${model.model}`)))].sort();
}

function promptVersion(artifacts: CateoArtifactRecord[]): string | undefined {
  const versions = [...new Set(latestRevisions(artifacts).map(({ revision }) => revision.provenance.templateVersion).filter((value): value is string => Boolean(value)))];
  return versions.length > 0 ? versions.sort().join(",") : undefined;
}

function schemaVersion(artifacts: CateoArtifactRecord[]): string {
  const versions = [...new Set(artifacts.map((artifact) => `${artifact.schema.id}@${artifact.schema.version}`))].sort();
  return versions.length > 0 ? versions.join(",") : "no-artifact-schema";
}

function validSources(sources: CateoControlledSourceReference[]): CateoControlledSourceReference[] {
  return sources.filter((source) => Boolean(source.sourceId.trim() && source.revision.trim() && source.rightsClassification));
}

function makeTransition(args: {
  caseRecord: CateoCaseRecord;
  artifacts: CateoArtifactRecord[];
  idempotencyKey: string;
  actorId: string;
  actorDisplayName: string;
  actorRole: string;
  priorState: CateoReleaseState | null;
  newState: CateoReleaseState;
  reason: string;
  occurredAt?: string;
}): CateoReleaseTransition {
  return {
    transitionId: crypto.randomUUID(),
    idempotencyKey: args.idempotencyKey,
    actorId: args.actorId,
    actorDisplayName: args.actorDisplayName,
    actorRole: args.actorRole,
    occurredAt: args.occurredAt ?? new Date().toISOString(),
    priorState: args.priorState,
    newState: args.newState,
    reason: args.reason,
    contentHash: hashCurrentArtifactContent(args.artifacts),
    artifactRevisionIds: currentRevisionIds(args.artifacts),
    policyVersion: CATEO_REVIEW_POLICY_VERSION,
    schemaVersion: schemaVersion(args.artifacts),
    promptVersion: promptVersion(args.artifacts),
    retrievalVersion: CATEO_RETRIEVAL_POLICY_VERSION,
    modelVersions: modelVersions(args.artifacts),
  };
}

export function initializeCaseReleaseControl(
  caseRecord: CateoCaseRecord,
  artifacts: CateoArtifactRecord[],
  sources: CateoControlledSourceReference[] = [],
): CateoCaseReleaseControl {
  if (caseRecord.releaseControl) {
    return caseRecord.releaseControl;
  }
  const acceptedSources = validSources(sources);
  const contentHash = hashCurrentArtifactContent(artifacts);
  const idempotencyKey = `${caseRecord.caseId}:release-control-created`;
  const transition = makeTransition({
    caseRecord,
    artifacts,
    idempotencyKey,
    actorId: "system",
    actorDisplayName: "Cateo release controller",
    actorRole: "system",
    priorState: null,
    newState: "UNREVIEWED",
    reason: "Generated troubleshooting content entered the controlled review workflow.",
  });
  const control: CateoCaseReleaseControl = {
    schemaVersion: CATEO_RELEASE_CONTROL_SCHEMA_VERSION,
    policyVersion: CATEO_REVIEW_POLICY_VERSION,
    state: "UNREVIEWED",
    version: 1,
    currentContentHash: contentHash,
    rejectedContentHashes: [],
    sourceGrounding: {
      status: acceptedSources.length > 0 && acceptedSources.length === sources.length ? "VERIFIED" : sources.length > 0 ? "PARTIAL" : "MISSING",
      sources: acceptedSources,
    },
    transitions: [transition],
    processedIdempotencyKeys: [idempotencyKey],
  };
  caseRecord.releaseControl = control;
  return control;
}

function ensureControl(caseRecord: CateoCaseRecord, artifacts: CateoArtifactRecord[]): CateoCaseReleaseControl {
  return initializeCaseReleaseControl(caseRecord, artifacts);
}

function assertExpectedVersion(control: CateoCaseReleaseControl, expectedVersion?: number): void {
  if (expectedVersion !== undefined && expectedVersion !== control.version) {
    throw new Error(`Review state changed from expected version ${expectedVersion}; reload before deciding.`);
  }
}

function hasProcessed(control: CateoCaseReleaseControl, idempotencyKey: string): boolean {
  return control.processedIdempotencyKeys.includes(idempotencyKey);
}

function recordTransition(
  control: CateoCaseReleaseControl,
  transition: CateoReleaseTransition,
): void {
  control.state = transition.newState;
  control.currentContentHash = transition.contentHash;
  control.version += 1;
  control.transitions.push(transition);
  control.processedIdempotencyKeys = [...new Set([...control.processedIdempotencyKeys, transition.idempotencyKey])];
}

function resetForChangedContent(args: {
  caseRecord: CateoCaseRecord;
  artifacts: CateoArtifactRecord[];
  control: CateoCaseReleaseControl;
  idempotencyKey: string;
  actorId: string;
  actorDisplayName: string;
  actorRole: string;
}): void {
  const hash = hashCurrentArtifactContent(args.artifacts);
  if (hash === args.control.currentContentHash) {
    return;
  }
  const transition = makeTransition({
    ...args,
    idempotencyKey: `${args.idempotencyKey}:content-revision`,
    priorState: args.control.state,
    newState: "UNREVIEWED",
    reason: "A substantive content revision invalidated prior review decisions.",
  });
  recordTransition(args.control, transition);
  args.control.technicalReview = undefined;
  args.control.qualityApproval = undefined;
}

export function submitTechnicalReview(args: {
  caseRecord: CateoCaseRecord;
  artifacts: CateoArtifactRecord[];
  actorId: string;
  actorDisplayName: string;
  actorRole: string;
  action: "approve" | "reject";
  reason: string;
  idempotencyKey: string;
  expectedVersion?: number;
}): { control: CateoCaseReleaseControl; idempotent: boolean } {
  if (args.actorRole !== "technical-reviewer") {
    throw new Error("Technical reviewer authorization is required.");
  }
  const control = ensureControl(args.caseRecord, args.artifacts);
  if (hasProcessed(control, args.idempotencyKey)) {
    return { control, idempotent: true };
  }
  assertExpectedVersion(control, args.expectedVersion);
  resetForChangedContent({ ...args, control });
  const hash = hashCurrentArtifactContent(args.artifacts);
  if (control.state === "REJECTED" && control.rejectedContentHashes.includes(hash)) {
    throw new Error("Rejected content is unchanged. Create a substantive revision before requesting a new review.");
  }
  if (control.state === "APPROVED" && control.currentContentHash === hash) {
    throw new Error("Approved content has not changed and cannot re-enter technical review.");
  }
  if (control.state === "TECHNICAL_REVIEWED" && control.currentContentHash === hash) {
    throw new Error("This content revision has already completed technical review.");
  }

  const nextState: CateoReleaseState = args.action === "approve" ? "TECHNICAL_REVIEWED" : "REJECTED";
  const transition = makeTransition({
    ...args,
    priorState: control.state,
    newState: nextState,
  });
  recordTransition(control, transition);
  if (nextState === "REJECTED") {
    control.rejectedContentHashes = [...new Set([...control.rejectedContentHashes, transition.contentHash])];
    control.technicalReview = undefined;
  } else {
    control.technicalReview = {
      actorId: args.actorId,
      actorDisplayName: args.actorDisplayName,
      contentHash: transition.contentHash,
      reviewedAt: transition.occurredAt,
    };
  }
  control.qualityApproval = undefined;
  return { control, idempotent: false };
}

export function approveControlledRelease(args: {
  caseRecord: CateoCaseRecord;
  artifacts: CateoArtifactRecord[];
  actorId: string;
  actorDisplayName: string;
  actorRole: "quality-reviewer" | "admin";
  reason: string;
  idempotencyKey: string;
  expectedVersion?: number;
}): { control: CateoCaseReleaseControl; idempotent: boolean } {
  if (args.actorRole !== "quality-reviewer" && args.actorRole !== "admin") {
    throw new Error("Reviewer authorization is required to approve a controlled release.");
  }
  const control = ensureControl(args.caseRecord, args.artifacts);
  if (hasProcessed(control, args.idempotencyKey)) {
    return { control, idempotent: true };
  }
  assertExpectedVersion(control, args.expectedVersion);
  const hash = hashCurrentArtifactContent(args.artifacts);
  if (control.state === "APPROVED" && control.currentContentHash === hash) {
    control.processedIdempotencyKeys = [...new Set([...control.processedIdempotencyKeys, args.idempotencyKey])];
    return { control, idempotent: true };
  }
  if (hash !== control.currentContentHash || control.technicalReview?.contentHash !== hash) {
    resetForChangedContent({ ...args, control });
    throw new Error("Content changed after technical review. A new technical review is required.");
  }
  if (control.state !== "TECHNICAL_REVIEWED" || !control.technicalReview) {
    throw new Error("Technical review must approve the current content revision before release.");
  }
  if (control.technicalReview.actorId === args.actorId) {
    throw new Error("Quality release must be performed by a different authorized reviewer.");
  }
  if (control.sourceGrounding.status !== "VERIFIED" || control.sourceGrounding.sources.length === 0) {
    throw new Error("Controlled source identity, revision, and rights approval are required before release.");
  }

  const transition = makeTransition({
    ...args,
    priorState: control.state,
    newState: "APPROVED",
  });
  recordTransition(control, transition);
  control.qualityApproval = {
    actorId: args.actorId,
    actorDisplayName: args.actorDisplayName,
    contentHash: transition.contentHash,
    approvedAt: transition.occurredAt,
  };
  return { control, idempotent: false };
}

export function recordCustomerRejection(args: {
  caseRecord: CateoCaseRecord;
  artifacts: CateoArtifactRecord[];
  actorId: string;
  actorDisplayName: string;
  reason: string;
  idempotencyKey: string;
}): { control: CateoCaseReleaseControl; idempotent: boolean } {
  const control = ensureControl(args.caseRecord, args.artifacts);
  if (hasProcessed(control, args.idempotencyKey)) {
    return { control, idempotent: true };
  }
  const hash = hashCurrentArtifactContent(args.artifacts);
  if (control.state === "REJECTED" && control.rejectedContentHashes.includes(hash)) {
    control.processedIdempotencyKeys = [...new Set([...control.processedIdempotencyKeys, args.idempotencyKey])];
    return { control, idempotent: true };
  }
  const transition = makeTransition({
    ...args,
    actorRole: "customer",
    priorState: control.state,
    newState: "REJECTED",
  });
  recordTransition(control, transition);
  control.rejectedContentHashes = [...new Set([...control.rejectedContentHashes, hash])];
  control.technicalReview = undefined;
  control.qualityApproval = undefined;
  return { control, idempotent: false };
}

export function isCurrentContentReleased(caseRecord: CateoCaseRecord, artifacts: CateoArtifactRecord[]): boolean {
  const control = caseRecord.releaseControl;
  return Boolean(
    control
    && control.policyVersion === CATEO_REVIEW_POLICY_VERSION
    && control.state === "APPROVED"
    && control.currentContentHash === hashCurrentArtifactContent(artifacts)
    && control.qualityApproval?.contentHash === control.currentContentHash
    && control.sourceGrounding.status === "VERIFIED",
  );
}
