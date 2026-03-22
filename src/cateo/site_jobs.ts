import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { createModelRuntime } from "../llm/runtime.js";
import { appendAuditEvent } from "../security/audit.js";
import { getCateoUsageFromError, generateCateoArtifacts } from "./service.js";
import { settlePilotQuota, type CateoProfileSnapshot } from "./profiles.js";
import type { CateoAssistInput, CateoInteractionCheckpoint } from "./types.js";

const MAX_JOBS = 200;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ESTIMATED_DURATION_MS = 2 * 60 * 1000;
const MIN_RUNNING_REMAINING_MS = 10 * 1000;
const MAX_DURATION_SAMPLES = 25;

export type AssistJobStatus = "queued" | "running" | "completed" | "failed";
export type AssistJobResult = Awaited<ReturnType<typeof generateCateoArtifacts>>;
export type AssistJobEventType = "snapshot" | "checkpoint" | "completed" | "failed";

interface AssistJobRecord {
  jobId: string;
  requesterId: string;
  profileId?: string;
  quotaReservationId?: string;
  acceptedSequence: number;
  title: string;
  promptPreview: string;
  status: AssistJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  requestId?: string;
  input?: CateoAssistInput;
  checkpoints: CateoInteractionCheckpoint[];
  result?: AssistJobResult;
  error?: string;
  profileDisplayName?: string;
  profileOrganization?: string;
  profileEmailHash?: string;
  profileServiceTier?: CateoProfileSnapshot["serviceTier"];
  requiresEngineerReview?: boolean;
}

export interface AssistJobSnapshot {
  jobId: string;
  requesterId: string;
  profileId?: string;
  acceptedSequence: number;
  title: string;
  promptPreview: string;
  status: AssistJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  backlogPosition: number | null;
  jobsAhead: number | null;
  estimatedWaitMs: number | null;
  estimatedDurationMs: number;
  estimatedCompletionAt: number | null;
  statusDetail: string;
  checkpoints: CateoInteractionCheckpoint[];
  result?: AssistJobResult;
  error?: string;
}

export interface AssistBacklogSnapshot {
  requesterId: string;
  generatedAt: number;
  pendingCount: number;
  queuedCount: number;
  runningCount: number;
  averageDurationMs: number;
  items: AssistJobSnapshot[];
}

export interface AssistJobEvent {
  eventId: number;
  type: AssistJobEventType;
  job: AssistJobSnapshot;
  checkpoint?: CateoInteractionCheckpoint;
}

interface PendingMetrics {
  backlogPosition: number | null;
  jobsAhead: number | null;
  estimatedWaitMs: number | null;
  estimatedDurationMs: number;
  estimatedCompletionAt: number | null;
}

interface SnapshotContext {
  now: number;
  averageDurationMs: number;
  queueIndexMap: Map<string, number>;
  runningJobId: string | null;
  runningRemainingMs: number;
}

type AssistJobListener = (event: AssistJobEvent) => void;

const jobs = new Map<string, AssistJobRecord>();
const queue: string[] = [];
const completedDurationsMs: number[] = [];
const listeners = new Map<string, Set<AssistJobListener>>();
let draining = false;
let drainTimer: NodeJS.Timeout | null = null;
let nextAcceptedSequence = 1;
let nextEventId = 1;

function deriveTitle(input: CateoAssistInput): string {
  const title = input.title?.trim();
  if (title) return title;
  const symptom = input.symptomDescription?.trim();
  if (symptom) return symptom.slice(0, 96);
  const query = input.query?.trim();
  if (query) return query.slice(0, 96);
  return "Cateo request";
}

function derivePromptPreview(input: CateoAssistInput): string {
  const raw = input.symptomDescription?.trim() || input.query?.trim() || input.title?.trim() || "Cateo request";
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}

function checkpointLabel(stage: CateoInteractionCheckpoint["stage"]): string {
  switch (stage) {
    case "accepted":
      return "Backlog";
    case "planning":
      return "Planner";
    case "building":
      return "Builder";
    case "reviewing":
      return "Reviewer";
    case "persisting":
      return "Artifact Store";
    case "rendering":
      return "Renderer";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    default:
      return "Cateo";
  }
}

