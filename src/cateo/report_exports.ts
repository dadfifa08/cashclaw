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
    verifiedSources: Array<{ title: string; url: string; reason?: string }>;
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
      verifiedSources: (caseRecord.context.partResolution?.verifiedSources ?? []).map((source) => ({
        title: source.title,
        url: source.url,
        reason: source.reason,
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
      ...(reasoning?.evidenceRequests ?? []),
    ]),
    warningsAndHazards: unique([
      ...(procedure?.safetyPrecautions ?? []),
      ...caseRecord.context.attachments.flatMap((attachment) => attachment.notes.filter((signal: string) => /warning|hazard|lockout|ppe|caution|danger/i.test(signal))),
      ...caseRecord.context.contextSummary.filter((entry) => /warning|hazard|lockout|ppe|caution|danger/i.test(entry)),
    ]),
    diagnosticProcedure: (procedure?.steps ?? []).map((step) => ({
      stepId: step.id,
      action: step.action,
      rationale: step.rationale,
      expectedResult: step.expectedResult,
      escalationTrigger: step.escalationTrigger,
    })),
    expectedValues: buildExpectedValues(procedure, checklist),
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
        detail: source.reason,
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
  fs.mkdirSync(path.dirname(reportPackage.indexing.jsonPath), { recursive: true, mode: 0o700 });
  writeProtectedJson(reportPackage.indexing.jsonPath, reportPackage);
  return reportPackage;
}

