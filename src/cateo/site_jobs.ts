import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { createModelRuntime } from "../llm/runtime.js";
import { appendAuditEvent } from "../security/audit.js";
import { generateCateoArtifacts } from "./service.js";
import type { CateoAssistInput } from "./types.js";

const MAX_JOBS = 200;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

export type AssistJobStatus = "queued" | "running" | "completed" | "failed";
export type AssistJobResult = Awaited<ReturnType<typeof generateCateoArtifacts>>;

interface AssistJobRecord {
  jobId: string;
  status: AssistJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  requestId?: string;
  input?: CateoAssistInput;
  result?: AssistJobResult;
  error?: string;
}

export interface AssistJobSnapshot {
  jobId: string;
  status: AssistJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: AssistJobResult;
  error?: string;
}

const jobs = new Map<string, AssistJobRecord>();
const queue: string[] = [];
let draining = false;

function snapshot(record: AssistJobRecord): AssistJobSnapshot {
  return {
    jobId: record.jobId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    result: record.result,
    error: record.error,
  };
}

function compactJobs(): void {
  const now = Date.now();
  for (const [jobId, record] of jobs) {
    if (record.finishedAt && now - record.finishedAt > JOB_TTL_MS) {
      jobs.delete(jobId);
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
  }
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
  appendAuditEvent({
    actor: "server",
    category: "site_job",
    action: "assist_started",
    outcome: "running",
    message: `Cateo site job ${jobId} started`,
    requestId: record.requestId,
    metadata: { jobId },
  });

  try {
    const config = loadConfig();
    if (!config) {
      throw new Error("Cateo runtime is not configured");
    }

    const runtime = createModelRuntime(config);
    record.result = await generateCateoArtifacts(config, runtime, record.input, { actor: "site", requestId: record.requestId });
    record.status = "completed";
    record.finishedAt = Date.now();
    record.updatedAt = record.finishedAt;
    appendAuditEvent({
      actor: "server",
      category: "site_job",
      action: "assist_completed",
      outcome: "success",
      message: `Cateo site job ${jobId} completed`,
      requestId: record.requestId,
      metadata: { jobId, artifactCount: record.result.artifacts.length },
    });
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.finishedAt = Date.now();
    record.updatedAt = record.finishedAt;
    appendAuditEvent({
      actor: "server",
      category: "site_job",
      action: "assist_failed",
      outcome: "error",
      severity: "error",
      message: `Cateo site job ${jobId} failed`,
      requestId: record.requestId,
      metadata: { jobId, error: record.error },
    });
  } finally {
    record.input = undefined;
  }
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

export function submitAssistJob(input: CateoAssistInput, requestId?: string): AssistJobSnapshot {
  compactJobs();
  const now = Date.now();
  const jobId = crypto.randomUUID();
  const record: AssistJobRecord = {
    jobId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    requestId,
    input,
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
    metadata: { jobId, queueDepth: queue.length },
  });
  void drainQueue();
  return snapshot(record);
}

export function getAssistJob(jobId: string): AssistJobSnapshot | null {
  compactJobs();
  const record = jobs.get(jobId);
  return record ? snapshot(record) : null;
}
