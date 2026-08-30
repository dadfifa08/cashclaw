import type { CateoArtifactRecord, CateoCaseRecord, CateoInteractionReleaseStatus, CateoRiskTier, CateoServiceTier, CateoWorkflowMode } from "./types.js";

export type CateoDocumentClass =
  | "conversational-assist"
  | "reviewed-engineering-document"
  | "deviation-investigation"
  | "audit-package"
  | "work-instruction"
  | "validation-protocol"
  | "risk-analysis"
  | "maintenance-package"
  | "digital-twin-package";

export type CateoApprovalGateStatus = "complete" | "pending" | "blocked" | "not-required";

export interface CateoApprovalMatrixStep {
  stepId: string;
  label: string;
  role: string;
  required: boolean;
  status: CateoApprovalGateStatus;
  reasonCode: string;
  justificationRequired: boolean;
  electronicSignatureRequired: boolean;
  segregationOfDuties: boolean;
  notes: string[];
}

export interface CateoApprovalMatrix {
  documentClass: CateoDocumentClass;
  riskTier: CateoRiskTier;
  workflowMode: CateoWorkflowMode;
  serviceTier: CateoServiceTier;
  releaseStatus: CateoInteractionReleaseStatus;
  steps: CateoApprovalMatrixStep[];
  summary: {
    requiredCount: number;
    completeCount: number;
    pendingCount: number;
    blockedCount: number;
  };
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export function deriveCateoDocumentClass(record: CateoCaseRecord): CateoDocumentClass {
  const offering = record.input.productOffering;
  if (offering === "deviation-investigation-report") return "deviation-investigation";
  if (offering === "audit-ready-documentation-package") return "audit-package";
  if (offering === "work-instructions-sop") return "work-instruction";
  if (offering === "validation-qualification-protocol") return "validation-protocol";
  if (offering === "fmea") return "risk-analysis";
  if (offering === "preventive-maintenance-report") return "maintenance-package";
  if (offering === "digital-twin-comparison-report" || offering === "camera-based-diagnostic-report") return "digital-twin-package";
  return record.input.workflow?.mode === "reviewed-document" ? "reviewed-engineering-document" : "conversational-assist";
}

function artifactsReadyForManualReview(artifacts: CateoArtifactRecord[]): boolean {
  return artifacts.length > 0 && artifacts.every((artifact) => {
    const latest = artifact.revisions.at(-1);
    return latest?.approvalState === "draft" || latest?.approvalState === "reviewed" || latest?.approvalState === "approved";
  });
}

function requiresHumanReview(_args: { workflowMode: CateoWorkflowMode; serviceTier: CateoServiceTier; riskTier: CateoRiskTier; documentClass: CateoDocumentClass }): boolean {
  return true;
}

function requiresQaApproval(args: { riskTier: CateoRiskTier; documentClass: CateoDocumentClass }): boolean {
  void args;
  return true;
}

function requiresElectronicSignature(args: { riskTier: CateoRiskTier; documentClass: CateoDocumentClass }): boolean {
  return args.riskTier === "critical"
    || args.documentClass === "validation-protocol"
    || args.documentClass === "audit-package";
}

export function buildCateoApprovalMatrix(record: CateoCaseRecord, artifacts: CateoArtifactRecord[]): CateoApprovalMatrix {
  const workflowMode = record.input.workflow?.mode ?? "chat";
  const serviceTier = record.requester?.serviceTier ?? "free";
  const riskTier = record.input.workflow?.riskTier ?? "medium";
  const releaseStatus = record.interaction?.releaseStatus ?? "pending-engineer-review";
  const documentClass = deriveCateoDocumentClass(record);
  const reviewerDecision = record.trace.reviewerDecision;
  const aiDraftReady = artifacts.length > 0;
  const aiReviewComplete = Boolean(reviewerDecision && reviewerDecision.overallStatus === "pass");
  const aiReviewBlocked = reviewerDecision?.overallStatus === "needs-revision";
  const humanReviewRequired = requiresHumanReview({ workflowMode, serviceTier, riskTier, documentClass });
  const qaRequired = requiresQaApproval({ riskTier, documentClass });
  const esignRequired = requiresElectronicSignature({ riskTier, documentClass });
  const manualReviewComplete = record.releaseControl?.state === "TECHNICAL_REVIEWED" || record.releaseControl?.state === "APPROVED";
  const qaApprovalComplete = record.releaseControl?.state === "APPROVED";
  const partResolved = Boolean(record.context.partResolution?.partNumber ?? record.input.partNumber);
  const steps: CateoApprovalMatrixStep[] = [
    {
      stepId: "intake",
      label: "Structured intake",
      role: "requester",
      required: true,
      status: "complete",
      reasonCode: workflowMode === "reviewed-document" ? "REVIEWED_DOCUMENT_REQUEST" : "CHAT_REQUEST",
      justificationRequired: workflowMode === "reviewed-document",
      electronicSignatureRequired: false,
      segregationOfDuties: false,
      notes: unique([
        record.input.workflow?.documentIntent,
        record.input.workflow?.businessJustification,
        record.input.workflow?.drjJustification,
      ]),
    },
    {
      stepId: "classification",
      label: "Part and taxonomy classification",
      role: "planner",
      required: true,
      status: partResolved ? "complete" : "pending",
      reasonCode: partResolved ? "PART_CLASSIFIED" : "PART_UNRESOLVED",
      justificationRequired: false,
      electronicSignatureRequired: false,
      segregationOfDuties: false,
      notes: unique([
        record.context.partResolution?.partNumber ? `Part ${record.context.partResolution.partNumber} resolved.` : "Part master still needs a canonical part number.",
        record.context.failureCode?.code ? `Failure code ${record.context.failureCode.code} classified.` : undefined,
      ]),
    },
    {
      stepId: "ai-draft",
      label: "AI draft package",
      role: "builder",
      required: true,
      status: aiDraftReady ? "complete" : "pending",
      reasonCode: aiDraftReady ? "ARTIFACTS_GENERATED" : "ARTIFACTS_PENDING",
      justificationRequired: false,
      electronicSignatureRequired: false,
      segregationOfDuties: false,
      notes: [`${artifacts.length} artifact(s) generated.`],
    },
    {
      stepId: "ai-review",
      label: "Second-agent review",
      role: "reviewer-model",
      required: true,
      status: aiReviewBlocked ? "blocked" : aiReviewComplete ? "complete" : "pending",
      reasonCode: aiReviewBlocked ? "MODEL_REVIEW_NEEDS_REVISION" : aiReviewComplete ? "MODEL_REVIEW_PASSED" : "MODEL_REVIEW_PENDING",
      justificationRequired: false,
      electronicSignatureRequired: false,
      segregationOfDuties: true,
      notes: unique([reviewerDecision?.summary, ...(reviewerDecision?.requiredFollowUp ?? [])]),
    },
    {
      stepId: "technical-review",
      label: "Human technical review",
      role: "engineer-reviewer",
      required: humanReviewRequired,
      status: !humanReviewRequired ? "not-required" : manualReviewComplete ? "complete" : artifactsReadyForManualReview(artifacts) ? "pending" : "blocked",
      reasonCode: !humanReviewRequired ? "LOW_RISK_CHAT" : manualReviewComplete ? "ENGINEER_REVIEW_COMPLETE" : artifactsReadyForManualReview(artifacts) ? "ENGINEER_REVIEW_REQUIRED" : "PACKAGE_NOT_READY",
      justificationRequired: true,
      electronicSignatureRequired: false,
      segregationOfDuties: true,
      notes: unique([
        serviceTier !== "free" ? `Service tier ${serviceTier} requires controlled review.` : undefined,
        workflowMode === "reviewed-document" ? "Reviewed-document workflow enforces a human technical gate." : undefined,
      ]),
    },
    {
      stepId: "qa-approval",
      label: "Quality approval",
      role: "quality-approver",
      required: qaRequired,
      status: !qaRequired ? "not-required" : qaApprovalComplete ? "complete" : manualReviewComplete ? "pending" : "blocked",
      reasonCode: !qaRequired ? "QA_OPTIONAL" : qaApprovalComplete ? "QA_APPROVED" : manualReviewComplete ? "QA_REQUIRED" : "UPSTREAM_REVIEW_PENDING",
      justificationRequired: true,
      electronicSignatureRequired: esignRequired,
      segregationOfDuties: true,
      notes: unique([
        `Document class ${documentClass}.`,
        `Risk tier ${riskTier}.`,
      ]),
    },
    {
      stepId: "release",
      label: "Controlled customer release",
      role: "admin-release",
      required: true,
      status: releaseStatus === "available" ? "complete" : releaseStatus === "clarification-required" ? "blocked" : qaRequired && !qaApprovalComplete ? "blocked" : humanReviewRequired && !manualReviewComplete ? "pending" : "pending",
      reasonCode: releaseStatus === "available" ? "RELEASED" : releaseStatus === "clarification-required" ? "CLARIFICATION_REQUIRED" : "RELEASE_PENDING",
      justificationRequired: true,
      electronicSignatureRequired: esignRequired,
      segregationOfDuties: true,
      notes: unique([
        record.interaction?.clarifyingQuestion,
        releaseStatus === "available" ? "Released to the requester profile." : "Awaiting controlled release decision.",
      ]),
    },
  ];

  const required = steps.filter((step) => step.required);
  return {
    documentClass,
    riskTier,
    workflowMode,
    serviceTier,
    releaseStatus,
    steps,
    summary: {
      requiredCount: required.length,
      completeCount: required.filter((step) => step.status === "complete").length,
      pendingCount: required.filter((step) => step.status === "pending").length,
      blockedCount: required.filter((step) => step.status === "blocked").length,
    },
  };
}
