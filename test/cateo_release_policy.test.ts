import { describe, expect, it } from "vitest";
import {
  approveControlledRelease,
  hashCurrentArtifactContent,
  initializeCaseReleaseControl,
  resolveCateoReviewPolicy,
  submitTechnicalReview,
} from "../src/cateo/release_policy.js";
import type { CateoArtifactRecord, CateoCaseRecord, CateoTroubleshootingProcedure } from "../src/cateo/types.js";

function procedure(action = "Inspect the connector."): CateoTroubleshootingProcedure {
  return {
    title: "Connector troubleshooting",
    objective: "Identify the reported connector fault.",
    symptoms: ["Intermittent signal"],
    assumptions: [],
    evidenceSummary: [],
    safetyPrecautions: ["De-energize before intrusive inspection."],
    requiredParts: [],
    requiredTools: [],
    steps: [{ id: "step-1", action, rationale: "Confirm the physical condition.", expectedResult: "Connector condition is known." }],
    acceptanceCriteria: ["Signal is stable."],
    followUpActions: [],
  };
}

function artifact(content = procedure(), revisionId = "revision-1"): CateoArtifactRecord {
  return {
    artifactId: "artifact-1",
    artifactType: "troubleshooting-procedure",
    schema: { id: "cateo.troubleshooting-procedure", version: "1.0" },
    caseId: "case-1",
    currentRevisionId: revisionId,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    revisions: [{
      revisionId,
      revisionNumber: revisionId === "revision-1" ? 1 : 2,
      approvalState: "draft",
      createdAt: "2026-08-29T00:00:00.000Z",
      createdBy: "runtime",
      summary: "Draft procedure",
      diffFromPrevious: [],
      signoffs: [],
      provenance: {
        runId: "run-1",
        createdAt: "2026-08-29T00:00:00.000Z",
        createdBy: "runtime",
        source: "cateo-v1",
        taskClass: "troubleshooting",
        modelsUsed: [],
        evidenceFingerprint: "evidence",
        templateVersion: "1.0",
      },
      content,
    }],
  };
}

function caseRecord(): CateoCaseRecord {
  return {
    caseId: "case-1",
    runId: "run-1",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    input: { symptomDescription: "Intermittent signal" },
    context: { caseId: "case-1", title: "Connector fault" } as CateoCaseRecord["context"],
    artifacts: ["artifact-1"],
    trace: {} as CateoCaseRecord["trace"],
  };
}

const source = {
  sourceId: "manual-family-a",
  revision: "rev-4",
  locator: "section-7",
  rightsClassification: "customer-authorized" as const,
};