function createCheckpoint(args: {
  stage: CateoInteractionCheckpoint["stage"];
  status: CateoInteractionCheckpoint["status"];
  summary: string;
  taskClass?: CateoInteractionCheckpoint["taskClass"];
  confidence?: CateoInteractionCheckpoint["confidence"];
  artifactTypes?: CateoInteractionCheckpoint["artifactTypes"];
  artifactCount?: CateoInteractionCheckpoint["artifactCount"];
}): CateoInteractionCheckpoint {
  return {
    checkpointId: crypto.randomUUID(),
    stage: args.stage,
    status: args.status,
    label: checkpointLabel(args.stage),
    summary: args.summary,
    occurredAt: Date.now(),
    taskClass: args.taskClass,
    confidence: args.confidence,
    artifactTypes: args.artifactTypes,
    artifactCount: args.artifactCount,
  };
}

function latestCheckpoint(record: AssistJobRecord): CateoInteractionCheckpoint | undefined {
  return record.checkpoints[record.checkpoints.length - 1];
}

function getAverageDurationMs(): number {
  if (completedDurationsMs.length === 0) {
    return DEFAULT_ESTIMATED_DURATION_MS;
  }

  const total = completedDurationsMs.reduce((sum, duration) => sum + duration, 0);
  return Math.max(MIN_RUNNING_REMAINING_MS, Math.round(total / completedDurationsMs.length));
}

function rememberDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return;
  }

  completedDurationsMs.push(durationMs);
  while (completedDurationsMs.length > MAX_DURATION_SAMPLES) {
    completedDurationsMs.shift();
  }
}

function compactJobs(): void {
  const now = Date.now();
  for (const [jobId, record] of jobs) {
    if (record.finishedAt && now - record.finishedAt > JOB_TTL_MS) {
      jobs.delete(jobId);
      listeners.delete(jobId);
    }
  }

  if (jobs.size <= MAX_JOBS) {
    return;
  }

  const removable = [...jobs.values()]
    .filter((record) => record.status === "completed" || record.status === "failed")
    .sort((left, right) => left.updatedAt - right.updatedAt);

  while (jobs.size > MAX_JOBS && removable.length > 0) {
    const record = removable.shift();
    if (!record) break;
    jobs.delete(record.jobId);
    listeners.delete(record.jobId);
  }
}

function getRunningRecord(): AssistJobRecord | null {
  const running = [...jobs.values()]
    .filter((record) => record.status === "running")
    .sort((left, right) => (left.startedAt ?? left.createdAt) - (right.startedAt ?? right.createdAt));

  return running[0] ?? null;
}

function buildSnapshotContext(now = Date.now()): SnapshotContext {
  const queueIndexMap = new Map<string, number>();
  queue.forEach((jobId, index) => queueIndexMap.set(jobId, index));

  const runningRecord = getRunningRecord();
  const averageDurationMs = getAverageDurationMs();
  const runningRemainingMs = runningRecord
    ? Math.max(MIN_RUNNING_REMAINING_MS, averageDurationMs - (now - (runningRecord.startedAt ?? now)))
    : 0;

  return {
    now,
    averageDurationMs,
    queueIndexMap,
    runningJobId: runningRecord?.jobId ?? null,
    runningRemainingMs,
  };
}

function buildPendingMetrics(record: AssistJobRecord, context: SnapshotContext): PendingMetrics {
  if (record.status === "running") {
    return {
      backlogPosition: 1,
      jobsAhead: 0,
      estimatedWaitMs: 0,
      estimatedDurationMs: context.averageDurationMs,
      estimatedCompletionAt: context.now + context.runningRemainingMs,
    };
  }

  if (record.status === "queued") {
    const queueIndex = context.queueIndexMap.get(record.jobId) ?? 0;
    const jobsAhead = queueIndex + (context.runningJobId ? 1 : 0);
    const estimatedWaitMs = (context.runningJobId ? context.runningRemainingMs : 0) + (queueIndex * context.averageDurationMs);
    return {
      backlogPosition: jobsAhead + 1,
      jobsAhead,
      estimatedWaitMs,
      estimatedDurationMs: context.averageDurationMs,
      estimatedCompletionAt: context.now + estimatedWaitMs + context.averageDurationMs,
    };
  }

  return {
    backlogPosition: null,
    jobsAhead: null,
    estimatedWaitMs: null,
    estimatedDurationMs: context.averageDurationMs,
    estimatedCompletionAt: null,
  };
}

