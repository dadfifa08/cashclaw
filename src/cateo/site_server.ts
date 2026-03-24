import http from "node:http";
import crypto from "node:crypto";
import { getPilotConfig, loadConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { handleCateoInternalApi, INTERNAL_CATEO_PREFIX } from "./http_api.js";
import { handleCateoSitePublicApi } from "./public_api.js";
import { createInternalRequestVerifier, getInternalServiceToken } from "../system/service_auth.js";
import { readRequestBody } from "../system/request_body.js";
import { getAssistJob, listAssistBacklog, submitAssistJob, submitCompletedAssistJob, subscribeAssistJob } from "./site_jobs.js";
import type { AssistBacklogSnapshot, AssistJobEvent, AssistJobSnapshot } from "./site_jobs.js";
import { CateoPilotQuotaError, getPilotProfile, reservePilotQuota, settlePilotQuota, upsertPilotProfile, type CateoProfileSnapshot } from "./profiles.js";
import { findMatchingValidatedProcedure } from "./service.js";
import type { CateoAssistInput, CateoInteractionCheckpoint } from "./types.js";

const DEFAULT_SITE_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_SITE_BRIDGE_PORT = 3788;
const JOBS_PREFIX = `${INTERNAL_CATEO_PREFIX}/jobs/assist`;
const JOB_STREAM_SUFFIX = "/stream";
const REQUESTER_HEADER = "x-cateo-client-id";
const PROFILE_HEADER = "x-cateo-profile-id";
const REQUESTER_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const SSE_KEEPALIVE_MS = 15000;
const SUBMISSION_WINDOW_MS = 10 * 60 * 1000;
const SUBMISSION_LIMIT_PER_REQUESTER = 8;
const SUBMISSION_LIMIT_PER_IP = 18;
const submissionWindow = new Map<string, number[]>();

interface PublicChatArtifactSummary {
  artifactId: string;
  artifactType: string;
  title: string;
  approvalState: string;
}

interface PublicChatResponse {
  message: string;
  summary: string;
  highlights: string[];
  nextActions: string[];
  confidence: "low" | "medium" | "high";
  artifactCount: number;
  interaction?: {
    message: string;
    highlights: string[];
    nextActions: string[];
    confidence: "low" | "medium" | "high";
    artifactCount: number;
    releaseStatus?: string;
    requiresEngineerReview?: boolean;
    clarifyingQuestion?: string;
    detailLevel?: "concise" | "balanced" | "detailed";
    sections?: Array<{ sectionId: string; title: string; tone: "info" | "caution" | "success"; items: string[] }>;
    artifactPreviews?: Array<{ artifactId: string; artifactType: string; title: string; summary: string; approvalState: string; revisionNumber: number }>;
  };
  artifacts: PublicChatArtifactSummary[];
}

interface PublicQueueJob {
  jobId: string;
  requesterId: string;
  acceptedSequence: number;
  title: string;
  promptPreview: string;
  status: AssistJobSnapshot["status"];
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
  result?: PublicChatResponse;
  error?: string;
}

interface PublicBacklogSnapshot {
  requesterId: string;
  generatedAt: number;
  pendingCount: number;
  queuedCount: number;
  runningCount: number;
  averageDurationMs: number;
  items: PublicQueueJob[];
}

interface PublicStreamEnvelope {
  ok: true;
  message: string;
  job: PublicQueueJob;
  backlog: PublicBacklogSnapshot;
  checkpoint?: CateoInteractionCheckpoint;
  profile?: CateoProfileSnapshot;
}

export interface CateoSiteBridgeSettings {
  host: string;
  port: number;
  baseUrl: string;
}

export function getCateoSiteBridgeHost(): string {
  return process.env.CATEO_SITE_HOST?.trim() || DEFAULT_SITE_BRIDGE_HOST;
}

export function getCateoSiteBridgePort(): number {
  const raw = process.env.CATEO_SITE_PORT?.trim();
  const parsed = raw ? Number(raw) : DEFAULT_SITE_BRIDGE_PORT;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_SITE_BRIDGE_PORT;
}

export function resolveCateoSiteBridgeSettings(): CateoSiteBridgeSettings {
  const host = getCateoSiteBridgeHost();
  const port = getCateoSiteBridgePort();
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
  };
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function setHeaders(res: http.ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}

function pruneSubmissionWindow(key: string, now = Date.now()): number[] {
  const recent = (submissionWindow.get(key) ?? []).filter((stamp) => now - stamp <= SUBMISSION_WINDOW_MS);
  submissionWindow.set(key, recent);
  return recent;
}

function assertSubmissionAllowed(requesterId: string, remoteAddress: string | undefined): void {
  const now = Date.now();
  const requesterKey = `requester:${requesterId}`;
  const requesterRecent = pruneSubmissionWindow(requesterKey, now);
  if (requesterRecent.length >= SUBMISSION_LIMIT_PER_REQUESTER) {
    throw new CateoPilotQuotaError("submission_rate_limited", "Too many queued requests for this account. Please wait before submitting another request.", 429);
  }
  if (remoteAddress) {
    const ipKey = `ip:${remoteAddress}`;
    const ipRecent = pruneSubmissionWindow(ipKey, now);
    if (ipRecent.length >= SUBMISSION_LIMIT_PER_IP) {
      throw new CateoPilotQuotaError("ip_rate_limited", "This network has reached the submission rate limit. Please try again later.", 429);
    }
  }
}

function noteSubmission(requesterId: string, remoteAddress: string | undefined): void {
  const now = Date.now();
  const requesterKey = `requester:${requesterId}`;
  submissionWindow.set(requesterKey, [...pruneSubmissionWindow(requesterKey, now), now]);
  if (remoteAddress) {
    const ipKey = `ip:${remoteAddress}`;
    submissionWindow.set(ipKey, [...pruneSubmissionWindow(ipKey, now), now]);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return readRequestBody(req, { maxBytes: 20_971_520 });
}

function parseJsonBody<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
}

function getRequesterId(req: http.IncomingMessage): string | null {
  const header = req.headers[REQUESTER_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  const requesterId = raw?.trim();
  if (!requesterId) {
    return null;
  }
  return REQUESTER_ID_PATTERN.test(requesterId) ? requesterId : null;
}

function getProfileId(req: http.IncomingMessage): string | null {
  const header = req.headers[PROFILE_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  const profileId = raw?.trim();
  if (!profileId) {
    return null;
  }
  return PROFILE_ID_PATTERN.test(profileId) ? profileId : null;
}

function toPublicChatResponse(job: AssistJobSnapshot): PublicChatResponse | undefined {
  const result = job.result;
  if (!result) {
    return undefined;
  }

  const reviewPending = Boolean(result.interaction?.requiresEngineerReview);
  const summary = result.summary?.trim() || result.interaction?.message || "Cateo prepared a controlled engineering response package.";
  const interaction = result.interaction
    ? {
      message: reviewPending
        ? "Cateo assembled the requested engineering package and sent it to the engineer review bucket. It will be released to the customer profile after password-backed admin sign-off."
        : result.interaction.message,
      highlights: reviewPending
        ? [
          "The requested artifact package was generated and fully logged.",
          "A human engineer review is required before customer release.",
        ]
        : result.interaction.highlights ?? [],
      nextActions: reviewPending
        ? ["Wait for engineer sign-off before downloading or acting on the final released package."]
        : result.interaction.nextActions ?? [],
      confidence: result.interaction.confidence ?? "medium",
      artifactCount: result.interaction.artifactCount ?? result.artifacts.length,
      releaseStatus: result.interaction.releaseStatus,
      requiresEngineerReview: result.interaction.requiresEngineerReview,
      clarifyingQuestion: result.interaction.clarifyingQuestion,
      detailLevel: result.interaction.detailLevel,
      sections: result.interaction.sections,
      artifactPreviews: result.interaction.artifactPreviews,
    }
    : undefined;

  return {
    message: interaction?.message ?? summary,
    summary: reviewPending ? "Cateo generated the report package and queued engineer review before release." : summary,
    highlights: interaction?.highlights ?? [],
    nextActions: interaction?.nextActions ?? [],
    confidence: interaction?.confidence ?? "medium",
    artifactCount: interaction?.artifactCount ?? result.artifacts.length,
    interaction,
    artifacts: result.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      title: artifact.revisions.at(-1)?.summary || artifact.artifactType,
      approvalState: artifact.revisions.at(-1)?.approvalState || "draft",
    })),
  };
}

