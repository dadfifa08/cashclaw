import crypto from "node:crypto";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { listAdminArtifacts, listAdminCases, listAdminConversations } from "./admin_views.js";
import { listCateoPartMasterRecords } from "./part_master.js";

const ADMIN_PACKS_VERSION = "cateo-admin-packs-v1";

type ViewScope = "command-center" | "cases" | "conversations" | "artifacts" | "parts";

export interface CateoSavedAdminView {
  viewId: string;
  title: string;
  description?: string;
  scope: ViewScope;
  filters: Record<string, string>;
  ownerUserId: string;
  ownerDisplayName?: string;
  createdAt: string;
  updatedAt: string;
  builtIn?: boolean;
}

export interface CateoReportingPack {
  packId: string;
  title: string;
  description?: string;
  generatedAt: string;
  generatedBy: string;
  filters: Record<string, string>;
  summary: {
    caseCount: number;
    conversationCount: number;
    artifactCount: number;
    partCount: number;
    pendingReviewCount: number;
    releasedCount: number;
    draftArtifactCount: number;
    reviewedArtifactCount: number;
    approvedArtifactCount: number;
    topParts: Array<{ label: string; value: number }>;
    topFailureCodes: Array<{ label: string; value: number }>;
    topOrganizations: Array<{ label: string; value: number }>;
  };
  references: {
    caseIds: string[];
    conversationIds: string[];
    artifactIds: string[];
    partNumbers: string[];
  };
}

interface AdminViewStoreFile {
  version: string;
  updatedAt: string;
  views: CateoSavedAdminView[];
}

interface ReportingPackStoreFile {
  version: string;
  updatedAt: string;
  packs: CateoReportingPack[];
}

function viewPath(): string {
  return path.join(getConfigDir(), "cateo", "db", "admin_views.json");
}

function reportingPackPath(): string {
  return path.join(getConfigDir(), "cateo", "db", "reporting_packs.json");
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalizeFilters(filters: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filters)
      .map(([key, value]) => [key, value?.trim() ?? ""])
      .filter(([, value]) => Boolean(value)),
  );
}

function defaultViews(): CateoSavedAdminView[] {
  const createdAt = new Date(0).toISOString();
  return [
    {
      viewId: "built-in-pending-release",
      title: "Pending reviewed releases",
      description: "Reviewed-document requests waiting for controlled release.",
      scope: "cases",
      filters: { workflowMode: "reviewed-document", releaseStatus: "pending-engineer-review" },
      ownerUserId: "cateo-system",
      ownerDisplayName: "Cateo",
      createdAt,
      updatedAt: createdAt,
      builtIn: true,
    },
    {
      viewId: "built-in-enterprise-artifacts",
      title: "Enterprise artifact estate",
      description: "Enterprise-tier artifacts across all approval states.",
      scope: "artifacts",
      filters: { serviceTier: "enterprise" },
      ownerUserId: "cateo-system",
      ownerDisplayName: "Cateo",
      createdAt,
      updatedAt: createdAt,
      builtIn: true,
    },
    {
      viewId: "built-in-saved-conversations",
      title: "Saved conversations",
      description: "User conversations that have been retained for follow-up and reporting.",
      scope: "conversations",
      filters: { saved: "true" },
      ownerUserId: "cateo-system",
      ownerDisplayName: "Cateo",
      createdAt,
      updatedAt: createdAt,
      builtIn: true,
    },
  ];
}

function loadViewStore(): AdminViewStoreFile {
  return readProtectedJson<AdminViewStoreFile>(viewPath(), {
    version: ADMIN_PACKS_VERSION,
    updatedAt: new Date(0).toISOString(),
    views: [],
  });
}

function saveViewStore(file: AdminViewStoreFile): void {
  writeProtectedJson(viewPath(), file);
}

function loadReportingStore(): ReportingPackStoreFile {
  return readProtectedJson<ReportingPackStoreFile>(reportingPackPath(), {
    version: ADMIN_PACKS_VERSION,
    updatedAt: new Date(0).toISOString(),
    packs: [],
  });
}