function buildStatusDetail(record: AssistJobRecord, metrics: PendingMetrics): string {
  const latest = latestCheckpoint(record);

  if (record.status === "running") {
    return latest?.summary || "Processing now.";
  }

  if (record.status === "queued") {
    if ((metrics.jobsAhead ?? 0) === 0) {
      return "Next in line for artifact generation.";
    }
    return `Waiting behind ${metrics.jobsAhead} earlier accepted request(s).`;
  }

  if (record.status === "completed") {
    return latest?.summary || "Completed.";
  }

  return latest?.summary || (record.error ? `Failed: ${record.error}` : "Failed.");
}

function snapshot(record: AssistJobRecord, context = buildSnapshotContext()): AssistJobSnapshot {
  const metrics = buildPendingMetrics(record, context);
  return {
    jobId: record.jobId,
    requesterId: record.requesterId,
    profileId: record.profileId,
    acceptedSequence: record.acceptedSequence,
    title: record.title,
    promptPreview: record.promptPreview,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    backlogPosition: metrics.backlogPosition,
    jobsAhead: metrics.jobsAhead,
    estimatedWaitMs: metrics.estimatedWaitMs,
    estimatedDurationMs: metrics.estimatedDurationMs,
    estimatedCompletionAt: metrics.estimatedCompletionAt,
    statusDetail: buildStatusDetail(record, metrics),
    checkpoints: record.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    result: record.result,
    error: record.error,
  };
}

function emitJobEvent(record: AssistJobRecord, type: AssistJobEventType, checkpoint?: CateoInteractionCheckpoint): void {
  const bucket = listeners.get(record.jobId);
  if (!bucket || bucket.size === 0) {
    return;
  }

  const event: AssistJobEvent = {
    eventId: nextEventId,
    type,
    job: snapshot(record),
    checkpoint,
  };
  nextEventId += 1;

  for (const listener of [...bucket]) {
    listener(event);
  }
}

function recordCheckpoint(record: AssistJobRecord, checkpoint: CateoInteractionCheckpoint, emitType: AssistJobEventType = "checkpoint"): void {
  record.checkpoints.push(checkpoint);
  record.updatedAt = Date.now();
  emitJobEvent(record, emitType, checkpoint);
}

async function runNextJob(): Promise<void> {
  const jobId = queue.shift();
  if (!jobId) {
    return;
  }

  const record = jobs.get(jobId);
  if (!record || !record.input) {
    return;
  }

  record.status = "running";
  record.startedAt = Date.now();
  record.updatedAt = record.startedAt;
  emitJobEvent(record, "snapshot");
  appendAuditEvent({
    actor: "server",
    category: "site_job",
    action: "assist_started",
    outcome: "running",
    message: `Cateo site job ${jobId} started`,
    requestId: record.requestId,
    metadata: { jobId, requesterId: record.requesterId, profileId: record.profileId, acceptedSequence: record.acceptedSequence },
  });

  let config = loadConfig();

  try {
    if (!config) {
      throw new Error("Cateo runtime is not configured");
    }

    const runtime = createModelRuntime(config);
    const result = await generateCateoArtifacts(config, runtime, record.input, {
      actor: "site",
      requestId: record.requestId,
      requester: record.profileId ? {
        profileId: record.profileId,
        requesterId: record.requesterId,
        displayName: record.profileDisplayName,
        organization: record.profileOrganization,
        emailHash: record.profileEmailHash,
        serviceTier: record.profileServiceTier,
        requiresEngineerReview: record.requiresEngineerReview,
      } : undefined,
      onCheckpoint: (checkpoint) => {
        recordCheckpoint(record, checkpoint, "checkpoint");
      },
    });
    record.result = result;
    record.status = "completed";
    record.finishedAt = Date.now();
    record.updatedAt = record.finishedAt;
    if (record.startedAt) {
      rememberDuration(record.finishedAt - record.startedAt);
    }
    if (config && record.profileId) {
      settlePilotQuota(config, record.profileId, record.quotaReservationId, result.usage, "completed", record.requestId);
    }
    emitJobEvent(record, "completed");
    appendAuditEvent({
      actor: "server",
      category: "site_job",
      action: "assist_completed",
      outcome: "success",
      message: `Cateo site job ${jobId} completed`,
      requestId: record.requestId,
      metadata: {
        jobId,
        requesterId: record.requesterId,
        profileId: record.profileId,
        artifactCount: record.result.artifacts.length,
        totalTokens: record.result.usage?.totalTokens,
      },
    });
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.finishedAt = Date.now();
    record.updatedAt = record.finishedAt;
    if (config && record.profileId) {
      settlePilotQuota(config, record.profileId, record.quotaReservationId, getCateoUsageFromError(error), "failed", record.requestId);
    }
    recordCheckpoint(record, createCheckpoint({
      stage: "failed",
      status: "failed",
      summary: record.error,
    }), "failed");
    appendAuditEvent({
      actor: "server",
      category: "site_job",
      action: "assist_failed",
      outcome: "error",
      severity: "error",
      message: `Cateo site job ${jobId} failed`,
      requestId: record.requestId,
      metadata: { jobId, requesterId: record.requesterId, profileId: record.profileId, error: record.error },
    });
  } finally {
    record.input = undefined;
  }
}