function toPublicJob(job: AssistJobSnapshot): PublicQueueJob {
  return {
    jobId: job.jobId,
    requesterId: job.requesterId,
    acceptedSequence: job.acceptedSequence,
    title: job.title,
    promptPreview: job.promptPreview,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    backlogPosition: job.backlogPosition,
    jobsAhead: job.jobsAhead,
    estimatedWaitMs: job.estimatedWaitMs,
    estimatedDurationMs: job.estimatedDurationMs,
    estimatedCompletionAt: job.estimatedCompletionAt,
    statusDetail: job.statusDetail,
    checkpoints: job.checkpoints,
    result: toPublicChatResponse(job),
    error: job.error,
  };
}

function toPublicBacklog(backlog: AssistBacklogSnapshot): PublicBacklogSnapshot {
  return {
    requesterId: backlog.requesterId,
    generatedAt: backlog.generatedAt,
    pendingCount: backlog.pendingCount,
    queuedCount: backlog.queuedCount,
    runningCount: backlog.runningCount,
    averageDurationMs: backlog.averageDurationMs,
    items: backlog.items.map((job) => toPublicJob(job)),
  };
}

function summarizeQueueJob(job: AssistJobSnapshot): string {
  if (job.status === "running") {
    return job.checkpoints.at(-1)?.summary || "Request received and currently in progress.";
  }

  if (job.status === "queued") {
    const position = typeof job.backlogPosition === "number" ? `Queue position ${job.backlogPosition}.` : "Queued for processing.";
    if ((job.jobsAhead ?? 0) > 0) {
      return `Request received and pushed to backlog. ${position} ${job.jobsAhead} earlier accepted request(s) ahead.`;
    }
    return `Request received and pushed to backlog. ${position} Next in line.`;
  }

  if (job.status === "completed") {
    return job.checkpoints.at(-1)?.summary || "Artifact package completed.";
  }

  return job.error ? `Request failed: ${job.error}` : "Request failed.";
}

