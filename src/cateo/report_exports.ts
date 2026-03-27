import fs from "node:fs";
import path from "node:path";
import { writeProtectedJson } from "../security/secure_store.js";
import { getCateoProcedureDir } from "./store.js";
import type {
  CateoArtifactRecord,
  CateoCaseRecord,
  CateoDiagnosticReasoningLog,
  CateoInspectionChecklist,
  CateoPartsToolsList,
  CateoServiceReport,
  CateoTroubleshootingProcedure,
} from "./types.js";

const REPORT_PACKAGE_VERSION = "cateo-troubleshooting-report-v1";

export interface CateoTroubleshootingReportPackage {
  packageVersion: string;
  caseId: string;
  runId: string;
  title: string;
  generatedAt: string;
  updatedAt: string;
  documentControl: {
    documentId: string;
    templateId?: string;
    templateVersion?: string;
    releaseStatus?: string;
    artifactCount: number;
    files: Array<{
      kind: "generated-word" | "generated-pdf" | "technical-redline";
      fileName: string;
      relativePath: string;
      mimeType?: string;
      uploadedAt?: string;
      uploadedBy?: string;
    }>;
    review: {
      stage?: string;
      technicalStatus?: string;
      qualityStatus?: string;
      technicalReviewer?: string;
      qualityReviewer?: string;
    };
    schemaRefs: Array<{
      artifactId: string;
      artifactType: string;
      schemaId: string;
      schemaVersion: string;
      revisionNumber: number;
    }>;
  };
  indexing: {
    systemTag: string;
    partTag: string;
    issueTag: string;
    folderPath: string;
    jsonPath: string;
  };
  request: {
    problemDescription: string;
    contextNotes?: string;
    errorCode?: string;
    workOrderId?: string;
    partNumber?: string;
    businessType?: string;
    faultArea?: string;
    issueType: string;
  };
  asset: {
    assetId?: string;
    assetType?: string;
    manufacturer?: string;
    model?: string;
    serialNumber?: string;
    locationHierarchy: string[];
    environment?: string;
  };
  part: {
    partNumber?: string;
    description?: string;
    manufacturer?: string;
    confidencePct?: number;
    aliases: string[];
    referenceDocuments: string[];
    verifiedSources: Array<{ title: string; url: string; reason?: string; documentType?: string; publisherType?: string; summary?: string }>;
  };
  interaction: {
    message?: string;
    highlights: string[];
    nextActions: string[];
    confidence?: string;
  };
  observedConditions: string[];
  assumptions: string[];
  evidenceSummary: string[];
  warningsAndHazards: string[];
  sourceGrounding: {
    groundedFindings: string[];
    expectedValues: string[];
    referenceDocuments: string[];
  };
  diagnosticProcedure: Array<{
    stepId: string;
    action: string;
    rationale: string;
    expectedResult: string;
    escalationTrigger?: string;
  }>;
  expectedValues: string[];
  failurePaths: string[];
  rootCause: {
    statement: string;
    confidence?: string;
    hypotheses: Array<{
      name: string;
      status: string;
      evidenceFor: string[];
      evidenceAgainst: string[];
    }>;
  };
  verification: {
    acceptanceCriteria: string[];
    completionCriteria: string[];
    recommendations: string[];
    unresolvedRisks: string[];
  };
  partsAndTools: {
    requiredParts: string[];
    requiredTools: string[];
    parts: Array<{ sku: string; description: string; quantity: number; justification: string; storageLocation?: string }>;
    tools: Array<{ name: string; quantity: number; purpose: string }>;
    consumables: string[];
  };
  preventiveMaintenance: {
    suggestions: string[];
  };
  references: Array<{
    sourceType: "verified-source" | "artifact" | "attachment" | "history";
    label: string;
    detail?: string;
    url?: string;
  }>;
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function slug(value: string | undefined, fallback: string): string {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function latestArtifact<T>(artifacts: CateoArtifactRecord[], artifactType: CateoArtifactRecord["artifactType"]): T | null {
  const record = artifacts.find((artifact) => artifact.artifactType === artifactType);
  const revision = record?.revisions.at(-1);
  return revision ? (revision.content as T) : null;
}

function buildProblemStatement(caseRecord: CateoCaseRecord): string {
  return unique([
    caseRecord.input.symptomDescription,
    caseRecord.input.query,
    caseRecord.input.title,
  ])[0] || "Reported technical issue";
}

function buildExpectedValues(procedure: CateoTroubleshootingProcedure | null, checklist: CateoInspectionChecklist | null): string[] {
  return unique([
    ...(procedure?.steps.map((step) => `${step.action}: ${step.expectedResult}`) ?? []),
    ...(procedure?.acceptanceCriteria ?? []),
    ...(checklist?.checklist.map((item) => `${item.check}: ${item.passCriteria}`) ?? []),
    ...(checklist?.completionCriteria ?? []),
  ]);
}

function buildFailurePaths(procedure: CateoTroubleshootingProcedure | null, reasoning: CateoDiagnosticReasoningLog | null): string[] {
  return unique([
    ...(procedure?.steps.map((step) => step.escalationTrigger).filter(Boolean) ?? []),
    ...(reasoning?.hypotheses.map((hypothesis) => `${hypothesis.name} (${hypothesis.status})`) ?? []),
  ]);
}

function reportDir(): string {
  return getCateoProcedureDir();
}

function buildReportFileNameBase(report: CateoTroubleshootingReportPackage): string {
  const identity = report.part.partNumber || report.request.partNumber || report.asset.assetId || report.request.workOrderId || report.caseId;
  return `${slug(identity || report.title || "cateo-troubleshooting-report", "cateo-report")}-${slug(report.request.issueType || "report", "issue")}`;
}

function toAscii(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7E\r\n]/g, "");
}

function formatReportDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function wrapText(text: string, width = 92): string[] {
  const normalized = toAscii(text).replace(/\r/g, "");
  const paragraphs = normalized.split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of trimmed.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > width) {
        if (current) {
          lines.push(current);
          current = word;
        } else {
          lines.push(word);
        }
      } else {
        current = next;
      }
    }
    if (current) {
      lines.push(current);
    }
  }
  return lines;
}

function formatDuration(minutes: number): string {
  const rounded = Math.max(15, Math.round(minutes / 5) * 5);
  if (rounded >= 60) {
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return remainder > 0 ? `${hours} hr ${remainder} min` : `${hours} hr`;
  }
  return `${rounded} min`;
}

function transparencyNoticeLines(report: CateoTroubleshootingReportPackage): string[] {
  return unique([
    "This guide is initially AI-generated.",
    "Cateo builds the first pass from verified manufacturer, OEM, manual, datasheet, bulletin, and standards sources when available.",
    "Field history and approved crowdsource improvements are applied only as secondary refinements and retained in revision history.",
    `Current release status: ${report.documentControl.releaseStatus ?? "draft"}.`,
    "Verify against approved records before operational, safety, regulatory, medical, or legal use.",
  ]);
}

function estimateTimeLines(report: CateoTroubleshootingReportPackage): string[] {
  const stepCount = Math.max(report.diagnosticProcedure.length, 1);
  const toolCount = report.partsAndTools.requiredTools.length + report.partsAndTools.tools.length;
  const partCount = report.partsAndTools.requiredParts.length + report.partsAndTools.parts.length;
  const minutes = Math.max(30, (stepCount * 15) + (toolCount * 5) + (partCount * 3));
  return [
    `Estimated time required: ${formatDuration(minutes)}.`,
    "Actual field time depends on access, lockout, warm-up, calibration, and replacement scope.",
  ];
}

function summaryLines(report: CateoTroubleshootingReportPackage): string[] {
  return unique([
    report.title,
    report.request.problemDescription,
    report.interaction.message,
    report.request.issueType ? `Issue type: ${report.request.issueType}` : undefined,
    (report.request.faultArea || report.request.issueType) ? `Fault area: ${report.request.faultArea || report.request.issueType}` : undefined,
    report.request.businessType ? `Operating domain: ${report.request.businessType}` : undefined,
    (report.asset.model || report.asset.assetType) ? `System / instrument: ${report.asset.model || report.asset.assetType}` : undefined,
    (report.part.partNumber || report.request.partNumber) ? `Part number: ${report.part.partNumber || report.request.partNumber}` : undefined,
    report.request.errorCode ? `Error code: ${report.request.errorCode}` : undefined,
    report.request.workOrderId ? `Work order: ${report.request.workOrderId}` : undefined,
  ]);
}

