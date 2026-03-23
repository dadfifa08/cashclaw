import { buildTroubleshootingReportPackage } from "./report_exports.js";
import { countProcedureFavoritesByCaseId, listProcedureFavoriteCaseIds } from "./favorites.js";
import { listCateoPartMasterRecords, type CateoPartMasterRecord } from "./part_master.js";
import { listCaseCatalogRows, loadArtifactRecord, loadCaseRecord } from "./store.js";
import type { CateoArtifactRecord, CateoCaseRecord } from "./types.js";

export interface CateoPlmPartRecord extends CateoPartMasterRecord {
  lifecycleState: "candidate" | "active" | "service-only" | "obsolete";
  maturity: "emerging" | "validated" | "controlled";
  procedureCount: number;
  releasedProcedureCount: number;
  artifactCount: number;
  caseCount: number;
  businessTypes: string[];
  issueTypes: string[];
  systemModels: string[];
  coverage: {
    troubleshootingProcedures: number;
    serviceReports: number;
    inspectionChecklists: number;
    diagnosticLogs: number;
    partsToolsLists: number;
  };
}

export interface CateoProcedureLibraryItem {
  caseId: string;
  title: string;
  summary?: string;
  partNumber?: string;
  businessType?: string;
  issueType?: string;
  manufacturer?: string;
  systemName?: string;
  updatedAt: string;
  createdAt: string;
  artifactCount: number;
  procedureFolder?: string;
  downloadable: boolean;
  favoriteCount: number;
  favorited: boolean;
  lifecycleState?: CateoPlmPartRecord["lifecycleState"];
  maturity?: CateoPlmPartRecord["maturity"];
  entityTypes: string[];
}

export interface CateoProcedureLibraryFilters {
  q?: string;
  partNumber?: string;
  businessType?: string;
  issueType?: string;
  manufacturer?: string;
}

export interface CateoProcedureLibraryDetail {
  item: CateoProcedureLibraryItem;
  caseRecord: CateoCaseRecord;
  reportPackage: ReturnType<typeof buildTroubleshootingReportPackage>;
  partRecord: CateoPlmPartRecord | null;
  relatedCases: CateoProcedureLibraryItem[];
  relatedArtifacts: CateoArtifactRecord[];
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function collectArtifacts(caseRecord: CateoCaseRecord): CateoArtifactRecord[] {
  return caseRecord.artifacts
    .map((artifactId) => loadArtifactRecord(artifactId))
    .filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact));
}

function releasedTroubleshootingCases(): CateoCaseRecord[] {
  return listCaseCatalogRows()
    .map((row) => loadCaseRecord(row.caseId))
    .filter((record): record is CateoCaseRecord => Boolean(record))
    .filter((record) => record.context.taskClass === "troubleshooting" && record.interaction?.releaseStatus === "available");
}

export function buildPlmPartCatalog(): CateoPlmPartRecord[] {
  const releasedCases = releasedTroubleshootingCases();
  const releasedByPart = new Map<string, CateoCaseRecord[]>();
  for (const caseRecord of releasedCases) {
    const partNumber = (caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber || "").trim().toUpperCase();
    if (!partNumber) continue;
    const current = releasedByPart.get(partNumber) ?? [];
    current.push(caseRecord);
    releasedByPart.set(partNumber, current);
  }

  return listCateoPartMasterRecords().map((part) => {
    const linkedCases = releasedByPart.get(part.canonicalPartNumber) ?? releasedByPart.get(part.normalizedPartNumber) ?? [];
    const artifacts = part.artifactIds.map((artifactId) => loadArtifactRecord(artifactId)).filter((artifact): artifact is CateoArtifactRecord => Boolean(artifact));
    const coverage = {
      troubleshootingProcedures: artifacts.filter((artifact) => artifact.artifactType === "troubleshooting-procedure").length,
      serviceReports: artifacts.filter((artifact) => artifact.artifactType === "service-report").length,
      inspectionChecklists: artifacts.filter((artifact) => artifact.artifactType === "inspection-checklist").length,
      diagnosticLogs: artifacts.filter((artifact) => artifact.artifactType === "diagnostic-reasoning-log").length,
      partsToolsLists: artifacts.filter((artifact) => artifact.artifactType === "parts-tools-list").length,
    };
    const lifecycleState: CateoPlmPartRecord["lifecycleState"] = part.releasedArtifactCount > 0 ? "active" : part.sourceEvidenceCount > 0 ? "candidate" : "service-only";
    const maturity: CateoPlmPartRecord["maturity"] = part.releasedArtifactCount >= 6 ? "controlled" : part.releasedArtifactCount >= 2 ? "validated" : "emerging";
    return {
      ...part,
      lifecycleState,
      maturity,
      procedureCount: linkedCases.length,
      releasedProcedureCount: linkedCases.length,
      artifactCount: part.artifactIds.length,
      caseCount: part.caseIds.length,
      businessTypes: unique(linkedCases.map((entry) => entry.input.businessType || entry.context.businessType)),
      issueTypes: unique(linkedCases.map((entry) => entry.context.issueType || entry.input.issueType || entry.input.errorCode)),
      systemModels: unique(linkedCases.map((entry) => entry.context.machine?.model || entry.context.asset?.assetType || entry.context.asset?.assetId)),
      coverage,
    };
  });
}

