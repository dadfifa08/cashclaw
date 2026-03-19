import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aZ8AAAAASUVORK5CYII=";

const mocks = vi.hoisted(() => {
  const createHeartbeat = vi.fn(() => ({
    state: {
      running: true,
      activeTasks: new Map<string, unknown>(),
      lastPoll: 0,
      totalPolls: 0,
      startedAt: Date.now(),
      events: [],
      wsConnected: false,
      lastStudyTime: 0,
      totalStudySessions: 0,
    },
    start: vi.fn(),
    stop: vi.fn(),
    syncNow: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
  }));

  const createLLMProvider = vi.fn((config: { model: string }) => ({
    chat: vi.fn(async (messages: Array<{ content: unknown }>) => {
      const system = String(messages[0]?.content ?? "");
      let text = JSON.stringify({ ok: true });
      if (system.includes("Cateo planning")) {
        text = JSON.stringify({
          taskClass: "troubleshooting",
          objective: "Diagnose the reported failure state and produce controlled artifacts.",
          evidencePlan: ["Verify the alarm state.", "Review maintenance history.", "Measure the suspect assembly."],
          assumptions: ["The reported asset tag is correct."],
          risks: ["Do not release the asset without objective verification."],
          decisionBasis: ["Symptom, history, and geometry must align."],
          artifactPriorities: ["inspection-checklist", "service-report", "diagnostic-reasoning-log"],
          maintenanceConsiderations: ["Tie deliverables to the work order."],
          partsConsiderations: ["Bearing kit is a candidate part."],
        });
      } else if (system.includes("artifactDrafts")) {
        text = JSON.stringify({
          packageSummary: "Structured troubleshooting package ready for review.",
          artifactPlans: [
            {
              artifactType: "inspection-checklist",
              title: "Pump inspection checklist",
              sectionOrder: ["scope", "prep", "checks", "completion"],
              qualityGates: ["Schema valid", "Traceable"],
              requiredEvidence: ["Alarm confirmation", "Thermal evidence"],
            },
            {
              artifactType: "troubleshooting-procedure",
              title: "Pump troubleshooting procedure",
              sectionOrder: ["objective", "evidence", "steps", "acceptance"],
              qualityGates: ["Schema valid", "Traceable"],
              requiredEvidence: ["Alarm confirmation", "Runout measurement"],
            },
            {
              artifactType: "service-report",
              title: "Pump service report",
              sectionOrder: ["summary", "findings", "actions", "risks"],
              qualityGates: ["Schema valid"],
              requiredEvidence: ["Maintenance history"],
            },
            {
              artifactType: "diagnostic-reasoning-log",
              title: "Pump diagnostic reasoning log",
              sectionOrder: ["problem", "hypotheses", "evidence"],
              qualityGates: ["Explicit assumptions"],
              requiredEvidence: ["All evidence gaps"],
            },
          ],
          artifactDrafts: [
            {
              artifactType: "inspection-checklist",
              title: "Pump inspection checklist",
              content: {
                title: "Pump inspection checklist",
                scope: "Controlled inspection package for the pump overtemperature alarm.",
                prepSteps: ["Review thermal evidence and work order context."],
                safetyNotes: ["Lock out the pump before intrusive inspection."],
                checklist: [
                  {
                    id: "ic-1",
                    check: "Verify housing temperature against the approved range.",
                    method: "Measurement or functional verification",
                    passCriteria: "Measured result is within the allowed tolerance or specification.",
                    evidenceRequired: "Calibrated measurement, screenshot, or instrument capture",
                    severityIfFailed: "high",
                  },
                ],
                completionCriteria: ["All required checks have objective evidence attached or referenced."],
              },
            },
            {
              artifactType: "troubleshooting-procedure",
              title: "Pump troubleshooting procedure",
              content: {
                title: "Pump troubleshooting procedure",
                objective: "Control the pump overtemperature fault through verified inspection and diagnosis.",
                failureCode: "E-441",
                symptoms: ["Pump temperature alarm is triggering during normal load."],
                assumptions: ["The reported asset tag is correct."],
                evidenceSummary: ["Alarm history reviewed.", "Maintenance history reviewed.", "Runout measurement required."],
                safetyPrecautions: ["Lock out the pump before intrusive inspection."],
                requiredParts: ["BRG-100: Bearing kit"],
                requiredTools: ["Calibrated multimeter", "Dial indicator"],
                steps: [
                  {
                    id: "ts-1",
                    action: "Verify the alarm state.",
                    rationale: "Confirms the active fault condition before part replacement.",
                    expectedResult: "Alarm behavior is confirmed under controlled conditions.",
                  },
                ],
                acceptanceCriteria: ["Fault is cleared with objective evidence."],
                followUpActions: ["Verify lubrication condition.", "Measure shaft runout."],
              },
            },
            {
              artifactType: "service-report",
              title: "Pump service report",
              content: {
                title: "Pump service report",
                summary: "Controlled troubleshooting package prepared for the pump overtemperature alarm.",
                findings: ["Bearing wear remains the primary root-cause candidate."],
                actionsPerformed: ["Reviewed history.", "Prepared diagnostic steps."],
                unresolvedRisks: ["Lubrication quality still needs verification."],
                recommendations: ["Verify lubrication condition.", "Measure shaft runout."],
                signoffRequirement: "Quality review required before release.",
              },
            },
            {
              artifactType: "diagnostic-reasoning-log",
              title: "Pump diagnostic reasoning log",
              content: {
                title: "Pump diagnostic reasoning log",
                problemStatement: "Pump temperature alarm is triggering during normal load.",
                hypotheses: [
                  {
                    name: "Bearing wear is causing the temperature alarm.",
                    status: "candidate",
                    evidenceFor: ["Alarm recurrence aligns with bearing degradation."],
                    evidenceAgainst: ["Lubrication condition not yet verified."],
                  },
                ],
                assumptions: ["The reported asset tag is correct."],
                evidenceRequests: ["Verify lubrication condition.", "Measure shaft runout."],
                rootCauseStatement: "Bearing wear remains the primary root-cause candidate.",
                confidence: "medium",
              },
            },
          ],
        });
      } else if (system.includes("reviewDecision")) {
        text = JSON.stringify({
          alternateHypotheses: ["Bearing wear is causing the temperature alarm."],
          blindSpots: ["Lubrication quality has not been verified."],
          missingAssumptions: ["Process load at the time of the event is not confirmed."],
          evidenceGaps: ["Need a dimensional check on shaft runout."],
          recommendedAdjustments: ["Add a verification step for lubrication condition."],
          reviewDecision: {
            overallStatus: "pass",
            technicalAccuracy: "pass",
            completeness: "pass",
            compliance: "pass",
            findings: ["Traceability package complete."],
            approvedArtifactTypes: ["inspection-checklist", "service-report", "diagnostic-reasoning-log"],
            approvalState: "reviewed",
            confidence: "high",
            summary: "Reviewer validated the package.",
            requiredFollowUp: ["Obtain authorized sign-off before release."],
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

  return { createHeartbeat, createLLMProvider };
});

vi.mock("../src/heartbeat.js", () => ({ createHeartbeat: mocks.createHeartbeat }));
vi.mock("../src/llm/index.js", () => ({ createLLMProvider: mocks.createLLMProvider }));
vi.mock("../src/tools/registry.js", () => ({ executeTool: vi.fn(async () => ({ success: true, data: "ok" })) }));
vi.mock("../src/moltlaunch/cli.js", () => ({ walletShow: vi.fn(async () => ({ address: "0xwallet" })), getAgentByWallet: vi.fn(async () => null), getInbox: vi.fn(async () => []), getTask: vi.fn(async () => null), registerAgent: vi.fn(), walletImport: vi.fn() }));
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

function randomPort(): number { return 44000 + Math.floor(Math.random() * 4000); }
async function closeServer(server: http.Server | null): Promise<void> { if (!server) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

async function bootRuntime(): Promise<{ server: http.Server; baseUrl: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cateo-internal-"));
  const port = randomPort();
  process.env.CATEO_HOME = home;
  process.env.CATEO_PORT = String(port);
  process.env.CATEO_INTERNAL_TOKEN = "cateo-test-token";
  vi.resetModules();
  const { saveConfig } = await import("../src/config.js");
  saveConfig({
    agentId: "agent-1",
    llm: { provider: "ollama", model: "operator-local", baseUrl: "http://localhost:11434/v1" },
    polling: { intervalMs: 30000, urgentIntervalMs: 10000 },
    pricing: { strategy: "fixed", baseRateEth: "0.005", maxRateEth: "0.05" },
    specialties: ["inspection", "troubleshooting"],
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
  const { startAgent } = await import("../src/agent.js");
  const server = await startAgent();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("Cateo internal API", () => {
  let server: http.Server | null = null;
  let baseUrl = "";

  beforeEach(() => { mocks.createLLMProvider.mockClear(); });
  afterEach(async () => {
    await closeServer(server);
    server = null;
    baseUrl = "";
    if (process.env.CATEO_HOME && fs.existsSync(process.env.CATEO_HOME)) fs.rmSync(process.env.CATEO_HOME, { recursive: true, force: true });
    delete process.env.CATEO_HOME;
    delete process.env.CATEO_PORT;
    delete process.env.CATEO_INTERNAL_TOKEN;
    vi.resetModules();
  });

  it("requires a bearer token for the local-only Cateo API", async () => {
    ({ server, baseUrl } = await bootRuntime());
    const denied = await fetch(`${baseUrl}/internal/cateo/health`);
    expect(denied.status).toBe(403);
    const allowed = await fetch(`${baseUrl}/internal/cateo/health`, { headers: { Authorization: "Bearer cateo-test-token" } });
    expect(allowed.status).toBe(200);
  });

  it("generates, revises, signs off, and indexes artifact-first responses", async () => {
    ({ server, baseUrl } = await bootRuntime());
    const assist = await fetch(`${baseUrl}/internal/cateo/assist`, {
      method: "POST",
      headers: { Authorization: "Bearer cateo-test-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Pump overtemperature",
        errorCode: "E-441",
        symptomDescription: "Pump temperature alarm is triggering during normal load.",
        asset: { assetId: "P-100", model: "Pump-X" },
        workOrder: { workOrderId: "WO-88", priority: "high" },
        observedConditions: ["Housing is warm", "Alarm clears after cooldown"],
        serviceHistory: [{ occurredAt: "2026-03-01T08:00:00.000Z", summary: "Replaced seal set", failureCode: "E-441" }],
        partsCatalog: [{ sku: "BRG-100", description: "Bearing kit", compatibleModels: ["Pump-X"], quantitySuggested: 1 }],
        attachments: [{ kind: "image", name: "pump-evidence.png", mimeType: "image/png", contentBase64: ONE_BY_ONE_PNG_BASE64, annotations: { calibration: { referenceName: "scale", pixels: 1, actualLength: 1, unit: "mm" }, dimensions: [{ name: "bearing-seat", expected: 1, unit: "mm", observedPixels: 1, toleranceAbs: 0.1 }] } }],
      }),
    });
    expect(assist.status).toBe(200);
    const assistPayload = await assist.json() as {
      summary: string;
      interaction: { message: string; artifactCount: number; confidence: string };
      artifacts: Array<{ artifactId: string; revisions: Array<{ approvalState: string }> }>;
      context: { attachments: Array<{ width?: number; height?: number; kind: string }>; digitalTwin?: { status?: string } };
    };
    expect(assistPayload.summary).toBe(assistPayload.interaction.message);
    expect(assistPayload.interaction.message).toContain("Bearing wear");
    expect(assistPayload.interaction.artifactCount).toBeGreaterThan(1);
    expect(assistPayload.artifacts[0]?.revisions[0]?.approvalState).toBe("reviewed");
    expect(assistPayload.context.attachments[0]?.kind).toBe("image");
    expect(assistPayload.context.attachments[0]?.width).toBe(1);
    expect(assistPayload.context.attachments[0]?.height).toBe(1);
    expect(assistPayload.context.digitalTwin?.status).toBe("pass");

    const artifactId = assistPayload.artifacts[0]?.artifactId;
    const revise = await fetch(`${baseUrl}/internal/cateo/artifacts/revise`, {
      method: "POST",
      headers: { Authorization: "Bearer cateo-test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId, editor: "qa-reviewer", note: "Added clarification", contentPatch: { followUpActions: ["Route to QA", "Confirm lubrication state"] } }),
    });
    expect(revise.status).toBe(200);
    const revisePayload = await revise.json() as { artifact: { revisions: Array<unknown> } };
    expect(revisePayload.artifact.revisions.length).toBe(2);

    const signoff = await fetch(`${baseUrl}/internal/cateo/artifacts/signoff`, {
      method: "POST",
      headers: { Authorization: "Bearer cateo-test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId, actor: "quality.lead", role: "Quality Lead", meaning: "Reviewed for controlled release", state: "reviewed" }),
    });
    expect(signoff.status).toBe(200);
    const signoffPayload = await signoff.json() as { artifact: { revisions: Array<{ approvalState: string }> } };
    expect(signoffPayload.artifact.revisions.at(-1)?.approvalState).toBe("reviewed");

    const { getConfigDir } = await import("../src/config.js");
    const configDir = getConfigDir();
    const artifactCatalogPath = path.join(configDir, "cateo", "db", "artifacts.json");
    const caseCatalogPath = path.join(configDir, "cateo", "db", "cases.json");
    const vectorIndexPath = path.join(configDir, "cateo", "index", "vector_index.json");

    expect(fs.existsSync(artifactCatalogPath)).toBe(true);
    expect(fs.existsSync(caseCatalogPath)).toBe(true);
    expect(fs.existsSync(vectorIndexPath)).toBe(true);

    const artifactCatalog = JSON.parse(fs.readFileSync(artifactCatalogPath, "utf-8")) as { rows: Array<{ artifactId: string }> };
    const caseCatalog = JSON.parse(fs.readFileSync(caseCatalogPath, "utf-8")) as { rows: Array<{ caseId: string; interactionSummary?: string }> };
    const vectorIndex = JSON.parse(fs.readFileSync(vectorIndexPath, "utf-8")) as { entries: Array<{ id: string }> };

    expect(artifactCatalog.rows.some((row) => row.artifactId === artifactId)).toBe(true);
    expect(caseCatalog.rows[0]?.interactionSummary).toContain("Bearing wear");
    expect(vectorIndex.entries.length).toBeGreaterThan(1);
  });
});

