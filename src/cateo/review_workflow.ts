import path from "node:path";
import type {
  CateoArtifactRecord,
  CateoCaseRecord,
  CateoCaseReviewWorkflow,
  CateoStoredReviewFile,
  CateoStoredReviewFileKind,
} from "./types.js";

interface ReviewDocumentFile {
  kind: string;
  fileName: string;
  relativePath: string;
  mimeType?: string;
  uploadedAt?: string;
  uploadedBy?: string;
}

function normalizeStoredFile(file: CateoStoredReviewFile | undefined): CateoStoredReviewFile | undefined {
  if (!file) {
    return undefined;
  }
  return {
    kind: file.kind,
    fileName: file.fileName,
    relativePath: file.relativePath.replace(/\\/g, "/"),
    mimeType: file.mimeType,
    uploadedAt: file.uploadedAt,
    uploadedBy: file.uploadedBy,
  };
}

function blankWorkflow(stage: CateoCaseReviewWorkflow["stage"]): CateoCaseReviewWorkflow {
  return {
    stage,
    packageFiles: {},
    technical: { status: stage === "technical-review" ? "pending" : "approved" },
    quality: { status: stage === "released" ? "released" : "pending" },
  };
}

export function caseRequiresControlledReview(record: CateoCaseRecord): boolean {
  return Boolean(
    record.releaseControl
    || record.reviewWorkflow
    || record.interaction?.requiresEngineerReview
    || record.interaction?.releaseStatus === "pending-engineer-review",
  );
}

export function deriveCaseReviewWorkflow(record: CateoCaseRecord, artifacts: CateoArtifactRecord[] = []): CateoCaseReviewWorkflow | null {
  if (record.reviewWorkflow || record.releaseControl) {
    const controlledStage: CateoCaseReviewWorkflow["stage"] = record.releaseControl?.state === "APPROVED"
      ? "released"
      : record.releaseControl?.state === "TECHNICAL_REVIEWED"
        ? "quality-review"
        : "technical-review";
    const prior = record.reviewWorkflow;
    return {
      stage: controlledStage,
      packageFiles: {
        generatedWord: normalizeStoredFile(prior?.packageFiles.generatedWord),
        generatedPdf: normalizeStoredFile(prior?.packageFiles.generatedPdf),
      },
      technical: {
        status: controlledStage === "technical-review" ? (record.releaseControl?.state === "REJECTED" ? "redlined" : "pending") : "approved",
        reviewerUserId: prior?.technical?.reviewerUserId,
        reviewerDisplayName: prior?.technical?.reviewerDisplayName,
        note: prior?.technical?.note,
        decidedAt: prior?.technical?.decidedAt,
        redlineFile: normalizeStoredFile(prior?.technical?.redlineFile),
      },
      quality: {
        status: controlledStage === "released" ? "released" : "pending",
        reviewerUserId: prior?.quality?.reviewerUserId,
        reviewerDisplayName: prior?.quality?.reviewerDisplayName,
        note: prior?.quality?.note,
        decidedAt: prior?.quality?.decidedAt,
      },
    };
  }

  if (!caseRequiresControlledReview(record)) {
    return null;
  }

  return blankWorkflow("technical-review");
}

export function ensureCaseReviewWorkflow(record: CateoCaseRecord, artifacts: CateoArtifactRecord[] = []): CateoCaseReviewWorkflow | undefined {
  const workflow = deriveCaseReviewWorkflow(record, artifacts);
  if (workflow) {
    record.reviewWorkflow = workflow;
  }
  return workflow ?? undefined;
}

export function buildStoredReviewFile(args: { kind: CateoStoredReviewFileKind; folderPath: string; fileName: string; mimeType?: string; uploadedAt: string; uploadedBy: string }): CateoStoredReviewFile {
  return {
    kind: args.kind,
    fileName: args.fileName,
    relativePath: path.join(args.folderPath, args.fileName).replace(/\\/g, "/"),
    mimeType: args.mimeType,
    uploadedAt: args.uploadedAt,
    uploadedBy: args.uploadedBy,
  };
}