describe("Cateo controlled release policy", () => {
  it("fails closed when review configuration is missing", () => {
    expect(resolveCateoReviewPolicy(undefined)).toEqual(expect.objectContaining({
      humanReviewRequired: true,
      sourceGroundingRequired: true,
      failClosed: true,
    }));
  });

  it("never treats generated content as human approved and rejects unauthorized decisions", () => {
    const record = caseRecord();
    const artifacts = [artifact()];
    const control = initializeCaseReleaseControl(record, artifacts, [source]);
    expect(control.state).toBe("UNREVIEWED");
    expect(() => submitTechnicalReview({
      caseRecord: record,
      artifacts,
      actorId: "user-1",
      actorDisplayName: "Operator",
      actorRole: "user",
      action: "approve",
      reason: "Looks fine",
      idempotencyKey: "decision-1",
    })).toThrow(/authorization/i);
  });

  it("preserves a rejected revision and blocks unchanged resubmission", () => {
    const record = caseRecord();
    const original = artifact();
    initializeCaseReleaseControl(record, [original], [source]);
    submitTechnicalReview({
      caseRecord: record,
      artifacts: [original],
      actorId: "tech-1",
      actorDisplayName: "Technical Reviewer",
      actorRole: "technical-reviewer",
      action: "reject",
      reason: "Step is incomplete.",
      idempotencyKey: "reject-1",
    });
    expect(record.releaseControl?.state).toBe("REJECTED");
    expect(() => submitTechnicalReview({
      caseRecord: record,
      artifacts: [original],
      actorId: "tech-1",
      actorDisplayName: "Technical Reviewer",
      actorRole: "technical-reviewer",
      action: "approve",
      reason: "Retry",
      idempotencyKey: "retry-unchanged",
    })).toThrow(/unchanged/i);
    expect(original.revisions).toHaveLength(1);
  });

  it("requires a substantive revision, a new technical review, and a separate quality approver", () => {
    const record = caseRecord();
    const original = artifact();
    initializeCaseReleaseControl(record, [original], [source]);
    submitTechnicalReview({ caseRecord: record, artifacts: [original], actorId: "tech-1", actorDisplayName: "Technical Reviewer", actorRole: "technical-reviewer", action: "reject", reason: "Revise the action.", idempotencyKey: "reject-1" });

    const revised = artifact(procedure("Inspect and reseat the de-energized connector."), "revision-2");
    const firstVersion = record.releaseControl?.version;
    submitTechnicalReview({ caseRecord: record, artifacts: [revised], actorId: "tech-1", actorDisplayName: "Technical Reviewer", actorRole: "technical-reviewer", action: "approve", reason: "Revision addresses the redline.", idempotencyKey: "technical-2", expectedVersion: firstVersion });
    expect(record.releaseControl?.state).toBe("TECHNICAL_REVIEWED");
    expect(record.releaseControl?.currentContentHash).toBe(hashCurrentArtifactContent([revised]));
    expect(record.releaseControl?.transitions.map((entry) => [entry.priorState, entry.newState])).toContainEqual(["REJECTED", "UNREVIEWED"]);

    expect(() => approveControlledRelease({ caseRecord: record, artifacts: [revised], actorId: "user-1", actorDisplayName: "Operator", actorRole: "user" as "quality-reviewer", reason: "Unauthorized approval", idempotencyKey: "release-unauthorized" })).toThrow(/authorization/i);
    expect(() => approveControlledRelease({ caseRecord: record, artifacts: [revised], actorId: "tech-1", actorDisplayName: "Technical Reviewer", actorRole: "quality-reviewer", reason: "Self approval", idempotencyKey: "release-self" })).toThrow(/different authorized reviewer/i);
    const release = approveControlledRelease({ caseRecord: record, artifacts: [revised], actorId: "quality-1", actorDisplayName: "Quality Reviewer", actorRole: "quality-reviewer", reason: "Approved against controlled source.", idempotencyKey: "release-1" });
    expect(release.control.state).toBe("APPROVED");
    const historyLength = release.control.transitions.length;
    const repeated = approveControlledRelease({ caseRecord: record, artifacts: [revised], actorId: "quality-1", actorDisplayName: "Quality Reviewer", actorRole: "quality-reviewer", reason: "Retry", idempotencyKey: "release-1" });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.control.transitions).toHaveLength(historyLength);
    expect(repeated.control.transitions.every((entry) => entry.actorId && entry.actorRole && entry.occurredAt && entry.contentHash && entry.policyVersion && entry.schemaVersion)).toBe(true);
  });

  it("rejects stale concurrent decisions and release without controlled source grounding", () => {
    const record = caseRecord();
    const artifacts = [artifact()];
    initializeCaseReleaseControl(record, artifacts);
    const expectedVersion = record.releaseControl?.version;
    submitTechnicalReview({ caseRecord: record, artifacts, actorId: "tech-1", actorDisplayName: "Technical Reviewer", actorRole: "technical-reviewer", action: "approve", reason: "Reviewed", idempotencyKey: "technical-1", expectedVersion });
    expect(() => submitTechnicalReview({ caseRecord: record, artifacts, actorId: "tech-2", actorDisplayName: "Other Reviewer", actorRole: "technical-reviewer", action: "reject", reason: "Concurrent rejection", idempotencyKey: "technical-2", expectedVersion })).toThrow(/expected version/i);
    expect(() => approveControlledRelease({ caseRecord: record, artifacts, actorId: "quality-1", actorDisplayName: "Quality Reviewer", actorRole: "quality-reviewer", reason: "Release", idempotencyKey: "release-1" })).toThrow(/source identity/i);
  });
});
