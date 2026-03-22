import crypto from "node:crypto";
import path from "node:path";
import type { CashClawConfig, PilotQuotaConfig } from "../config.js";
import { getConfigDir, getPilotConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import type { CateoServiceTier } from "./types.js";

const PROFILE_DB_VERSION = "cateo-profile-db-v2";
const MAX_REQUESTER_IDS = 20;
const MAX_HISTORY_DAYS = 60;

function effectiveQuotaForTier(base: PilotQuotaConfig, serviceTier: CateoServiceTier): PilotQuotaConfig {
  if (serviceTier === "reviewed") {
    return {
      ...base,
      dailyRequestLimit: Math.max(base.dailyRequestLimit, Math.round(base.dailyRequestLimit * 2)),
      dailyInputTokenLimit: Math.max(base.dailyInputTokenLimit, Math.round(base.dailyInputTokenLimit * 2.5)),
      dailyOutputTokenLimit: Math.max(base.dailyOutputTokenLimit, Math.round(base.dailyOutputTokenLimit * 2.5)),
      dailyTotalTokenLimit: Math.max(base.dailyTotalTokenLimit, Math.round(base.dailyTotalTokenLimit * 2.5)),
      reservationTokensPerJob: Math.max(base.reservationTokensPerJob, Math.round(base.reservationTokensPerJob * 1.5)),
      maxPendingJobsPerProfile: Math.max(base.maxPendingJobsPerProfile, base.maxPendingJobsPerProfile + 2),
      maxPromptChars: Math.max(base.maxPromptChars, Math.round(base.maxPromptChars * 1.5)),
    };
  }

  if (serviceTier === "enterprise") {
    return {
      ...base,
      dailyRequestLimit: Math.max(base.dailyRequestLimit, Math.round(base.dailyRequestLimit * 5)),
      dailyInputTokenLimit: Math.max(base.dailyInputTokenLimit, Math.round(base.dailyInputTokenLimit * 6)),
      dailyOutputTokenLimit: Math.max(base.dailyOutputTokenLimit, Math.round(base.dailyOutputTokenLimit * 6)),
      dailyTotalTokenLimit: Math.max(base.dailyTotalTokenLimit, Math.round(base.dailyTotalTokenLimit * 6)),
      reservationTokensPerJob: Math.max(base.reservationTokensPerJob, Math.round(base.reservationTokensPerJob * 2.5)),
      maxPendingJobsPerProfile: Math.max(base.maxPendingJobsPerProfile, base.maxPendingJobsPerProfile + 6),
      maxPromptChars: Math.max(base.maxPromptChars, Math.round(base.maxPromptChars * 3)),
    };
  }

  return { ...base };
}

interface CateoQuotaReservation {
  reservationId: string;
  requesterId: string;
  requestId?: string;
  createdAt: string;
  estimatedTotalTokens: number;
}

interface CateoQuotaUsageDay {
  day: string;
  acceptedRequests: number;
  completedRequests: number;
  failedRequests: number;
  usedInputTokens: number;
  usedOutputTokens: number;
  usedTotalTokens: number;
  reservedTotalTokens: number;
  pendingJobs: number;
  reservations: CateoQuotaReservation[];
}

interface CateoProfileRecord {
  profileId: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  status: "active" | "suspended";
  displayName?: string;
  email?: string;
  emailHash?: string;
  organization?: string;
  roles: string[];
  requesterIds: string[];
  serviceTier: CateoServiceTier;
  reviewedOutputs: boolean;
  artifactDownloadAccess: boolean;
  usage: CateoQuotaUsageDay;
  usageHistory?: CateoQuotaUsageDay[];
}

interface CateoProfileStore {
  version: string;
  updatedAt: string;
  profiles: CateoProfileRecord[];
}

export interface CateoQuotaSnapshot {
  day: string;
  dailyRequestLimit: number;
  acceptedRequests: number;
  completedRequests: number;
  failedRequests: number;
  remainingRequests: number;
  dailyInputTokenLimit: number;
  dailyOutputTokenLimit: number;
  dailyTotalTokenLimit: number;
  usedInputTokens: number;
  usedOutputTokens: number;
  usedTotalTokens: number;
  reservedTotalTokens: number;
  remainingInputTokens: number;
  remainingOutputTokens: number;
  remainingTotalTokens: number;
  maxPendingJobsPerProfile: number;
  pendingJobs: number;
  reservationTokensPerJob: number;
}

export interface CateoQuotaHistoryPoint {
  day: string;
  acceptedRequests: number;
  completedRequests: number;
  failedRequests: number;
  usedInputTokens: number;
  usedOutputTokens: number;
  usedTotalTokens: number;
}

export interface CateoProfileSnapshot {
  profileId: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  status: "active" | "suspended";
  displayName?: string;
  email?: string;
  organization?: string;
  serviceTier: CateoServiceTier;
  reviewedOutputs: boolean;
  artifactDownloadAccess: boolean;
  quota: CateoQuotaSnapshot;
  history: CateoQuotaHistoryPoint[];
}

export interface CateoQuotaReservationReceipt {
  reservationId: string;
  estimatedTotalTokens: number;
  profile: CateoProfileSnapshot;
}

export class CateoPilotQuotaError extends Error {
  status: number;
  code: string;
  profile?: CateoProfileSnapshot;

  constructor(code: string, message: string, status = 429, profile?: CateoProfileSnapshot) {
    super(message);
    this.name = "CateoPilotQuotaError";
    this.code = code;
    this.status = status;
    this.profile = profile;
  }
}

function getProfileDbPath(): string {
  return path.join(getConfigDir(), "cateo", "security", "profiles.json");
}

function loadProfileStore(): CateoProfileStore {
  return readProtectedJson<CateoProfileStore>(getProfileDbPath(), {
    version: PROFILE_DB_VERSION,
    updatedAt: new Date(0).toISOString(),
    profiles: [],
  });
}

function saveProfileStore(store: CateoProfileStore): void {
  writeProtectedJson(getProfileDbPath(), store);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeText(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, maxLength);
}

function hashEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function emptyUsageDay(day = todayUtc()): CateoQuotaUsageDay {
  return {
    day,
    acceptedRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    usedTotalTokens: 0,
    reservedTotalTokens: 0,
    pendingJobs: 0,
    reservations: [],
  };
}

function toHistoryPoint(usage: CateoQuotaUsageDay): CateoQuotaHistoryPoint {
  return {
    day: usage.day,
    acceptedRequests: usage.acceptedRequests,
    completedRequests: usage.completedRequests,
    failedRequests: usage.failedRequests,
    usedInputTokens: usage.usedInputTokens,
    usedOutputTokens: usage.usedOutputTokens,
    usedTotalTokens: usage.usedTotalTokens,
  };
}

function archiveUsageDay(record: CateoProfileRecord, usage: CateoQuotaUsageDay): void {
  if (!usage.day) {
    return;
  }
  const nextHistory = [toHistoryPoint(usage), ...(record.usageHistory ?? []).map((entry) => toHistoryPoint(entry as CateoQuotaUsageDay))]
    .reduce<CateoQuotaHistoryPoint[]>((carry, current) => {
      if (carry.some((entry) => entry.day === current.day)) {
        return carry;
      }
      carry.push(current);
      return carry;
    }, [])
    .slice(0, MAX_HISTORY_DAYS);
  record.usageHistory = nextHistory.map((entry) => ({
    ...emptyUsageDay(entry.day),
    acceptedRequests: entry.acceptedRequests,
    completedRequests: entry.completedRequests,
    failedRequests: entry.failedRequests,
    usedInputTokens: entry.usedInputTokens,
    usedOutputTokens: entry.usedOutputTokens,
    usedTotalTokens: entry.usedTotalTokens,
  }));
}

function normalizeUsageDay(record: CateoProfileRecord): CateoQuotaUsageDay {
  const day = todayUtc();
  if (record.usage?.day === day) {
    return record.usage;
  }

  if (record.usage?.day) {
    archiveUsageDay(record, record.usage);
  }

  const carriedReservations = record.usage?.reservations ?? [];
  const carriedReservedTotalTokens = carriedReservations.reduce((sum, reservation) => sum + reservation.estimatedTotalTokens, 0);
  return {
    day,
    acceptedRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    usedTotalTokens: 0,
    reservedTotalTokens: carriedReservedTotalTokens,
    pendingJobs: carriedReservations.length,
    reservations: carriedReservations,
  };
}

function toProfileSnapshot(config: CashClawConfig, record: CateoProfileRecord): CateoProfileSnapshot {
  const pilot = getPilotConfig(config);
  const usage = normalizeUsageDay(record);
  const quota = effectiveQuotaForTier(pilot.quota, record.serviceTier);
  const history = [usage, ...(record.usageHistory ?? [])]
    .map((entry) => toHistoryPoint(entry))
    .reduce<CateoQuotaHistoryPoint[]>((carry, current) => {
      if (carry.some((entry) => entry.day === current.day)) {
        return carry;
      }
      carry.push(current);
      return carry;
    }, [])
    .slice(0, 14);

  return {
    profileId: record.profileId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    status: record.status,
    displayName: record.displayName,
    email: record.email,
    organization: record.organization,
    serviceTier: record.serviceTier,
    reviewedOutputs: record.reviewedOutputs,
    artifactDownloadAccess: record.artifactDownloadAccess,
    quota: {
      day: usage.day,
      dailyRequestLimit: quota.dailyRequestLimit,
      acceptedRequests: usage.acceptedRequests,
      completedRequests: usage.completedRequests,
      failedRequests: usage.failedRequests,
      remainingRequests: Math.max(0, quota.dailyRequestLimit - usage.acceptedRequests),
      dailyInputTokenLimit: quota.dailyInputTokenLimit,
      dailyOutputTokenLimit: quota.dailyOutputTokenLimit,
      dailyTotalTokenLimit: quota.dailyTotalTokenLimit,
      usedInputTokens: usage.usedInputTokens,
      usedOutputTokens: usage.usedOutputTokens,
      usedTotalTokens: usage.usedTotalTokens,
      reservedTotalTokens: usage.reservedTotalTokens,
      remainingInputTokens: Math.max(0, quota.dailyInputTokenLimit - usage.usedInputTokens),
      remainingOutputTokens: Math.max(0, quota.dailyOutputTokenLimit - usage.usedOutputTokens),
      remainingTotalTokens: Math.max(0, quota.dailyTotalTokenLimit - usage.usedTotalTokens - usage.reservedTotalTokens),
      maxPendingJobsPerProfile: quota.maxPendingJobsPerProfile,
      pendingJobs: usage.pendingJobs,
      reservationTokensPerJob: quota.reservationTokensPerJob,
    },
    history,
  };
}

function saveProfileRecord(config: CashClawConfig, store: CateoProfileStore, record: CateoProfileRecord): CateoProfileSnapshot {
  const nextProfiles = store.profiles.filter((entry) => entry.profileId !== record.profileId);
  nextProfiles.push(record);
  saveProfileStore({
    version: PROFILE_DB_VERSION,
    updatedAt: new Date().toISOString(),
    profiles: nextProfiles,
  });
  return toProfileSnapshot(config, record);
}

function findProfile(store: CateoProfileStore, profileId: string): CateoProfileRecord | null {
  return store.profiles.find((entry) => entry.profileId === profileId) ?? null;
}

function linkRequesterId(record: CateoProfileRecord, requesterId: string | undefined): void {
  const trimmed = requesterId?.trim();
  if (!trimmed) {
    return;
  }
  const next = [trimmed, ...record.requesterIds.filter((entry) => entry !== trimmed)].slice(0, MAX_REQUESTER_IDS);
  record.requesterIds = next;
}

export function upsertPilotProfile(
  config: CashClawConfig,
  input: {
    profileId?: string;
    requesterId?: string;
    displayName?: string;
    email?: string;
    organization?: string;
  },
  requestId?: string,
): CateoProfileSnapshot {
  const pilot = getPilotConfig(config);
  const now = new Date().toISOString();
  const store = loadProfileStore();
  const existing = input.profileId ? findProfile(store, input.profileId) : null;

  if (!existing && !pilot.allowAnonymousProfiles && !normalizeText(input.email, 240)) {
    throw new CateoPilotQuotaError("profile_email_required", "A verified email is required to open a Cateo pilot profile.", 400);
  }

  const record: CateoProfileRecord = existing ?? {
    profileId: input.profileId?.trim() || crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    status: "active",
    displayName: undefined,
    email: undefined,
    emailHash: undefined,
    organization: undefined,
    roles: ["pilot_user"],
    requesterIds: [],
    serviceTier: "free",
    reviewedOutputs: false,
    artifactDownloadAccess: true,
    usage: emptyUsageDay(),
    usageHistory: [],
  };

  const displayName = normalizeText(input.displayName, 120);
  const email = normalizeText(input.email, 240);
  const organization = normalizeText(input.organization, 160);

  if (displayName !== undefined) {
    record.displayName = displayName;
  } else if (!record.displayName) {
    record.displayName = "Pilot user";
  }
  if (email !== undefined) {
    record.email = email;
    record.emailHash = hashEmail(email);
  }
  if (organization !== undefined) {
    record.organization = organization;
  }

  record.lastSeenAt = now;
  record.updatedAt = now;
  record.usage = normalizeUsageDay(record);
  linkRequesterId(record, input.requesterId);

  const snapshot = saveProfileRecord(config, store, record);
  appendAuditEvent({
    actor: "server",
    category: "pilot_profile",
    action: existing ? "update" : "create",
    outcome: "success",
    message: existing ? `Updated pilot profile ${record.profileId}` : `Created pilot profile ${record.profileId}`,
    requestId,
    metadata: {
      profileId: record.profileId,
      requesterId: input.requesterId,
      hasEmail: Boolean(record.email),
      organization: record.organization,
    },
  });
  return snapshot;
}

export function getPilotProfile(
  config: CashClawConfig,
  profileId: string,
  requesterId?: string,
  _requestId?: string,
): CateoProfileSnapshot | null {
  const store = loadProfileStore();
  const record = findProfile(store, profileId);
  if (!record) {
    return null;
  }

  record.lastSeenAt = new Date().toISOString();
  record.updatedAt = record.lastSeenAt;
  record.usage = normalizeUsageDay(record);
  linkRequesterId(record, requesterId);
  return saveProfileRecord(config, store, record);
}

export function reservePilotQuota(
  config: CashClawConfig,
  profileId: string,
  requesterId: string,
  requestId?: string,
): CateoQuotaReservationReceipt {
  const pilot = getPilotConfig(config);
  const store = loadProfileStore();
  const record = findProfile(store, profileId);
  if (!record) {
    throw new CateoPilotQuotaError("profile_not_found", "Pilot profile not found.", 404);
  }

  record.usage = normalizeUsageDay(record);
  linkRequesterId(record, requesterId);
  record.lastSeenAt = new Date().toISOString();
  record.updatedAt = record.lastSeenAt;

  const currentSnapshot = toProfileSnapshot(config, record);
  if (record.status !== "active") {
    throw new CateoPilotQuotaError("profile_inactive", "This Cateo pilot profile is suspended.", 403, currentSnapshot);
  }

  const usage = record.usage;
  const quota = effectiveQuotaForTier(pilot.quota, record.serviceTier);
  const estimate = quota.enabled ? quota.reservationTokensPerJob : 0;
  if (usage.pendingJobs >= quota.maxPendingJobsPerProfile) {
    throw new CateoPilotQuotaError("pending_limit_exceeded", `This pilot profile already has ${usage.pendingJobs} pending job(s).`, 429, currentSnapshot);
  }
  if (quota.enabled && usage.acceptedRequests >= quota.dailyRequestLimit) {
    throw new CateoPilotQuotaError("request_limit_exceeded", "This pilot profile has reached the daily request limit.", 429, currentSnapshot);
  }
  if (quota.enabled && usage.usedTotalTokens + usage.reservedTotalTokens + estimate > quota.dailyTotalTokenLimit) {
    throw new CateoPilotQuotaError("token_limit_exceeded", "This pilot profile does not have enough remaining token budget for another queued job.", 429, currentSnapshot);
  }
  if (quota.enabled && (usage.usedInputTokens >= quota.dailyInputTokenLimit || usage.usedOutputTokens >= quota.dailyOutputTokenLimit)) {
    throw new CateoPilotQuotaError("directional_token_limit_exceeded", "This pilot profile has exhausted a daily token budget bucket.", 429, currentSnapshot);
  }

  const reservation: CateoQuotaReservation = {
    reservationId: crypto.randomUUID(),
    requesterId,
    requestId,
    createdAt: record.updatedAt,
    estimatedTotalTokens: estimate,
  };

  usage.acceptedRequests += 1;
  usage.pendingJobs += 1;
  usage.reservedTotalTokens += estimate;
  usage.reservations = [...usage.reservations, reservation];

  const snapshot = saveProfileRecord(config, store, record);
  appendAuditEvent({
    actor: "server",
    category: "pilot_quota",
    action: "reserve",
    outcome: "success",
    message: `Reserved pilot quota for profile ${profileId}`,
    requestId,
    metadata: {
      profileId,
      requesterId,
      reservationId: reservation.reservationId,
      estimatedTotalTokens: estimate,
      remainingTotalTokens: snapshot.quota.remainingTotalTokens,
      pendingJobs: snapshot.quota.pendingJobs,
    },
  });

  return {
    reservationId: reservation.reservationId,
    estimatedTotalTokens: estimate,
    profile: snapshot,
  };
}

export function settlePilotQuota(
  config: CashClawConfig,
  profileId: string,
  reservationId: string | undefined,
  usageInput: { inputTokens: number; outputTokens: number; totalTokens?: number } | undefined,
  outcome: "completed" | "failed",
  requestId?: string,
): CateoProfileSnapshot | null {
  const store = loadProfileStore();
  const record = findProfile(store, profileId);
  if (!record) {
    return null;
  }

  record.usage = normalizeUsageDay(record);
  record.lastSeenAt = new Date().toISOString();
  record.updatedAt = record.lastSeenAt;

  const usage = record.usage;
  const actualInputTokens = Math.max(0, Math.round(usageInput?.inputTokens ?? 0));
  const actualOutputTokens = Math.max(0, Math.round(usageInput?.outputTokens ?? 0));
  const actualTotalTokens = Math.max(0, Math.round(usageInput?.totalTokens ?? (actualInputTokens + actualOutputTokens)));

  let reservedTokens = 0;
  if (reservationId) {
    const reservation = usage.reservations.find((entry) => entry.reservationId === reservationId);
    reservedTokens = reservation?.estimatedTotalTokens ?? 0;
    usage.reservations = usage.reservations.filter((entry) => entry.reservationId !== reservationId);
  }

  usage.pendingJobs = Math.max(0, usage.pendingJobs - 1);
  usage.reservedTotalTokens = Math.max(0, usage.reservedTotalTokens - reservedTokens);
  usage.usedInputTokens += actualInputTokens;
  usage.usedOutputTokens += actualOutputTokens;
  usage.usedTotalTokens += actualTotalTokens;
  if (outcome === "completed") {
    usage.completedRequests += 1;
  } else {
    usage.failedRequests += 1;
  }

  const snapshot = saveProfileRecord(config, store, record);
  appendAuditEvent({
    actor: "server",
    category: "pilot_quota",
    action: "settle",
    outcome,
    message: `Settled pilot quota for profile ${profileId}`,
    requestId,
    metadata: {
      profileId,
      reservationId,
      inputTokens: actualInputTokens,
      outputTokens: actualOutputTokens,
      totalTokens: actualTotalTokens,
      remainingTotalTokens: snapshot.quota.remainingTotalTokens,
      pendingJobs: snapshot.quota.pendingJobs,
    },
  });

  return snapshot;
}


export function updatePilotProfileAdmin(
  config: CashClawConfig,
  profileId: string,
  input: {
    status?: "active" | "suspended";
    serviceTier?: CateoServiceTier;
    reviewedOutputs?: boolean;
    artifactDownloadAccess?: boolean;
    displayName?: string;
    organization?: string;
  },
  requestId?: string,
): CateoProfileSnapshot {
  const store = loadProfileStore();
  const record = findProfile(store, profileId);
  if (!record) {
    throw new CateoPilotQuotaError("profile_not_found", "Pilot profile not found.", 404);
  }

  record.status = input.status ?? record.status;
  record.serviceTier = input.serviceTier ?? record.serviceTier;
  record.reviewedOutputs = input.reviewedOutputs ?? record.reviewedOutputs;
  record.artifactDownloadAccess = input.artifactDownloadAccess ?? record.artifactDownloadAccess;
  const displayName = normalizeText(input.displayName, 120);
  const organization = normalizeText(input.organization, 160);
  if (displayName !== undefined) {
    record.displayName = displayName;
  }
  if (organization !== undefined) {
    record.organization = organization;
  }
  record.updatedAt = new Date().toISOString();
  record.lastSeenAt = record.updatedAt;
  record.usage = normalizeUsageDay(record);

  const snapshot = saveProfileRecord(config, store, record);
  appendAuditEvent({
    actor: "server",
    category: "pilot_profile",
    action: "admin_update",
    outcome: "success",
    message: `Admin updated pilot profile ${profileId}`,
    requestId,
    metadata: {
      profileId,
      status: snapshot.status,
      serviceTier: snapshot.serviceTier,
      reviewedOutputs: snapshot.reviewedOutputs,
      artifactDownloadAccess: snapshot.artifactDownloadAccess,
    },
  });
  return snapshot;
}
export function listPilotProfiles(config: CashClawConfig): CateoProfileSnapshot[] {
  return loadProfileStore().profiles
    .map((record) => toProfileSnapshot(config, { ...record, usage: normalizeUsageDay(record) }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

