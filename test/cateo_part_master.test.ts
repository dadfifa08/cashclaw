import { describe, expect, it } from "vitest";
import { buildCateoApprovalMatrix } from "../src/cateo/approval_matrix.js";
import { buildCateoPartMaster } from "../src/cateo/part_master.js";
import type { CateoArtifactRecord, CateoCaseRecord } from "../src/cateo/types.js";

function makeArtifact(partNumber: string, approvalState: "draft" | "reviewed" | "approved", duplicateState?: "canonical" | "duplicate") {
  return {
    artifactId: `artifact-${partNumber}-${approvalState}`,
    artifactType: "service-report",
    caseId: "case-1",
    currentRevisionId: `rev-${approvalState}`,
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z",
    duplicateState,
    revisions: [
      {
        revisionId: `rev-${approvalState}`,
        revisionNumber: 1,
        approvalState,
        createdAt: "2026-03-21T00:00:00.000Z",
        createdBy: "cateo",
        summary: "Structured service report",
        diffFromPrevious: [],
        signoffs: approvalState === "approved" ? [{ actor: "qa", role: "quality-approver", meaning: "Release", state: "approved", signedAt: "2026-03-21T01:00:00.000Z" }] : [],
        provenance: {
          runId: "run-1",
          createdAt: "2026-03-21T00:00:00.000Z",
          createdBy: "cateo",
          source: "cateo-v1",
          taskClass: "documentation",
          modelsUsed: [],
          evidenceFingerprint: "fingerprint",
        },
        metadata: {
          artifactTitle: "Controlled service report",
          artifactSummary: "Controlled service report",
          taskClass: "documentation",
          approvalState,
          confidence: "high",
          riskLevel: "high",
          lifecycleState: "active",
          taxonomyTags: ["quality"],
          partNumber,
          partDescription: "Pump seal assembly",
          taxonomy: {
            domain: "documentation",
            componentPath: ["pump", "seal"],
            locationPath: ["plant", "line-1"],
            subsystem: "fluid-path",
          },
          classification: {
            failureCode: "E-441",
            failureLabel: "Seal leakage",
            failureMode: "seal leakage",
            symptomSummary: ["leak observed"],
          },
          asset: {
            assetId: "P-100",
            manufacturer: "Acme",
            model: "Pump-X",
            locationHierarchy: ["plant", "line-1"],
            configuration: {},
          },
          workOrder: {
            workOrderId: "WO-55",
            priority: "high",
            status: "open",
          },
          parts: {
            primaryPartNumber: partNumber,
            primaryPartDescription: "Pump seal assembly",
            candidateSkus: [partNumber],
            requiredPartLines: [{ partNumber, description: "Pump seal assembly", manufacturer: "Acme" }],
            billOfMaterialsRefs: [],
            interchangeablePartNumbers: ["PSA-100-ALT"],
          },
          evidence: {
            attachmentIds: ["att-1"],
            attachmentNames: ["photo.png"],
            evidenceSummary: ["photo evidence"],
            serviceHistoryCount: 1,
            documentRefs: ["photo.png"],
            measuredCriteria: ["leak < 2 mL/min"],
          },
          maintenance: {
            serviceHistorySummaries: ["Seal changed"],
            recurringFailureCodes: ["E-441"],
            recurringPartSkus: [partNumber],
          },
          media: {
            attachmentKinds: ["image"],
            imageCount: 1,
            videoCount: 0,
            documentCount: 0,
            derivedMeasurements: [],
            analysisSignals: [],
          },
          actions: {
            recommendedActions: ["Replace seal"],
            validationSteps: ["Pressure test"],
            requiredParts: [partNumber],
            requiredTools: ["wrench"],
            followUpActions: ["inspect housing"],
          },
          relations: [],
          traceability: {
            caseId: "case-1",
            runId: "run-1",
            requesterId: "requester-1",
            promptFingerprint: "prompt",
            evidenceFingerprint: "evidence",
          },
          analytics: {
            artifactKeywords: ["seal"],
            recurringSignals: ["leak"],
            estimatedRevisionCount: 1,
          },
          governance: {
            schemaId: "cateo.service-report",
            schemaVersion: "1.0",
            validationStatus: "validated",
            ruleEscalationCount: 0,
            retryCount: 0,
            activeSkillIds: [],
            activeAdapterIds: [],
          },
          documentControl: {
            recordClass: "quality-record",
            retentionClass: "gxp",
            confidentiality: "internal",
            electronicSignoffRequired: true,
            relatedArtifactIds: [],
            regulatoryContexts: ["FDA"],
          },
        },
        content: {
          title: "Controlled service report",
          summary: "Structured service report",
          findings: ["Seal leakage"],
          actionsPerformed: ["Prepared artifact"],
          unresolvedRisks: [],
          recommendations: ["Replace seal"],
          signoffRequirement: "QA release",
        },
      },
    ],
    schema: { id: "cateo.service-report", version: "1.0" },
  } as unknown as CateoArtifactRecord;
}

