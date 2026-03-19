import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const runtimeDelayMs = { value: 0 };
  const createLLMProvider = vi.fn(() => ({
    chat: vi.fn(async (messages: Array<{ content: unknown }>) => {
      if (runtimeDelayMs.value > 0) {
        await new Promise((resolve) => setTimeout(resolve, runtimeDelayMs.value));
      }

      const system = String(messages[0]?.content ?? "");
      let text = JSON.stringify({ ok: true });
      if (system.includes("Cateo planning")) {
        text = JSON.stringify({
          taskClass: "inspection",
          objective: "Inspect the asset and produce controlled artifacts.",
          evidencePlan: ["Review the attachment evidence."],
          assumptions: ["The supplied asset metadata is correct."],
          risks: ["Do not approve release without objective evidence."],
          decisionBasis: ["Use measured observations and work-order context."],
          artifactPriorities: ["inspection-checklist", "service-report", "diagnostic-reasoning-log"],
          maintenanceConsiderations: ["Tie the result to the work order."],
          partsConsiderations: [],
        });
      } else if (system.includes("artifactDrafts")) {
        text = JSON.stringify({
          packageSummary: "Structured inspection package ready for review.",
          artifactPlans: [
            {
              artifactType: "inspection-checklist",
              title: "Inspection checklist",
              sectionOrder: ["objective", "checkpoints", "acceptance"],
              qualityGates: ["Schema valid"],
              requiredEvidence: ["Attachment evidence"],
            },
            {
              artifactType: "service-report",
              title: "Inspection service report",
              sectionOrder: ["summary", "findings", "actions", "risks"],
              qualityGates: ["Schema valid"],
              requiredEvidence: ["Attachment evidence"],
            },
            {
              artifactType: "diagnostic-reasoning-log",
              title: "Inspection reasoning log",
              sectionOrder: ["problem", "hypotheses", "evidence"],
              qualityGates: ["Explicit assumptions"],
              requiredEvidence: ["All evidence gaps"],
            },
          ],
          artifactDrafts: [
            {
              artifactType: "inspection-checklist",
              title: "Inspection checklist",
              content: {
                title: "Inspection checklist",
                scope: "Controlled inspection package for the reported asset.",
                prepSteps: ["Review the attachment evidence."],
                safetyNotes: ["Follow site safety controls."],
                checklist: [
                  {
                    id: "ic-1",
                    check: "Verify the attachment evidence against the expected state.",
                    method: "Visual review",
                    passCriteria: "Condition matches the approved reference.",
                    evidenceRequired: "Photo evidence",
                    severityIfFailed: "high",
                  },
                ],
                completionCriteria: ["All required checks have evidence attached."],
              },
            },
            {
              artifactType: "service-report",
              title: "Inspection service report",
              content: {
                title: "Inspection service report",
                summary: "Controlled inspection artifact package prepared.",
                findings: ["No competing failure mode identified."],
                actionsPerformed: ["Reviewed attachment evidence."],
                unresolvedRisks: ["Need operator confirmation of the reported condition."],
                recommendations: ["Route to review."],
                signoffRequirement: "Reviewer sign-off required.",
              },
            },
            {
              artifactType: "diagnostic-reasoning-log",
              title: "Inspection reasoning log",
              content: {
                title: "Inspection reasoning log",
                problemStatement: "Customer needs a controlled inspection artifact.",
                hypotheses: [
                  {
                    name: "The reported condition is accurate.",
                    status: "candidate",
                    evidenceFor: ["Attachment evidence was provided."],
                    evidenceAgainst: ["Operator confirmation is still pending."],
                  },
                ],
                assumptions: ["The supplied asset metadata is correct."],
                evidenceRequests: ["Review the attachment evidence."],
                rootCauseStatement: "Further review required.",
                confidence: "medium",
              },
            },
          ],
        });
      } else if (system.includes("reviewDecision")) {
        text = JSON.stringify({
          alternateHypotheses: ["No competing failure mode identified."],
          blindSpots: ["Need operator confirmation of the reported condition."],
          missingAssumptions: [],
          evidenceGaps: [],
          recommendedAdjustments: ["Keep traceability on all observations."],
          reviewDecision: {
            overallStatus: "pass",
            technicalAccuracy: "pass",
            completeness: "pass",
            compliance: "pass",
            findings: ["Inspection package is complete."],
            approvedArtifactTypes: ["inspection-checklist", "service-report", "diagnostic-reasoning-log"],
            approvalState: "reviewed",
            confidence: "medium",
            summary: "Reviewer validated the inspection package.",
            requiredFollowUp: ["Route to review."],
          },
        });
      }
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    }),
  }));

  return { createLLMProvider, runtimeDelayMs };
});

