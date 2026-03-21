import crypto from "node:crypto";
import path from "node:path";
import type { CashClawConfig } from "../config.js";
import { getConfigDir, getPilotConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";

const PROFILE_DB_VERSION = "cateo-profile-db-v1";
const MAX_REQUESTER_IDS = 20;

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
  usage: CateoQuotaUsageDay;
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

export interface CateoProfileSnapshot {
  profileId: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  status: "active" | "suspended";
  displayName?: string;
  email?: string;
  organization?: string;
  quota: CateoQuotaSnapshot;
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

function normalizeUsageDay(record: CateoProfileRecord): CateoQuotaUsageDay {
  const day = todayUtc();
  if (record.usage?.day === day) {
    return record.usage;
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
  const quota = pilot.quota;

  return {
    profileId: record.profileId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    status: record.status,
    displayName: record.displayName,
    email: record.email,
    organization: record.organization,
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
    usage: emptyUsageDay(),
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
  const estimate = pilot.quota.enabled ? pilot.quota.reservationTokensPerJob : 0;
  if (usage.pendingJobs >= pilot.quota.maxPendingJobsPerProfile) {
    throw new CateoPilotQuotaError("pending_limit_exceeded", `This pilot profile already has ${usage.pendingJobs} pending job(s).`, 429, currentSnapshot);
  }
  if (pilot.quota.enabled && usage.acceptedRequests >= pilot.quota.dailyRequestLimit) {
    throw new CateoPilotQuotaError("request_limit_exceeded", "This pilot profile has reached the daily request limit.", 429, currentSnapshot);
  }
  if (pilot.quota.enabled && usage.usedTotalTokens + usage.reservedTotalTokens + estimate > pilot.quota.dailyTotalTokenLimit) {
    throw new CateoPilotQuotaError("token_limit_exceeded", "This pilot profile does not have enough remaining token budget for another queued job.", 429, currentSnapshot);
  }
  if (pilot.quota.enabled && (usage.usedInputTokens >= pilot.quota.dailyInputTokenLimit || usage.usedOutputTokens >= pilot.quota.dailyOutputTokenLimit)) {
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
export function listPilotProfiles(config: CashClawConfig): CateoProfileSnapshot[] {
  return loadProfileStore().profiles
    .map((record) => toProfileSnapshot(config, { ...record, usage: normalizeUsageDay(record) }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