function hazardLines(report: CateoTroubleshootingReportPackage): string[] {
  const hazards = unique(report.warningsAndHazards);
  return hazards.length > 0 ? hazards : ["No explicit hazard labels were captured. Verify lockout, PPE, and local safety controls before starting work."];
}

function requiredToolLines(report: CateoTroubleshootingReportPackage): string[] {
  const lines = unique([
    ...report.partsAndTools.requiredTools.map((item) => `Required tool: ${item}`),
    ...report.partsAndTools.tools.map((tool) => `${tool.name} x${tool.quantity}${tool.purpose ? ` - ${tool.purpose}` : ""}`),
  ]);
  return lines.length > 0 ? lines : ["No specific tools were captured. Bring the standard diagnostic kit for this system."];
}

function requiredPartLines(report: CateoTroubleshootingReportPackage): string[] {
  const lines = unique([
    ...report.partsAndTools.requiredParts.map((item) => `Required part: ${item}`),
    ...report.partsAndTools.parts.map((part) => `${part.sku} x${part.quantity}: ${part.description}${part.justification ? ` - ${part.justification}` : ""}`),
    ...report.partsAndTools.consumables.map((item) => `Consumable: ${item}`),
  ]);
  return lines.length > 0 ? lines : ["No replacement parts or consumables were captured for this guide."];
}

function problemFrameLines(report: CateoTroubleshootingReportPackage): string[] {
  const primarySources = unique([
    ...report.part.verifiedSources.slice(0, 4).map((source) => `${source.title}${source.documentType ? ` (${source.documentType})` : ""}`),
    ...report.part.referenceDocuments.slice(0, 3).map((item) => `Reference document: ${item}`),
  ]);
  const fieldSignals = unique(report.references
    .filter((reference) => reference.sourceType === "history")
    .slice(0, 3)
    .map((reference) => reference.detail ? `${reference.label}: ${reference.detail}` : reference.label));

  return unique([
    primarySources.length > 0 ? `Primary guidance basis: ${primarySources.join("; ")}` : "Primary guidance basis: No verified manufacturer or manual source set was captured. Treat this guide as provisional.",
    report.sourceGrounding.expectedValues.length > 0 ? `Source-backed checkpoints: ${report.sourceGrounding.expectedValues.slice(0, 3).join("; ")}` : undefined,
    ...report.observedConditions.slice(0, 3).map((item) => `Observed condition: ${item}`),
    ...report.evidenceSummary.slice(0, 2).map((item) => `Supporting context: ${item}`),
    fieldSignals.length > 0 ? `Secondary field and crowdsource refinement: ${fieldSignals.join("; ")}` : "Secondary field and crowdsource refinement: No prior field history or crowdsource refinement was captured.",
  ]);
}

function diagnosticStepLines(report: CateoTroubleshootingReportPackage): string[] {
  if (report.diagnosticProcedure.length === 0) {
    return ["No structured troubleshooting path was stored for this release. Review the guide basis, validation criteria, and references before continuing."];
  }
  return report.diagnosticProcedure.flatMap((step) => unique([
    `${step.stepId}: ${step.action}`,
    `Purpose: ${step.rationale}`,
    `What you should see: ${step.expectedResult}`,
    step.escalationTrigger ? `Escalate when: ${step.escalationTrigger}` : undefined,
    "",
  ]));
}

function validationLines(report: CateoTroubleshootingReportPackage): string[] {
  return unique([
    ...report.verification.acceptanceCriteria.map((item) => `Acceptance: ${item}`),
    ...report.verification.completionCriteria.map((item) => `Completion: ${item}`),
    ...report.verification.recommendations.map((item) => `Recommendation: ${item}`),
    ...report.expectedValues.map((item) => `Expected value: ${item}`),
    ...report.verification.unresolvedRisks.map((item) => `Open risk: ${item}`),
  ]);
}

function rootCauseLines(report: CateoTroubleshootingReportPackage): string[] {
  return unique([
    report.rootCause.statement,
    report.rootCause.confidence ? `Confidence: ${report.rootCause.confidence}` : undefined,
    ...report.rootCause.hypotheses.slice(0, 2).map((hypothesis) => `${hypothesis.name} (${hypothesis.status})`),
  ]);
}