function saveReportingStore(file: ReportingPackStoreFile): void {
  writeProtectedJson(reportingPackPath(), file);
}

export function listSavedAdminViews(ownerUserId?: string): CateoSavedAdminView[] {
  const persisted = loadViewStore().views;
  const filteredPersisted = ownerUserId ? persisted.filter((view) => view.ownerUserId === ownerUserId) : persisted;
  return [...defaultViews(), ...filteredPersisted].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function saveAdminView(input: { title: string; description?: string; scope: ViewScope; filters: Record<string, string | undefined>; ownerUserId: string; ownerDisplayName?: string }): CateoSavedAdminView {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Saved views require a title.");
  }
  const store = loadViewStore();
  const now = new Date().toISOString();
  const view: CateoSavedAdminView = {
    viewId: crypto.randomUUID(),
    title,
    description: input.description?.trim() || undefined,
    scope: input.scope,
    filters: normalizeFilters(input.filters),
    ownerUserId: input.ownerUserId,
    ownerDisplayName: input.ownerDisplayName,
    createdAt: now,
    updatedAt: now,
  };
  store.views = [view, ...store.views].slice(0, 60);
  store.updatedAt = now;
  saveViewStore(store);
  return view;
}

export function deleteAdminView(viewId: string, ownerUserId: string): void {
  const store = loadViewStore();
  store.views = store.views.filter((view) => !(view.viewId === viewId && view.ownerUserId === ownerUserId));
  store.updatedAt = new Date().toISOString();
  saveViewStore(store);
}

function countTop(values: string[], limit = 5): Array<{ label: string; value: number }> {
  const map = new Map<string, number>();
  for (const value of values.map((entry) => entry.trim()).filter(Boolean)) {
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

export function listReportingPacks(): CateoReportingPack[] {
  return [...loadReportingStore().packs].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
}

export function createReportingPack(input: { title: string; description?: string; filters: Record<string, string | undefined>; generatedBy: string }): CateoReportingPack {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Reporting packs require a title.");
  }
  const filters = normalizeFilters(input.filters);
  const cases = listAdminCases(filters);
  const conversations = listAdminConversations(filters);
  const artifacts = listAdminArtifacts(filters);
  const parts = listCateoPartMasterRecords({
    q: filters.q,
    partNumber: filters.partNumber,
    productOffering: filters.productOffering,
  });
  const pack: CateoReportingPack = {
    packId: crypto.randomUUID(),
    title,
    description: input.description?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    generatedBy: input.generatedBy,
    filters,
    summary: {
      caseCount: cases.length,
      conversationCount: conversations.length,
      artifactCount: artifacts.length,
      partCount: parts.length,
      pendingReviewCount: cases.filter((item) => item.releaseStatus === "pending-engineer-review").length,
      releasedCount: cases.filter((item) => item.releaseStatus === "available").length,
      draftArtifactCount: artifacts.filter((item) => item.approvalState === "draft").length,
      reviewedArtifactCount: artifacts.filter((item) => item.approvalState === "reviewed").length,
      approvedArtifactCount: artifacts.filter((item) => item.approvalState === "approved").length,
      topParts: countTop(parts.map((item) => item.canonicalPartNumber)),
      topFailureCodes: countTop(artifacts.map((item) => item.failureCode ?? "")),
      topOrganizations: countTop([...cases.map((item) => item.organization ?? ""), ...conversations.map((item) => item.organization ?? "")]),
    },
    references: {
      caseIds: unique(cases.map((item) => item.caseId)).slice(0, 40),
      conversationIds: unique(conversations.map((item) => item.conversationId)).slice(0, 40),
      artifactIds: unique(artifacts.map((item) => item.artifactId)).slice(0, 60),
      partNumbers: unique(parts.map((item) => item.canonicalPartNumber)).slice(0, 60),
    },
  };

  const store = loadReportingStore();
  store.packs = [pack, ...store.packs].slice(0, 80);
  store.updatedAt = pack.generatedAt;
  saveReportingStore(store);
  return pack;
}
