import { loadConfig } from "../config.js";
import { getApprovals } from "../security/approvals.js";
import { loadRecentAuditEvents } from "../security/audit.js";
import { listPilotProfiles } from "./profiles.js";
import { loadArtifactRecord, loadCaseRecord, listArtifactCatalogRows, listCaseCatalogRows } from "./store.js";
import { listVectorIndexEntries } from "./vector_index.js";

export interface CommandCenterValuePoint {
  label: string;
  value: number;
}

export interface CommandCenterTrendPoint {
  label: string;
  artifacts: number;
  revisions: number;
  interactions: number;
  approvals: number;
}

export interface CommandCenterAlert {
  level: "info" | "warn" | "critical";
  title: string;
  detail: string;
}

export interface CommandCenterFeedItem {
  id: string;
  timestamp: number;
  type: string;
  title: string;
  detail: string;
  severity: "info" | "warn" | "error";
}

export interface CommandCenterSnapshot {
  generatedAt: number;
  seeded: boolean;
  totals: {
    artifacts: number;
    revisions: number;
    approved: number;
    reviewed: number;
    draft: number;
    cases: number;
    highRiskCases: number;
    lowConfidenceOutputs: number;
    unresolvedItems: number;
    validationFailures: number;
    retries: number;
    escalations: number;
    profiles: number;
    vectorEntries: number;
  };
  growth: {
    artifacts: number;
    revisions: number;
    interactions: number;
  };
  trend: CommandCenterTrendPoint[];
  topFailureModes: CommandCenterValuePoint[];
  topAssets: CommandCenterValuePoint[];
  approvalStates: CommandCenterValuePoint[];
  modelValidation: {
    successRate: number;
    failureRate: number;
    retryCount: number;
    escalationCount: number;
  };
  health: {
    ingestionStatus: string;
    documentCoveragePct: number;
    queueDepth: number;
    auditErrors: number;
  };
  alerts: CommandCenterAlert[];
  recentActivity: CommandCenterFeedItem[];
}

function dayLabel(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(5, 10);
}