function toStoredFile(kind: CateoStoredReviewFileKind, file: ReviewDocumentFile | undefined): CateoStoredReviewFile | undefined {
  if (!file?.uploadedAt || !file.uploadedBy) {
    return undefined;
  }
  return {
    kind,
    fileName: file.fileName,
    relativePath: file.relativePath.replace(/\\/g, "/"),
    mimeType: file.mimeType,
    uploadedAt: file.uploadedAt,
    uploadedBy: file.uploadedBy,
  };
}

export function syncCaseReviewPackageFiles(record: CateoCaseRecord, files: ReviewDocumentFile[]): void {
  const workflow = ensureCaseReviewWorkflow(record);
  if (!workflow) {
    return;
  }

  const generatedWord = toStoredFile("generated-word", files.find((file) => file.kind === "generated-word"));
  const generatedPdf = toStoredFile("generated-pdf", files.find((file) => file.kind === "generated-pdf"));
  const redlineFile = toStoredFile("technical-redline", files.find((file) => file.kind === "technical-redline"));

  workflow.packageFiles = {
    generatedWord: generatedWord ?? workflow.packageFiles.generatedWord,
    generatedPdf: generatedPdf ?? workflow.packageFiles.generatedPdf,
  };
  workflow.technical = {
    ...workflow.technical,
    redlineFile: redlineFile ?? workflow.technical.redlineFile,
  };
  record.reviewWorkflow = workflow;
}

function toAscii(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7E\r\n]/g, "");
}

function escapeRtf(value: string): string {
  return toAscii(value)
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

export function buildTechnicalRedlineRtf(args: { title: string; caseId: string; partNumber?: string; reviewer: string; decidedAt: string; note: string; artifactIds: string[] }): string {
  const lines: string[] = [];
  lines.push("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}", "\\viewkind4\\uc1\\pard\\sa180\\sl276\\slmult1\\f0\\fs22");
  lines.push(`\\b Technical Review Redlines\\b0\\par`);
  lines.push(`${escapeRtf(args.title)}\\par`);
  lines.push(`Case: ${escapeRtf(args.caseId)}\\par`);
  if (args.partNumber) {
    lines.push(`Part: ${escapeRtf(args.partNumber)}\\par`);
  }
  lines.push(`Reviewer: ${escapeRtf(args.reviewer)}\\par`);
  lines.push(`Reviewed at: ${escapeRtf(args.decidedAt)}\\par`);
  if (args.artifactIds.length > 0) {
    lines.push(`Artifacts: ${escapeRtf(args.artifactIds.join(", "))}\\par`);
  }
  lines.push("\\par", "\\b Redline Notes\\b0\\par");
  for (const paragraph of args.note.split(/\r?\n/)) {
    lines.push(`${escapeRtf(paragraph || " ")}\\par`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function hasReviewDeskAccessRoles(roles: string[] | undefined): boolean {
  return Array.isArray(roles) && roles.some((role) => role === "admin" || role === "technical-reviewer" || role === "quality-reviewer");
}

export function hasTechnicalReviewerRole(roles: string[] | undefined): boolean {
  return Array.isArray(roles) && roles.includes("technical-reviewer");
}

export function hasQualityReviewerRole(roles: string[] | undefined): boolean {
  return Array.isArray(roles) && (roles.includes("quality-reviewer") || roles.includes("admin"));
}

export function reviewLaneForRoles(roles: string[] | undefined): "technical-review" | "quality-review" | null {
  if (hasTechnicalReviewerRole(roles) && !hasQualityReviewerRole(roles)) {
    return "technical-review";
  }
  if (hasQualityReviewerRole(roles)) {
    return "quality-review";
  }
  return null;
}