function scheduleDrain(): void {
  if (drainTimer) {
    return;
  }
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainQueue();
  }, 500);
}

async function drainQueue(): Promise<void> {
  if (draining) {
    return;
  }

  draining = true;
  try {
    while (queue.length > 0) {
      await runNextJob();
    }
  } finally {
    draining = false;
  }
}

export function submitAssistJob(
  input: CateoAssistInput,
  requesterId: string,
  requestId?: string,
  options?: { profile?: CateoProfileSnapshot; quotaReservationId?: string; requiresEngineerReview?: boolean },
): AssistJobSnapshot {
  compactJobs();
  const now = Date.now();
  const jobId = crypto.randomUUID();
  const acceptedSequence = nextAcceptedSequence;
  nextAcceptedSequence += 1;
  const acceptedCheckpoint = createCheckpoint({
    stage: "accepted",
    status: "completed",
    summary: "Request received and pushed to the Cateo backlog.",
  });
  const record: AssistJobRecord = {
    jobId,
    requesterId,
    profileId: options?.profile?.profileId,
    quotaReservationId: options?.quotaReservationId,
    acceptedSequence,
    title: deriveTitle(input),
    promptPreview: derivePromptPreview(input),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    requestId,
    input,
    checkpoints: [acceptedCheckpoint],
    profileDisplayName: options?.profile?.displayName,
    profileOrganization: options?.profile?.organization,
    profileServiceTier: options?.profile?.serviceTier,
    requiresEngineerReview: options?.requiresEngineerReview ?? options?.profile?.reviewedOutputs ?? false,
  };

  jobs.set(jobId, record);
  queue.push(jobId);
  appendAuditEvent({
    actor: "server",
    category: "site_job",
    action: "assist_queued",
    outcome: "queued",
    message: `Cateo site job ${jobId} queued`,
    requestId,
    metadata: { jobId, requesterId, profileId: record.profileId, acceptedSequence: record.acceptedSequence, queueDepth: queue.length },
  });
  const submittedSnapshot = snapshot(record);
  void drainQueue();
  return submittedSnapshot;
}

export function getAssistJob(jobId: string, requesterId?: string): AssistJobSnapshot | null {
  compactJobs();
  const record = jobs.get(jobId);
  if (!record) {
    return null;
  }
  if (requesterId && record.requesterId !== requesterId) {
    return null;
  }
  return snapshot(record);
}

export function listAssistBacklog(requesterId: string): AssistBacklogSnapshot {
  compactJobs();
  const context = buildSnapshotContext();
  const pending = [...jobs.values()]
    .filter((record) => record.requesterId === requesterId && (record.status === "queued" || record.status === "running"))
    .sort((left, right) => left.acceptedSequence - right.acceptedSequence)
    .map((record) => snapshot(record, context));

  return {
    requesterId,
    generatedAt: context.now,
    pendingCount: pending.length,
    queuedCount: pending.filter((record) => record.status === "queued").length,
    runningCount: pending.filter((record) => record.status === "running").length,
    averageDurationMs: context.averageDurationMs,
    items: pending,
  };
}

export function subscribeAssistJob(jobId: string, requesterId: string, listener: AssistJobListener): (() => void) | null {
  compactJobs();
  const record = jobs.get(jobId);
  if (!record || record.requesterId !== requesterId) {
    return null;
  }

  let bucket = listeners.get(jobId);
  if (!bucket) {
    bucket = new Set<AssistJobListener>();
    listeners.set(jobId, bucket);
  }
  bucket.add(listener);
  listener({ eventId: nextEventId++, type: "snapshot", job: snapshot(record) });

  return () => {
    const active = listeners.get(jobId);
    if (!active) {
      return;
    }
    active.delete(listener);
    if (active.size === 0) {
      listeners.delete(jobId);
    }
  };
}