function summarizeBacklog(backlog: AssistBacklogSnapshot): string {
  if (backlog.pendingCount === 0) {
    return "No pending outputs in your backlog.";
  }

  return `Tracking ${backlog.pendingCount} pending output(s): ${backlog.runningCount} in progress, ${backlog.queuedCount} queued.`;
}

function currentProfileSnapshot(profileId: string | undefined, requesterId: string): CateoProfileSnapshot | undefined {
  const config = loadConfig();
  if (!config || !profileId) {
    return undefined;
  }
  return getPilotProfile(config, profileId, requesterId) ?? undefined;
}

function streamEnvelope(job: AssistJobSnapshot, checkpoint?: CateoInteractionCheckpoint): PublicStreamEnvelope {
  const backlog = listAssistBacklog(job.requesterId);
  return {
    ok: true,
    message: summarizeQueueJob(job),
    job: toPublicJob(job),
    backlog: toPublicBacklog(backlog),
    checkpoint,
    profile: currentProfileSnapshot(job.profileId, job.requesterId),
  };
}

function openSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

function writeSse(res: http.ServerResponse, event: string, data: unknown, id?: number): void {
  if (typeof id === "number") {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function closeSse(res: http.ServerResponse, keepAliveId: NodeJS.Timeout | null, unsubscribe: (() => void) | null): void {
  if (keepAliveId) {
    clearInterval(keepAliveId);
  }
  unsubscribe?.();
  if (!res.writableEnded) {
    res.end();
  }
}

function streamJobState(req: http.IncomingMessage, res: http.ServerResponse, jobId: string, requesterId: string): void {
  const current = getAssistJob(jobId, requesterId);
  if (!current) {
    json(res, { error: "Job not found" }, 404);
    return;
  }

  openSse(res);
  let closed = false;
  let keepAliveId: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const send = (eventName: string, event: Pick<AssistJobEvent, "eventId"> | null, job: AssistJobSnapshot, checkpoint?: CateoInteractionCheckpoint) => {
    if (closed || res.writableEnded) {
      return;
    }
    writeSse(res, eventName, streamEnvelope(job, checkpoint), event?.eventId);
    if (eventName === "complete" || eventName === "failed") {
      closed = true;
      closeSse(res, keepAliveId, unsubscribe);
    }
  };

  const replayCheckpoints = (job: AssistJobSnapshot) => {
    for (const checkpoint of job.checkpoints) {
      if (checkpoint.stage === "accepted" || checkpoint.stage === "completed" || checkpoint.stage === "failed") {
        continue;
      }
      writeSse(res, "checkpoint", streamEnvelope(job, checkpoint));
    }
  };

  send("ready", null, current);
  replayCheckpoints(current);
  if (current.status === "completed") {
    writeSse(res, "complete", streamEnvelope(current));
    closeSse(res, keepAliveId, unsubscribe);
    return;
  }
  if (current.status === "failed") {
    writeSse(res, "failed", streamEnvelope(current, current.checkpoints.at(-1)));
    closeSse(res, keepAliveId, unsubscribe);
    return;
  }

  unsubscribe = subscribeAssistJob(jobId, requesterId, (event) => {
    if (event.type === "snapshot") {
      send("job", event, event.job);
      return;
    }
    if (event.type === "checkpoint") {
      send("checkpoint", event, event.job, event.checkpoint);
      return;
    }
    if (event.type === "completed") {
      send("complete", event, event.job);
      return;
    }
    send("failed", event, event.job, event.checkpoint);
  });

  if (!unsubscribe) {
    closed = true;
    if (!res.writableEnded) {
      closeSse(res, keepAliveId, unsubscribe);
    }
    return;
  }

  keepAliveId = setInterval(() => {
    if (closed || res.writableEnded) {
      closeSse(res, keepAliveId, unsubscribe);
      return;
    }
    res.write(`: keepalive ${Date.now()}\n\n`);
  }, SSE_KEEPALIVE_MS);

  req.on("close", () => {
    closed = true;
    closeSse(res, keepAliveId, unsubscribe);
  });
}

function measureAssistPromptChars(input: CateoAssistInput): number {
  const textParts = [
    input.title,
    input.query,
    input.errorCode,
    input.issueType,
    input.businessType,
    input.symptomDescription,
    ...(input.observedConditions ?? []),
    input.asset?.assetId,
    input.asset?.assetType,
    input.asset?.model,
    input.machine?.manufacturer,
    input.machine?.model,
    input.machine?.serialNumber,
    input.machine?.environment,
    input.workOrder?.workOrderId,
    input.workOrder?.title,
    ...(input.attachments ?? []).flatMap((attachment) => [attachment.name, attachment.note]),
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return textParts.join("\n").length;
}

export async function startCateoSiteBridge(
  settings: CateoSiteBridgeSettings = resolveCateoSiteBridgeSettings(),
): Promise<http.Server> {
  const internalServiceToken = getInternalServiceToken();
  const internalRequestVerifier = createInternalRequestVerifier(internalServiceToken);

  const server = http.createServer((req, res) => {
    setHeaders(res);
    const requestId = crypto.randomUUID();
    const url = new URL(req.url ?? "/", settings.baseUrl);
    const action = `${req.method ?? "GET"} ${url.pathname}`;

    res.on("finish", () => {
      appendAuditEvent({
        actor: "server",
        category: "site_bridge",
        action,
        outcome: String(res.statusCode),
        message: `${action} -> ${res.statusCode}`,
        requestId,
        severity: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        metadata: { remoteAddress: req.socket.remoteAddress },
      });
    });

    void (async () => {
      try {
        if (url.pathname === "/healthz") {
          const config = loadConfig();
          json(res, {
            ok: true,
            configured: !!config,
            internalApiPrefix: INTERNAL_CATEO_PREFIX,
            jobsPrefix: JOBS_PREFIX,
            localOnlyListener: settings.baseUrl,
            pilotEnabled: config ? getPilotConfig(config).enabled : false,
          });
          return;
        }

        if (!url.pathname.startsWith(INTERNAL_CATEO_PREFIX)) {
          json(res, { error: "Not found" }, 404);
          return;
        }

        const internalVerification = await internalRequestVerifier.verify(req, url.pathname, () => readBody(req));
        if (!internalVerification.ok) {
          json(res, { error: "Unauthorized" }, 403);
          return;
        }

        if (await handleCateoSitePublicApi({ pathname: url.pathname, req, res, config: loadConfig(), requestId, requesterId: getRequesterId(req) })) {
          return;
        }

        if (url.pathname === JOBS_PREFIX) {
          const requesterId = getRequesterId(req);
          if (!requesterId) {
            json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400);
            return;
          }

          const config = loadConfig();
          const requestedProfileId = getProfileId(req) ?? undefined;
          const profile = config && requestedProfileId
            ? getPilotProfile(config, requestedProfileId, requesterId, requestId) ?? undefined
            : undefined;

          if (req.method === "GET") {
            const backlog = listAssistBacklog(requesterId);
            json(res, { ok: true, message: summarizeBacklog(backlog), backlog: toPublicBacklog(backlog), profile });
            return;
          }

          if (req.method !== "POST") {
            json(res, { error: "GET or POST only" }, 405);
            return;
          }

          if (!config) {
            json(res, { error: "Cateo runtime is not configured" }, 503);
            return;
          }

          let body: CateoAssistInput;
          try {
            body = parseJsonBody<CateoAssistInput>(await readBody(req));
          } catch (error) {
            json(res, { error: error instanceof Error ? error.message : "Invalid JSON" }, 400);
            return;
          }

          const promptChars = measureAssistPromptChars(body);
          const pilotConfig = getPilotConfig(config);
          const sessionProfile = profile ?? upsertPilotProfile(config, { profileId: requestedProfileId, requesterId }, requestId);
          if (promptChars > pilotConfig.quota.maxPromptChars) {
            json(res, {
              error: `Prompt exceeds the pilot limit of ${pilotConfig.quota.maxPromptChars} characters.`,
              profile: sessionProfile,
            }, 413);
            return;
          }

          try {
            assertSubmissionAllowed(requesterId, req.socket.remoteAddress ?? undefined);
            const reservation = reservePilotQuota(config, sessionProfile.profileId, requesterId, requestId);
            try {
              const immediate = await findMatchingValidatedProcedure(config, body, {
                actor: "site",
                requestId,
                requester: {
                  profileId: reservation.profile.profileId,
                  requesterId,
                  displayName: reservation.profile.displayName,
                  organization: reservation.profile.organization,
                  serviceTier: reservation.profile.serviceTier,
                  requiresEngineerReview: reservation.profile.reviewedOutputs,
                },
              });
              if (immediate) {
                const job = submitCompletedAssistJob(body, immediate, requesterId, requestId, {
                  profile: reservation.profile,
                  quotaReservationId: reservation.reservationId,
                  requiresEngineerReview: reservation.profile.reviewedOutputs,
                  statusDetail: "Validated troubleshooting procedure returned immediately from the internal catalog.",
                });
                settlePilotQuota(config, reservation.profile.profileId, reservation.reservationId, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, "completed", requestId);
                noteSubmission(requesterId, req.socket.remoteAddress ?? undefined);
                const backlog = listAssistBacklog(requesterId);
                json(res, { ok: true, message: summarizeQueueJob(job), job: toPublicJob(job), backlog: toPublicBacklog(backlog), profile: currentProfileSnapshot(reservation.profile.profileId, requesterId) ?? reservation.profile }, 200);
                return;
              }

              const job = submitAssistJob(body, requesterId, requestId, {
                profile: reservation.profile,
                quotaReservationId: reservation.reservationId,
              });
              noteSubmission(requesterId, req.socket.remoteAddress ?? undefined);
              const backlog = listAssistBacklog(requesterId);
              json(res, { ok: true, message: summarizeQueueJob(job), job: toPublicJob(job), backlog: toPublicBacklog(backlog), profile: reservation.profile }, 202);
              return;
            } catch (error) {
              settlePilotQuota(config, reservation.profile.profileId, reservation.reservationId, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, "failed", requestId);
              throw error;
            }
          } catch (error) {
            if (error instanceof CateoPilotQuotaError) {
              json(res, { error: error.message, code: error.code, profile: error.profile ?? sessionProfile }, error.status);
              return;
            }
            throw error;
          }
        }

        if (url.pathname.startsWith(`${JOBS_PREFIX}/`)) {
          const requesterId = getRequesterId(req);
          if (!requesterId) {
            json(res, { error: "Missing or invalid X-Cateo-Client-Id" }, 400);
            return;
          }

          const suffix = url.pathname.slice(`${JOBS_PREFIX}/`.length);
          if (suffix.endsWith(JOB_STREAM_SUFFIX)) {
            if (req.method !== "GET") {
              json(res, { error: "GET only" }, 405);
              return;
            }
            const jobId = decodeURIComponent(suffix.slice(0, -JOB_STREAM_SUFFIX.length));
            streamJobState(req, res, jobId, requesterId);
            return;
          }

          if (req.method !== "GET") {
            json(res, { error: "GET only" }, 405);
            return;
          }

          const jobId = decodeURIComponent(suffix);
          const job = getAssistJob(jobId, requesterId);
          if (!job) {
            json(res, { error: "Job not found" }, 404);
            return;
          }

          const backlog = listAssistBacklog(requesterId);
          const profile = currentProfileSnapshot(job.profileId, requesterId);
          json(res, { ok: true, message: summarizeQueueJob(job), job: toPublicJob(job), backlog: toPublicBacklog(backlog), profile });
          return;
        }

        await handleCateoInternalApi(url.pathname, req, res, loadConfig(), requestId);
      } catch (error) {
        appendAuditEvent({
          actor: "server",
          category: "site_bridge",
          action,
          outcome: "error",
          severity: "error",
          message: `${action} threw an unhandled error`,
          requestId,
          metadata: { error: error instanceof Error ? error.message : String(error) },
        });
        if (!res.headersSent) {
          json(res, { error: "Internal server error" }, 500);
          return;
        }
        res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => resolve());
  });

  appendAuditEvent({
    actor: "server",
    category: "runtime",
    action: "site_bridge_start",
    outcome: "success",
    message: `Cateo site bridge listening on ${settings.baseUrl}`,
    metadata: { host: settings.host, port: settings.port },
  });

  server.on("close", () => {
    appendAuditEvent({
      actor: "server",
      category: "runtime",
      action: "site_bridge_stop",
      outcome: "success",
      message: `Cateo site bridge stopped on ${settings.baseUrl}`,
      metadata: { host: settings.host, port: settings.port },
    });
  });

  return server;
}