function referenceLines(report: CateoTroubleshootingReportPackage): string[] {
  return unique([
    ...report.references.flatMap((reference) => unique([
      `${reference.label} [${reference.sourceType}]`,
      reference.detail,
      reference.url,
      "",
    ])),
    ...report.part.referenceDocuments.map((item) => `Reference document: ${item}`),
    ...report.part.verifiedSources.flatMap((source) => unique([
      `${source.title} [verified-source]`,
      source.reason,
      source.summary,
      source.documentType ? `Document type: ${source.documentType}` : undefined,
      source.publisherType ? `Publisher type: ${source.publisherType}` : undefined,
      source.url,
      "",
    ])),
  ]);
}

function versionStampLines(report: CateoTroubleshootingReportPackage): string[] {
  return unique([
    `Document ID: ${report.documentControl.documentId}`,
    `Package version: ${report.packageVersion}`,
    report.documentControl.templateId ? `Template: ${report.documentControl.templateId} v${report.documentControl.templateVersion ?? "n/a"}` : undefined,
    `Release status: ${report.documentControl.releaseStatus ?? "draft"}`,
    report.documentControl.review.stage ? `Review stage: ${report.documentControl.review.stage}` : undefined,
    `Generated: ${formatReportDate(report.generatedAt)}`,
    `Updated: ${formatReportDate(report.updatedAt)}`,
  ]);
}

function sectionLines(report: CateoTroubleshootingReportPackage): Array<{ heading: string; lines: string[] }> {
  return [
    {
      heading: "Transparency and Usage Notice",
      lines: transparencyNoticeLines(report),
    },
    {
      heading: "Summary",
      lines: summaryLines(report),
    },
    {
      heading: "Time Required",
      lines: estimateTimeLines(report),
    },
    {
      heading: "Hazards Present",
      lines: hazardLines(report),
    },
    {
      heading: "Required Tools",
      lines: requiredToolLines(report),
    },
    {
      heading: "Parts Required",
      lines: requiredPartLines(report),
    },
    {
      heading: "Guide Basis and Source Order",
      lines: problemFrameLines(report),
    },
    {
      heading: "Step-by-Step Troubleshooting Guide",
      lines: diagnosticStepLines(report),
    },
    {
      heading: "Validation and Verification",
      lines: validationLines(report),
    },
    {
      heading: "Current Engineering Note",
      lines: rootCauseLines(report),
    },
    {
      heading: "References",
      lines: referenceLines(report),
    },
    {
      heading: "Version Control Stamp",
      lines: versionStampLines(report),
    },
  ].map((section) => ({
    heading: section.heading,
    lines: section.lines.flatMap((line) => wrapText(line)).filter((line, index, array) => line || array[index - 1] !== ""),
  })).filter((section) => section.lines.length > 0);
}