vi.mock("../src/llm/index.js", () => ({ createLLMProvider: mocks.createLLMProvider }));
vi.mock("../src/security/secure_store.js", async () => {
  const fsModule = await import("node:fs");
  const pathModule = await import("node:path");
  function ensureDir(filePath: string): void { fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true }); }
  function secretPath(name: string): string {
    const root = process.env.CATEO_HOME ?? process.cwd();
    return pathModule.join(root, "security", `${name.replace(/[^a-zA-Z0-9._-]/g, "_")}.secret`);
  }
  return {
    resetSecureStoreCache: () => undefined,
    writeProtectedText: (filePath: string, text: string) => { ensureDir(filePath); fsModule.writeFileSync(filePath, text, "utf-8"); },
    readProtectedText: (filePath: string) => fsModule.existsSync(filePath) ? fsModule.readFileSync(filePath, "utf-8") : null,
    writeProtectedJson: (filePath: string, data: unknown) => { ensureDir(filePath); fsModule.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8"); },
    readProtectedJson: (filePath: string, fallback: unknown) => fsModule.existsSync(filePath) ? JSON.parse(fsModule.readFileSync(filePath, "utf-8")) : fallback,
    appendProtectedText: (filePath: string, text: string) => { ensureDir(filePath); fsModule.appendFileSync(filePath, text, "utf-8"); },
    removeProtectedFile: (filePath: string) => { if (fsModule.existsSync(filePath)) fsModule.unlinkSync(filePath); },
    writeProtectedSecret: (name: string, value: string) => { const filePath = secretPath(name); ensureDir(filePath); fsModule.writeFileSync(filePath, value, "utf-8"); },
    readProtectedSecret: (name: string) => { const filePath = secretPath(name); return fsModule.existsSync(filePath) ? fsModule.readFileSync(filePath, "utf-8") : undefined; },
    deleteProtectedSecret: (name: string) => { const filePath = secretPath(name); if (fsModule.existsSync(filePath)) fsModule.unlinkSync(filePath); },
  };
});

function randomPort(): number { return 48000 + Math.floor(Math.random() * 1000); }
async function closeServer(server: http.Server | null): Promise<void> { if (!server) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

function parseSseEvents(raw: string): Array<{ event: string; data: any }> {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "message";
      const dataLine = lines.find((line) => line.startsWith("data: "));
      return {
        event,
        data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null,
      };
    });
}