function pushCount(map: Map<string, number>, key: string | undefined | null): void {
  const normalized = key?.trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function toTopPoints(map: Map<string, number>, limit = 5): CommandCenterValuePoint[] {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

function buildSeededSnapshot(): CommandCenterSnapshot {
  const trend = [0, 1, 2, 3, 4, 5].map((offset) => ({
    label: dayLabel(Date.now() - ((5 - offset) * 86400000)),
    artifacts: 14 + (offset * 3),
    revisions: 4 + offset,
    interactions: 10 + (offset * 2),
    approvals: 2 + Math.floor(offset / 2),
  }));

  return {
    generatedAt: Date.now(),
    seeded: true,
    totals: {
      artifacts: 29,
      revisions: 44,
      approved: 7,
      reviewed: 11,
      draft: 11,
      cases: 18,
      highRiskCases: 3,
      lowConfidenceOutputs: 2,
      unresolvedItems: 6,
      validationFailures: 1,
      retries: 4,
      escalations: 2,
      profiles: 5,
      vectorEntries: 47,
    },
    growth: {
      artifacts: 6,
      revisions: 8,
      interactions: 9,
    },
    trend,
    topFailureModes: [
      { label: "alignment drift", value: 4 },
      { label: "sensor dropout", value: 3 },
      { label: "flow instability", value: 2 },
    ],
    topAssets: [
      { label: "Mixer-07", value: 5 },
      { label: "Pump-A12", value: 4 },
      { label: "Analyzer-03", value: 3 },
    ],
    approvalStates: [
      { label: "approved", value: 7 },
      { label: "reviewed", value: 11 },
      { label: "draft", value: 11 },
    ],
    modelValidation: {
      successRate: 96,
      failureRate: 4,
      retryCount: 4,
      escalationCount: 2,
    },
    health: {
      ingestionStatus: "Seeded demo data",
      documentCoveragePct: 82,
      queueDepth: 0,
      auditErrors: 0,
    },
    alerts: [
      { level: "warn", title: "Low-confidence outputs present", detail: "Two recent cases remain below the confidence threshold and should be reviewed." },
      { level: "info", title: "Demo mode active", detail: "Live artifact analytics will replace these seeded values as soon as real Cateo cases accumulate." },
    ],
    recentActivity: [
      { id: "seed-1", timestamp: Date.now() - 900000, type: "artifact", title: "Inspection package revised", detail: "Mixer-07 inspection checklist advanced to reviewed.", severity: "info" },
      { id: "seed-2", timestamp: Date.now() - 1800000, type: "approval", title: "Operator review required", detail: "A low-confidence troubleshooting package was escalated for reviewer attention.", severity: "warn" },
    ],
  };
}

export function buildCommandCenterSnapshot(): CommandCenterSnapshot {
  const artifactRows = listArtifactCatalogRows();
  const caseRows = listCaseCatalogRows();
  if (artifactRows.length === 0 && caseRows.length === 0) {
    return buildSeededSnapshot();
  }

  const config = loadConfig();
  const approvals = getApprovals(250);
  const audit = loadRecentAuditEvents(500);
  const vectorEntries = listVectorIndexEntries();
  const profiles = config ? listPilotProfiles(config) : [];
  const caseRecords = caseRows.slice(0, 120).map((row) => loadCaseRecord(row.caseId)).filter(Boolean);
  const artifactRecords = artifactRows.slice(0, 200).map((row) => loadArtifactRecord(row.artifactId)).filter(Boolean);

  const failureModes = new Map();
  const assets = new Map();
  const trendMap = new Map();
  const approvalStates = new Map();
  const alerts: CommandCenterAlert[] = [];
  let revisions = 0;
  let highRiskCases = 0;
  let lowConfidenceOutputs = 0;
  let unresolvedItems = 0;

  for (const row of artifactRows) {
    pushCount(assets, row.assetId);
    pushCount(approvalStates, row.approvalState);
    const day = row.updatedAt.slice(5, 10);
    const current = trendMap.get(day) ?? { label: day, artifacts: 0, revisions: 0, interactions: 0, approvals: 0 };
    current.artifacts += 1;
    current.revisions += Math.max(1, row.revisionNumber);
    trendMap.set(day, current);
    revisions += Math.max(1, row.revisionNumber);
  }

  for (const approval of approvals) {
    const day = dayLabel(approval.updatedAt);
    const current = trendMap.get(day) ?? { label: day, artifacts: 0, revisions: 0, interactions: 0, approvals: 0 };
    current.approvals += 1;
    trendMap.set(day, current);
  }

  for (const record of caseRecords) {
    const errorCode = record?.context.failureCode?.code ?? record?.input.errorCode;
    pushCount(failureModes, errorCode);
    if (record?.interaction?.confidence === "low") {
      lowConfidenceOutputs += 1;
    }
    const day = record?.updatedAt?.slice(5, 10);
    if (day) {
      const current = trendMap.get(day) ?? { label: day, artifacts: 0, revisions: 0, interactions: 0, approvals: 0 };
      current.interactions += 1;
      trendMap.set(day, current);
    }
  }

  for (const record of artifactRecords) {
    const latest = record?.revisions[record.revisions.length - 1];
    if (!latest) continue;
    const payload = JSON.stringify(latest.content).toLowerCase();
    if (/(critical|immediate|unsafe|do not return|stop operation)/.test(payload)) {
      highRiskCases += 1;
    }
    if (/(unresolved|follow-up|pending verification|pending review)/.test(payload)) {
      unresolvedItems += 1;
    }
  }

  const validationFailures = audit.filter((entry) => entry.category === "cateo_validation" && entry.outcome === "fallback").length
    + audit.filter((entry) => entry.category === "cateo_rules" && entry.outcome === "escalated").length;
  const retries = audit.filter((entry) => entry.category === "cateo_validation" && /retry/i.test(entry.action)).length;
  const escalations = audit.filter((entry) => entry.category === "cateo_rules" && entry.outcome === "escalated").length;
  const auditErrors = audit.filter((entry) => entry.severity === "error").length;
  const successCount = Math.max(0, artifactRows.length - validationFailures);
  const totalValidationEvents = Math.max(1, successCount + validationFailures);

  if (lowConfidenceOutputs > 0) {
    alerts.push({ level: "warn", title: "Low-confidence outputs need review", detail: `${lowConfidenceOutputs} case(s) are still below the confidence threshold.` });
  }
  if (highRiskCases > 0) {
    alerts.push({ level: "critical", title: "High-risk cases detected", detail: `${highRiskCases} artifact package(s) contain stop-work or unsafe-condition language.` });
  }
  if (alerts.length === 0) {
    alerts.push({ level: "info", title: "No immediate command-center alerts", detail: "Recent artifacts are flowing without high-risk escalations." });
  }

  return {
    generatedAt: Date.now(),
    seeded: false,
    totals: {
      artifacts: artifactRows.length,
      revisions,
      approved: artifactRows.filter((row) => row.approvalState === "approved").length,
      reviewed: artifactRows.filter((row) => row.approvalState === "reviewed").length,
      draft: artifactRows.filter((row) => row.approvalState === "draft").length,
      cases: caseRows.length,
      highRiskCases,
      lowConfidenceOutputs,
      unresolvedItems,
      validationFailures,
      retries,
      escalations,
      profiles: profiles.length,
      vectorEntries: vectorEntries.length,
    },
    growth: {
      artifacts: trendMap.size > 1 ? [...trendMap.values()].slice(-1)[0].artifacts : artifactRows.length,
      revisions: trendMap.size > 1 ? [...trendMap.values()].slice(-1)[0].revisions : revisions,
      interactions: trendMap.size > 1 ? [...trendMap.values()].slice(-1)[0].interactions : caseRows.length,
    },
    trend: [...trendMap.values()].sort((left, right) => left.label.localeCompare(right.label)).slice(-7),
    topFailureModes: toTopPoints(failureModes),
    topAssets: toTopPoints(assets),
    approvalStates: toTopPoints(approvalStates),
    modelValidation: {
      successRate: Math.round((successCount / totalValidationEvents) * 100),
      failureRate: Math.round((validationFailures / totalValidationEvents) * 100),
      retryCount: retries,
      escalationCount: escalations,
    },
    health: {
      ingestionStatus: artifactRows.length > 0 ? "Live artifact telemetry" : "No artifacts yet",
      documentCoveragePct: Math.min(100, Math.round((vectorEntries.length / Math.max(1, artifactRows.length + caseRows.length)) * 100)),
      queueDepth: approvals.filter((entry) => entry.status === "pending").length,
      auditErrors,
    },
    alerts,
    recentActivity: audit.slice(0, 10).map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      type: entry.category,
      title: `${entry.category} · ${entry.action}`,
      detail: entry.message,
      severity: entry.severity ?? "info",
    })),
  };
}