export function listPlmParts(filters: { q?: string; manufacturer?: string; entityType?: string; lifecycleState?: string } = {}): CateoPlmPartRecord[] {
  const q = filters.q?.trim().toLowerCase();
  const manufacturer = filters.manufacturer?.trim().toLowerCase();
  const entityType = filters.entityType?.trim().toLowerCase();
  const lifecycleState = filters.lifecycleState?.trim().toLowerCase();
  return buildPlmPartCatalog()
    .filter((part) => {
      const haystack = JSON.stringify(part).toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (manufacturer && !(part.manufacturer ?? "").toLowerCase().includes(manufacturer)) return false;
      if (entityType && !part.entityTypes.some((value) => value.toLowerCase().includes(entityType))) return false;
      if (lifecycleState && part.lifecycleState.toLowerCase() != lifecycleState) return false;
      return true;
    })
    .sort((left, right) => right.releasedProcedureCount - left.releasedProcedureCount || right.lastSeenAt.localeCompare(left.lastSeenAt));
}

function toProcedureItem(caseRecord: CateoCaseRecord, partRecord: CateoPlmPartRecord | null, favorites: Set<string>, favoriteCounts: Record<string, number>): CateoProcedureLibraryItem {
  const artifacts = collectArtifacts(caseRecord);
  const reportPackage = artifacts.length > 0 ? buildTroubleshootingReportPackage(caseRecord, artifacts) : null;
  return {
    caseId: caseRecord.caseId,
    title: caseRecord.context.title,
    summary: caseRecord.interaction?.message,
    partNumber: caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber,
    businessType: caseRecord.input.businessType || caseRecord.context.businessType,
    issueType: caseRecord.context.issueType || caseRecord.input.issueType || caseRecord.input.errorCode,
    manufacturer: caseRecord.context.partResolution?.manufacturer || caseRecord.context.machine?.manufacturer,
    systemName: caseRecord.context.machine?.model || caseRecord.context.asset?.assetType || caseRecord.context.asset?.assetId,
    updatedAt: caseRecord.updatedAt,
    createdAt: caseRecord.createdAt,
    artifactCount: caseRecord.artifacts.length,
    procedureFolder: reportPackage?.indexing.folderPath,
    downloadable: Boolean(reportPackage),
    favoriteCount: favoriteCounts[caseRecord.caseId] ?? 0,
    favorited: favorites.has(caseRecord.caseId),
    lifecycleState: partRecord?.lifecycleState,
    maturity: partRecord?.maturity,
    entityTypes: partRecord?.entityTypes ?? [],
  };
}

export function listProcedureLibrary(filters: CateoProcedureLibraryFilters = {}, userId?: string): CateoProcedureLibraryItem[] {
  const favoriteSet = new Set(userId ? listProcedureFavoriteCaseIds(userId) : []);
  const favoriteCounts = countProcedureFavoritesByCaseId();
  const partRecords = new Map(buildPlmPartCatalog().map((record) => [record.normalizedPartNumber, record]));
  const q = filters.q?.trim().toLowerCase();
  const partNumber = filters.partNumber?.trim().toLowerCase();
  const businessType = filters.businessType?.trim().toLowerCase();
  const issueType = filters.issueType?.trim().toLowerCase();
  const manufacturer = filters.manufacturer?.trim().toLowerCase();
  return releasedTroubleshootingCases()
    .map((caseRecord) => {
      const normalizedPart = (caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber || "").trim().toUpperCase().replace(/\s+/g, "");
      const partRecord = normalizedPart ? (partRecords.get(normalizedPart) ?? null) : null;
      return toProcedureItem(caseRecord, partRecord, favoriteSet, favoriteCounts);
    })
    .filter((item) => {
      const haystack = JSON.stringify(item).toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (partNumber && !(item.partNumber ?? "").toLowerCase().includes(partNumber)) return false;
      if (businessType && !(item.businessType ?? "").toLowerCase().includes(businessType)) return false;
      if (issueType && !(item.issueType ?? "").toLowerCase().includes(issueType)) return false;
      if (manufacturer && !(item.manufacturer ?? "").toLowerCase().includes(manufacturer)) return false;
      return true;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function loadProcedureLibraryDetail(caseId: string, userId?: string): CateoProcedureLibraryDetail | null {
  const caseRecord = loadCaseRecord(caseId);
  if (!caseRecord || caseRecord.context.taskClass !== "troubleshooting" || caseRecord.interaction?.releaseStatus !== "available") {
    return null;
  }
  const artifacts = collectArtifacts(caseRecord);
  if (artifacts.length === 0) return null;
  const reportPackage = buildTroubleshootingReportPackage(caseRecord, artifacts);
  const normalizedPart = (caseRecord.context.partResolution?.partNumber || caseRecord.input.partNumber || "").trim().toUpperCase().replace(/\s+/g, "");
  const partRecord = normalizedPart ? (buildPlmPartCatalog().find((part) => part.normalizedPartNumber === normalizedPart) ?? null) : null;
  const favorites = new Set(userId ? listProcedureFavoriteCaseIds(userId) : []);
  const favoriteCounts = countProcedureFavoritesByCaseId();
  const item = toProcedureItem(caseRecord, partRecord, favorites, favoriteCounts);
  const relatedCases = listProcedureLibrary({ partNumber: item.partNumber }, userId).filter((entry) => entry.caseId !== caseId).slice(0, 8);
  return { item, caseRecord, reportPackage, partRecord, relatedCases, relatedArtifacts: artifacts };
}