async function bootBridge(): Promise<{ server: http.Server; baseUrl: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cateo-site-bridge-"));
  const port = randomPort();
  process.env.CATEO_HOME = home;
  process.env.CATEO_SITE_PORT = String(port);
  process.env.CATEO_INTERNAL_TOKEN = "cateo-site-bridge-token";
  vi.resetModules();
  const { saveConfig } = await import("../src/config.js");
  saveConfig({
    agentId: "agent-1",
    llm: { provider: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434/v1" },
    polling: { intervalMs: 30000, urgentIntervalMs: 10000 },
    pricing: { strategy: "fixed", baseRateEth: "0.005", maxRateEth: "0.05" },
    specialties: ["inspection"],
    autoQuote: false,
    autoWork: false,
    maxConcurrentTasks: 1,
    maxLoopTurns: 8,
    declineKeywords: [],
    learningEnabled: false,
    studyIntervalMs: 1800000,
    agentCashEnabled: false,
    security: {
      approvalPolicy: { quotes: true, declines: true, clientMessages: true, submissions: true, bountyClaims: true, agentCash: true },
      persistence: { persistOperatorChat: true, persistKnowledge: true, persistFeedback: true, persistDatasets: true, persistActivityLog: true, auditRetentionDays: 180 },
      agentCashPolicy: { maxUsdPerCall: 0.05, maxUsdPerTask: 0.25, allowedClasses: ["research", "social"] },
    },
    orchestration: {
      enabled: true,
      lead: { model: "qwen3:8b", baseUrl: "http://localhost:11434/v1" },
      challenger: { enabled: true, mode: "adaptive", model: "llama3.3", baseUrl: "http://localhost:11434/v1" },
      structure: { enabled: true, mode: "adaptive", model: "qwen2.5-coder:14b", baseUrl: "http://localhost:11434/v1" },
    },
  });
  const { startCateoSiteBridge } = await import("../src/cateo/site_server.js");
  const server = await startCateoSiteBridge();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("Cateo site bridge", () => {
  let server: http.Server | null = null;
  let baseUrl = "";

  beforeEach(() => {
    mocks.createLLMProvider.mockClear();
    mocks.runtimeDelayMs.value = 0;
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    baseUrl = "";
    if (process.env.CATEO_HOME && fs.existsSync(process.env.CATEO_HOME)) fs.rmSync(process.env.CATEO_HOME, { recursive: true, force: true });
    delete process.env.CATEO_HOME;
    delete process.env.CATEO_SITE_PORT;
    delete process.env.CATEO_INTERNAL_TOKEN;
    vi.resetModules();
  });

  it("serves only the authenticated Cateo internal API surface", async () => {
    ({ server, baseUrl } = await bootBridge());
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);

    const denied = await fetch(`${baseUrl}/internal/cateo/health`);
    expect(denied.status).toBe(403);

    const hidden = await fetch(`${baseUrl}/api/bootstrap`);
    expect(hidden.status).toBe(404);

    const allowed = await fetch(`${baseUrl}/internal/cateo/health`, { headers: { Authorization: "Bearer cateo-site-bridge-token" } });
    expect(allowed.status).toBe(200);
  });

  it("queues and completes async assist jobs through the authenticated bridge", async () => {
    ({ server, baseUrl } = await bootBridge());
    const submit = await fetch(`${baseUrl}/internal/cateo/jobs/assist`, {
      method: "POST",
      headers: {
        Authorization: "Bearer cateo-site-bridge-token",
        "Content-Type": "application/json",
        "X-Cateo-Client-Id": "client-a",
      },
      body: JSON.stringify({
        title: "Inspection request",
        symptomDescription: "Customer needs a controlled inspection artifact.",
        asset: { assetId: "A-100", model: "Rig-X" },
        workOrder: { workOrderId: "WO-100" },
      }),
    });

    expect(submit.status).toBe(202);
    const jobEnvelope = await submit.json() as {
      message: string;
      job: { jobId: string; status: string; backlogPosition: number | null };
      backlog: { pendingCount: number };
    };
    expect(jobEnvelope.job.jobId).toBeTruthy();
    expect(["queued", "running"]).toContain(jobEnvelope.job.status);
    expect(jobEnvelope.backlog.pendingCount).toBeGreaterThanOrEqual(1);
    expect(jobEnvelope.message).toContain("Request received");

    let result: {
      job?: { status: string; result?: { summary?: string; interaction?: { message: string }; artifacts?: Array<{ artifactType: string }> } };
      backlog?: { pendingCount: number };
    } | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const poll = await fetch(`${baseUrl}/internal/cateo/jobs/assist/${jobEnvelope.job.jobId}`, {
        headers: {
          Authorization: "Bearer cateo-site-bridge-token",
          "X-Cateo-Client-Id": "client-a",
        },
      });
      expect(poll.status).toBe(200);
      result = await poll.json() as {
        job?: { status: string; result?: { summary?: string; interaction?: { message: string }; artifacts?: Array<{ artifactType: string }> } };
        backlog?: { pendingCount: number };
      };
      if (result.job?.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(result?.job?.status).toBe("completed");
    expect(result?.job?.result?.summary).toBe(result?.job?.result?.interaction?.message);
    expect(result?.job?.result?.artifacts?.[0]?.artifactType).toBe("inspection-checklist");
    expect(result?.backlog?.pendingCount ?? 0).toBe(0);
  });


  it("streams live checkpoints for a queued assist job until completion", async () => {
    ({ server, baseUrl } = await bootBridge());
    mocks.runtimeDelayMs.value = 10;

    const submit = await fetch(`${baseUrl}/internal/cateo/jobs/assist`, {
      method: "POST",
      headers: {
        Authorization: "Bearer cateo-site-bridge-token",
        "Content-Type": "application/json",
        "X-Cateo-Client-Id": "client-stream",
      },
      body: JSON.stringify({
        title: "Streaming inspection request",
        symptomDescription: "Stream the live checkpoint path for this controlled request.",
      }),
    });
    expect(submit.status).toBe(202);
    const submitPayload = await submit.json() as { job: { jobId: string } };

    const stream = await fetch(`${baseUrl}/internal/cateo/jobs/assist/${submitPayload.job.jobId}/stream`, {
      headers: {
        Authorization: "Bearer cateo-site-bridge-token",
        "X-Cateo-Client-Id": "client-stream",
      },
    });

    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const raw = await stream.text();
    const events = parseSseEvents(raw);
    const eventNames = events.map((entry) => entry.event);

    expect(eventNames).toContain("ready");
    expect(eventNames).toContain("checkpoint");
    expect(eventNames).toContain("complete");

    const finalPayload = events.findLast((entry) => entry.event === "complete")?.data as {
      job?: { status: string; checkpoints?: Array<{ stage: string }>; result?: { message?: string } };
    } | undefined;

    expect(finalPayload?.job?.status).toBe("completed");
    expect(finalPayload?.job?.result?.message).toBeTruthy();
    expect(finalPayload?.job?.checkpoints?.some((checkpoint) => checkpoint.stage === "planning")).toBe(true);
    expect(finalPayload?.job?.checkpoints?.some((checkpoint) => checkpoint.stage === "building")).toBe(true);
    expect(finalPayload?.job?.checkpoints?.some((checkpoint) => checkpoint.stage === "reviewing")).toBe(true);
    expect(finalPayload?.job?.checkpoints?.some((checkpoint) => checkpoint.stage === "completed")).toBe(true);
  });
  it("tracks per-requester backlog in acceptance order with queue positions", async () => {
    ({ server, baseUrl } = await bootBridge());
    mocks.runtimeDelayMs.value = 40;

    async function submitFor(clientId: string, symptomDescription: string) {
      const response = await fetch(`${baseUrl}/internal/cateo/jobs/assist`, {
        method: "POST",
        headers: {
          Authorization: "Bearer cateo-site-bridge-token",
          "Content-Type": "application/json",
          "X-Cateo-Client-Id": clientId,
        },
        body: JSON.stringify({ symptomDescription }),
      });
      expect(response.status).toBe(202);
      return await response.json() as {
        job: { jobId: string; acceptedSequence: number; backlogPosition: number | null };
        backlog: { pendingCount: number };
      };
    }

    const first = await submitFor("client-a", "First inspection request");
    const second = await submitFor("client-a", "Second inspection request");
    const third = await submitFor("client-b", "Separate requester job");

    expect(first.job.acceptedSequence).toBeLessThan(second.job.acceptedSequence);
    expect(first.job.backlogPosition).toBe(1);
    expect(second.job.backlogPosition).toBeGreaterThanOrEqual(2);
    expect(third.job.backlogPosition).toBeGreaterThanOrEqual(2);

    const backlogResponse = await fetch(`${baseUrl}/internal/cateo/jobs/assist`, {
      headers: {
        Authorization: "Bearer cateo-site-bridge-token",
        "X-Cateo-Client-Id": "client-a",
      },
    });
    expect(backlogResponse.status).toBe(200);
    const backlogPayload = await backlogResponse.json() as {
      backlog: {
        pendingCount: number;
        items: Array<{ jobId: string; acceptedSequence: number; backlogPosition: number | null }>;
      };
    };

    expect(backlogPayload.backlog.pendingCount).toBe(2);
    expect(backlogPayload.backlog.items.map((item) => item.jobId)).toEqual([first.job.jobId, second.job.jobId]);
    expect(backlogPayload.backlog.items[0]?.acceptedSequence).toBeLessThan(backlogPayload.backlog.items[1]?.acceptedSequence ?? 0);
    expect(backlogPayload.backlog.items[0]?.backlogPosition).toBe(1);
    expect(backlogPayload.backlog.items[1]?.backlogPosition).toBe(2);

    const otherBacklogResponse = await fetch(`${baseUrl}/internal/cateo/jobs/assist`, {
      headers: {
        Authorization: "Bearer cateo-site-bridge-token",
        "X-Cateo-Client-Id": "client-b",
      },
    });
    expect(otherBacklogResponse.status).toBe(200);
    const otherBacklogPayload = await otherBacklogResponse.json() as {
      backlog: { pendingCount: number; items: Array<{ jobId: string }> };
    };
    expect(otherBacklogPayload.backlog.pendingCount).toBe(1);
    expect(otherBacklogPayload.backlog.items[0]?.jobId).toBe(third.job.jobId);

    const foreignLookup = await fetch(`${baseUrl}/internal/cateo/jobs/assist/${encodeURIComponent(first.job.jobId)}`, {
      headers: {
        Authorization: "Bearer cateo-site-bridge-token",
        "X-Cateo-Client-Id": "client-b",
      },
    });
    expect(foreignLookup.status).toBe(404);
  });
});