function formatTroubleshootingReportText(report: CateoTroubleshootingReportPackage): string {
  const lines: string[] = [];
  for (const section of sectionLines(report)) {
    lines.push(section.heading.toUpperCase());
    lines.push(...section.lines);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function escapeRtf(value: string): string {
  return toAscii(value)
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

function buildWordRtf(report: CateoTroubleshootingReportPackage): string {
  const lines: string[] = [];
  lines.push(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}`);
  lines.push("\\viewkind4\\uc1\\pard\\sa180\\sl276\\slmult1\\f0\\fs22");
  lines.push(`\\b ${escapeRtf(report.title)}\\b0\\par`);
  lines.push(`Report ID: ${escapeRtf(report.documentControl.documentId)}\\par`);
  lines.push(`Generated: ${escapeRtf(formatReportDate(report.generatedAt))}\\par\\par`);
  for (const section of sectionLines(report)) {
    lines.push(`\\b ${escapeRtf(section.heading)}\\b0\\par`);
    for (const line of section.lines) {
      lines.push(`${escapeRtf(line || " ")}\\par`);
    }
    lines.push("\\par");
  }
  lines.push("}");
  return lines.join("\n");
}

function escapePdf(value: string): string {
  return toAscii(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildPdf(report: CateoTroubleshootingReportPackage): string {
  const textLines = formatTroubleshootingReportText(report).split("\n");
  const pageSize = 44;
  const pages: string[][] = [];
  for (let index = 0; index < textLines.length; index += pageSize) {
    pages.push(textLines.slice(index, index + pageSize));
  }
  if (pages.length === 0) {
    pages.push([report.title]);
  }

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageObjectNumbers: number[] = [];
  let objectNumber = 3;
  const fontObjectNumber = objectNumber;
  objects[fontObjectNumber] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objectNumber += 1;

  for (const pageLines of pages) {
    const pageObjectNumber = objectNumber;
    const contentObjectNumber = objectNumber + 1;
    pageObjectNumbers.push(pageObjectNumber);

    const body = [
      "BT",
      "/F1 10 Tf",
      "50 780 Td",
      "14 TL",
      ...pageLines.flatMap((line, index) => index === 0
        ? [`(${escapePdf(line || " ")}) Tj`]
        : ["T*", `(${escapePdf(line || " ")}) Tj`]),
      "ET",
    ].join("\n");
    objects[contentObjectNumber] = `<< /Length ${Buffer.byteLength(body, "utf8")} >>\nstream\n${body}\nendstream`;
    objects[pageObjectNumber] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`;
    objectNumber += 2;
  }

  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((value) => `${value} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 1; index < objects.length; index += 1) {
    if (!objects[index]) continue;
    offsets[index] = Buffer.byteLength(pdf, "utf8");
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < objects.length; index += 1) {
    const offset = offsets[index] ?? 0;
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

function buildStoredFile(args: { kind: "generated-word" | "generated-pdf" | "technical-redline"; folderPath: string; fileName: string; mimeType?: string; uploadedAt: string; uploadedBy: string }) {
  return {
    kind: args.kind,
    fileName: args.fileName,
    relativePath: path.join(args.folderPath, args.fileName).replace(/\\/g, "/"),
    mimeType: args.mimeType,
    uploadedAt: args.uploadedAt,
    uploadedBy: args.uploadedBy,
  };
}

export function buildTroubleshootingReportPackage(caseRecord: CateoCaseRecord, artifacts: CateoArtifactRecord[]): CateoTroubleshootingReportPackage {
  const procedure = latestArtifact<CateoTroubleshootingProcedure>(artifacts, "troubleshooting-procedure");
  const reasoning = latestArtifact<CateoDiagnosticReasoningLog>(artifacts, "diagnostic-reasoning-log");
  const report = latestArtifact<CateoServiceReport>(artifacts, "service-report");
  const checklist = latestArtifact<CateoInspectionChecklist>(artifacts, "inspection-checklist");
  const parts = latestArtifact<CateoPartsToolsList>(artifacts, "parts-tools-list");

  const systemTag = slug(caseRecord.context.asset?.assetId || [caseRecord.context.machine?.manufacturer, caseRecord.context.machine?.model].filter(Boolean).join(" "), "system-unresolved");
  const partTag = slug(caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber, "part-unresolved");
  const issueTag = slug(caseRecord.context.failureCode?.code || caseRecord.context.taskClass, "issue-unresolved");
  const relativeFolder = path.join(systemTag, partTag, issueTag, caseRecord.caseId);
  const jsonPath = path.join(reportDir(), relativeFolder, "troubleshooting-report.json");

  return {
    packageVersion: REPORT_PACKAGE_VERSION,
    caseId: caseRecord.caseId,
    runId: caseRecord.runId,
    title: procedure?.title || report?.title || caseRecord.interaction?.conversationTitle || caseRecord.context.partResolution?.partNumber || caseRecord.context.title,
    generatedAt: caseRecord.createdAt,
    updatedAt: caseRecord.updatedAt,
    documentControl: {
      documentId: `CTR-${caseRecord.caseId}`,
      templateId: caseRecord.trace.template.templateId,
      templateVersion: caseRecord.trace.template.version,
      releaseStatus: caseRecord.interaction?.releaseStatus,
      artifactCount: artifacts.length,
      files: [],
      review: {
        stage: caseRecord.reviewWorkflow?.stage,
        technicalStatus: caseRecord.reviewWorkflow?.technical.status,
        qualityStatus: caseRecord.reviewWorkflow?.quality.status,
        technicalReviewer: caseRecord.reviewWorkflow?.technical.reviewerDisplayName,
        qualityReviewer: caseRecord.reviewWorkflow?.quality.reviewerDisplayName,
      },
      schemaRefs: artifacts.map((artifact) => {
        const revision = artifact.revisions.at(-1);
        return {
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          schemaId: artifact.schema.id,
          schemaVersion: artifact.schema.version,
          revisionNumber: revision?.revisionNumber ?? 0,
        };
      }),
    },
    indexing: {
      systemTag,
      partTag,
      issueTag,
      folderPath: relativeFolder.replace(/\\/g, "/"),
      jsonPath,
    },
    request: {
      problemDescription: buildProblemStatement(caseRecord),
      contextNotes: caseRecord.input.contextNotes,
      errorCode: caseRecord.input.errorCode,
      workOrderId: caseRecord.context.workOrder?.workOrderId,
      partNumber: caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber,
      businessType: caseRecord.input.businessType || caseRecord.context.businessType,
      faultArea: caseRecord.input.faultArea || caseRecord.context.faultArea,
      issueType: caseRecord.context.issueType || caseRecord.context.failureCode?.label || caseRecord.context.taskClass,
    },
    asset: {
      assetId: caseRecord.context.asset?.assetId,
      assetType: caseRecord.context.asset?.assetType,
      manufacturer: caseRecord.context.machine?.manufacturer,
      model: caseRecord.context.machine?.model,
      serialNumber: caseRecord.context.machine?.serialNumber,
      locationHierarchy: caseRecord.context.asset?.locationHierarchy ?? caseRecord.context.machine?.locationHierarchy ?? [],
      environment: caseRecord.context.machine?.environment,
    },
    part: {
      partNumber: caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber,
      description: caseRecord.context.partResolution?.partDescription,
      manufacturer: caseRecord.context.partResolution?.manufacturer || caseRecord.context.machine?.manufacturer,
      confidencePct: caseRecord.context.partResolution?.confidencePct,
      aliases: caseRecord.context.partResolution?.aliases ?? [],
      referenceDocuments: caseRecord.context.partResolution?.referenceDocuments ?? [],
      verifiedSources: (caseRecord.context.partResolution?.verifiedSources ?? []).map((source) => ({
        title: source.title,
        url: source.url,
        reason: source.reason,
        documentType: source.documentType,
        publisherType: source.publisherType,
        summary: source.summary,
      })),
    },
    interaction: {
      message: caseRecord.interaction?.message,
      highlights: caseRecord.interaction?.highlights ?? [],
      nextActions: caseRecord.interaction?.nextActions ?? [],
      confidence: caseRecord.interaction?.confidence,
    },
    observedConditions: unique([
      ...caseRecord.context.observedConditions,
      ...(procedure?.symptoms ?? []),
    ]),
    assumptions: unique([
      ...(procedure?.assumptions ?? []),
      ...(reasoning?.assumptions ?? []),
      ...(caseRecord.trace.leadPlan.assumptions ?? []),
    ]),
    evidenceSummary: unique([
      ...(procedure?.evidenceSummary ?? []),
      ...caseRecord.context.contextSummary,
      ...(caseRecord.context.partResolution?.groundedFindings ?? []),
      ...(reasoning?.evidenceRequests ?? []),
    ]),
    warningsAndHazards: unique([
      ...(procedure?.safetyPrecautions ?? []),
      ...(caseRecord.context.partResolution?.hazardSignals ?? []),
      ...caseRecord.context.attachments.flatMap((attachment) => attachment.notes.filter((signal: string) => /warning|hazard|lockout|ppe|caution|danger/i.test(signal))),
      ...caseRecord.context.contextSummary.filter((entry) => /warning|hazard|lockout|ppe|caution|danger/i.test(entry)),
    ]),
    sourceGrounding: {
      groundedFindings: caseRecord.context.partResolution?.groundedFindings ?? [],
      expectedValues: caseRecord.context.partResolution?.expectedValues ?? [],
      referenceDocuments: caseRecord.context.partResolution?.referenceDocuments ?? [],
    },
    diagnosticProcedure: (procedure?.steps ?? []).map((step) => ({
      stepId: step.id,
      action: step.action,
      rationale: step.rationale,
      expectedResult: step.expectedResult,
      escalationTrigger: step.escalationTrigger,
    })),
    expectedValues: unique([
      ...(caseRecord.context.partResolution?.expectedValues ?? []),
      ...buildExpectedValues(procedure, checklist),
    ]),
    failurePaths: buildFailurePaths(procedure, reasoning),
    rootCause: {
      statement: reasoning?.rootCauseStatement || report?.summary || procedure?.objective || caseRecord.trace.finalSynthesis.rootCauseStatement,
      confidence: reasoning?.confidence || caseRecord.interaction?.confidence,
      hypotheses: (reasoning?.hypotheses ?? []).map((hypothesis) => ({
        name: hypothesis.name,
        status: hypothesis.status,
        evidenceFor: hypothesis.evidenceFor,
        evidenceAgainst: hypothesis.evidenceAgainst,
      })),
    },
    verification: {
      acceptanceCriteria: procedure?.acceptanceCriteria ?? [],
      completionCriteria: checklist?.completionCriteria ?? [],
      recommendations: report?.recommendations ?? [],
      unresolvedRisks: report?.unresolvedRisks ?? [],
    },
    partsAndTools: {
      requiredParts: procedure?.requiredParts ?? [],
      requiredTools: procedure?.requiredTools ?? [],
      parts: parts?.parts ?? [],
      tools: parts?.tools ?? [],
      consumables: parts?.consumables ?? [],
    },
    preventiveMaintenance: {
      suggestions: unique([
        ...(caseRecord.context.partResolution?.preventiveMaintenanceHints ?? []),
        ...(procedure?.followUpActions ?? []),
      ]),
    },
    references: [
      ...(caseRecord.context.partResolution?.verifiedSources ?? []).map((source) => ({
        sourceType: "verified-source" as const,
        label: source.title,
        detail: [source.reason, source.summary, source.documentType, source.publisherType].filter(Boolean).join(' | ') || undefined,
        url: source.url,
      })),
      ...artifacts.map((artifact) => ({
        sourceType: "artifact" as const,
        label: `${artifact.artifactType} ${artifact.artifactId}`,
        detail: artifact.revisions.at(-1)?.summary,
      })),
      ...caseRecord.context.attachments.map((attachment) => ({
        sourceType: "attachment" as const,
        label: attachment.name,
        detail: attachment.sha256,
      })),
      ...caseRecord.context.serviceHistory.map((entry) => ({
        sourceType: "history" as const,
        label: entry.workOrderId || entry.occurredAt,
        detail: entry.summary,
      })),
    ],
  };
}

export function persistTroubleshootingReportPackage(caseRecord: CateoCaseRecord, artifacts: CateoArtifactRecord[]): CateoTroubleshootingReportPackage {
  const reportPackage = buildTroubleshootingReportPackage(caseRecord, artifacts);
  const reportFolder = path.dirname(reportPackage.indexing.jsonPath);
  fs.mkdirSync(reportFolder, { recursive: true, mode: 0o700 });

  const generatedAt = new Date().toISOString();
  const fileBase = buildReportFileNameBase(reportPackage);
  const generatedWord = buildStoredFile({
    kind: "generated-word",
    folderPath: reportPackage.indexing.folderPath,
    fileName: `${fileBase}.rtf`,
    mimeType: "application/rtf",
    uploadedAt: generatedAt,
    uploadedBy: "cateo-system",
  });
  const generatedPdf = buildStoredFile({
    kind: "generated-pdf",
    folderPath: reportPackage.indexing.folderPath,
    fileName: `${fileBase}.pdf`,
    mimeType: "application/pdf",
    uploadedAt: generatedAt,
    uploadedBy: "cateo-system",
  });

  fs.writeFileSync(path.join(reportFolder, generatedWord.fileName), buildWordRtf(reportPackage), "utf8");
  fs.writeFileSync(path.join(reportFolder, generatedPdf.fileName), buildPdf(reportPackage), "utf8");

  reportPackage.documentControl.files = [
    generatedWord,
    generatedPdf,
    ...(caseRecord.reviewWorkflow?.technical.redlineFile ? [{
      kind: caseRecord.reviewWorkflow.technical.redlineFile.kind,
      fileName: caseRecord.reviewWorkflow.technical.redlineFile.fileName,
      relativePath: caseRecord.reviewWorkflow.technical.redlineFile.relativePath,
      mimeType: caseRecord.reviewWorkflow.technical.redlineFile.mimeType,
      uploadedAt: caseRecord.reviewWorkflow.technical.redlineFile.uploadedAt,
      uploadedBy: caseRecord.reviewWorkflow.technical.redlineFile.uploadedBy,
    }] : []),
  ];

  writeProtectedJson(reportPackage.indexing.jsonPath, reportPackage);
  return reportPackage;
}