function makeCase(): CateoCaseRecord {
  return {
    caseId: "case-1",
    runId: "run-1",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z",
    input: {
      symptomDescription: "Draft a validation package for part PSA-100.",
      productOffering: "validation-qualification-protocol",
      partNumber: "PSA-100",
      workflow: {
        mode: "reviewed-document",
        riskTier: "high",
      },
    },
    context: {
      caseId: "case-1",
      title: "Validation package",
      taskClass: "documentation",
      asset: { assetId: "P-100", locationHierarchy: ["plant", "line-1"] },
      machine: { manufacturer: "Acme", locationHierarchy: ["plant", "line-1"] },
      workOrder: { workOrderId: "WO-55" },
      failureCode: { code: "E-441", label: "Seal leakage" },
      partResolution: {
        partNumber: "PSA-100",
        partDescription: "Pump seal assembly",
        manufacturer: "Acme",
        confidencePct: 96,
        needsClarification: false,
        evidence: ["artifact metadata"],
        aliases: ["PSA 100"],
        searchQueries: [],
        failureModes: ["seal leakage"],
        preventiveMaintenanceHints: ["inspect seal"],
        verifiedSources: [],
      },
      observedConditions: ["leak observed"],
      serviceHistory: [],
      suggestedParts: [],
      attachments: [],
      taxonomy: {},
      digitalTwin: null,
      contextSummary: ["validation package required"],
    },
    artifacts: ["artifact-PSA-100-draft"],
    interaction: {
      message: "Queued for review.",
      highlights: ["Validation package drafted."],
      nextActions: ["Await QA release."],
      confidence: "high",
      artifactCount: 1,
      artifactLabels: ["service-report"],
      releaseStatus: "pending-engineer-review",
      requiresEngineerReview: true,
      renderedAt: "2026-03-21T00:00:00.000Z",
      rendererVersion: "1",
    },
    requester: {
      requesterId: "requester-1",
      serviceTier: "reviewed",
      requiresEngineerReview: true,
    },
    trace: {
      route: { taskClass: "documentation", requestedArtifacts: ["service-report"], useChallenger: true, useStructure: true, reasons: [] },
      template: { templateId: "validation", version: "1", taskClass: "documentation", responseBehavior: [], terminology: [], fieldExpectations: [], outputConstraints: [], requiredArtifacts: ["service-report"] },
      validationAttempts: [],
      ruleResults: [],
      lookupCandidates: [],
      persistActions: [],
      prompts: { planner: "", builder: "", reviewer: "" },
      leadPlan: { taskClass: "documentation", objective: "", evidencePlan: [], assumptions: [], risks: [], decisionBasis: [], artifactPriorities: ["service-report"], maintenanceConsiderations: [], partsConsiderations: [] },
      finalSynthesis: { executiveSummary: "", decision: "draft", confidence: "high", rootCauseStatement: "", nextActions: [], operatorNotes: [] },
      reviewerDecision: { overallStatus: "pass", technicalAccuracy: "pass", completeness: "pass", compliance: "pass", findings: [], approvedArtifactTypes: ["service-report"], approvalState: "reviewed", confidence: "high", summary: "ready", requiredFollowUp: [] },
    },
  } as unknown as CateoCaseRecord;
}

describe("Cateo part master and approval matrix", () => {
  it("builds canonical part records from artifact metadata", () => {
    const snapshot = buildCateoPartMaster({
      artifactRecords: [makeArtifact("PSA-100", "approved"), makeArtifact("PSA-100", "draft", "duplicate")],
      caseRecords: [makeCase()],
    });

    expect(snapshot.stats.partCount).toBe(1);
    expect(snapshot.parts[0]?.canonicalPartNumber).toBe("PSA-100");
    expect(snapshot.parts[0]?.releasedArtifactCount).toBe(1);
    expect(snapshot.parts[0]?.duplicateArtifactCount).toBe(1);
    expect(snapshot.parts[0]?.failureCodes).toContain("E-441");
  });

  it("requires stronger approval gates for high-risk reviewed documents", () => {
    const matrix = buildCateoApprovalMatrix(makeCase(), [makeArtifact("PSA-100", "draft")]);
    expect(matrix.documentClass).toBe("validation-protocol");
    expect(matrix.steps.find((step) => step.stepId === "technical-review")?.required).toBe(true);
    expect(matrix.steps.find((step) => step.stepId === "qa-approval")?.required).toBe(true);
    expect(matrix.steps.find((step) => step.stepId === "release")?.status).not.toBe("complete");
  });
});
