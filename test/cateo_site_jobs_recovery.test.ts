import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/security/secure_store.js", async () => {
  const fsModule = await import("node:fs");
  const pathModule = await import("node:path");
  const ensure = (filePath: string) => fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true });
  return {
    writeProtectedJson: (filePath: string, data: unknown) => { ensure(filePath); fsModule.writeFileSync(filePath, JSON.stringify(data), "utf8"); },
    readProtectedJson: (filePath: string, fallback: unknown) => fsModule.existsSync(filePath) ? JSON.parse(fsModule.readFileSync(filePath, "utf8")) : fallback,
    appendProtectedText: (filePath: string, text: string) => { ensure(filePath); fsModule.appendFileSync(filePath, text, "utf8"); },
    readProtectedText: (filePath: string) => fsModule.existsSync(filePath) ? fsModule.readFileSync(filePath, "utf8") : null,
    writeProtectedText: (filePath: string, text: string) => { ensure(filePath); fsModule.writeFileSync(filePath, text, "utf8"); },
    readProtectedSecret: () => undefined,
    writeProtectedSecret: () => undefined,
    deleteProtectedSecret: () => undefined,
    resetSecureStoreCache: () => undefined,
  };
});

vi.mock("../src/cateo/service.js", () => ({
  generateCateoArtifacts: vi.fn(),
  getCateoUsageFromError: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
}));

describe("durable site job recovery", () => {
  let home = "";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cateo-job-recovery-"));
    process.env.CATEO_HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CATEO_HOME;
    vi.resetModules();
  });

  it("turns persisted queued work into a safe terminal failure after restart", async () => {
    const storePath = path.join(home, "cateo", "db", "site_jobs.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      version: "cateo-site-jobs-v1",
      updatedAt: "2026-08-29T00:00:00.000Z",
      records: [{
        jobId: "job-before-restart",
        requesterId: "requester-a",
        acceptedSequence: 1,
        title: "Interrupted request",
        promptPreview: "Pump alarm",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
        input: { symptomDescription: "Pump alarm" },
        checkpoints: [],
        idempotencyKey: "message-1",
      }],
      queue: ["job-before-restart"],
      completedDurationsMs: [],
      nextAcceptedSequence: 2,
    }), "utf8");

    const jobs = await import("../src/cateo/site_jobs.js");
    const recovered = jobs.getAssistJob("job-before-restart", "requester-a");
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toMatch(/interrupted/i);
    expect(recovered?.checkpoints.at(-1)?.stage).toBe("failed");
    expect(jobs.getAssistJob("job-before-restart", "requester-b")).toBeNull();
    expect(jobs.getAssistJobByIdempotency("requester-a", "message-1")?.jobId).toBe("job-before-restart");

    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as { records: Array<{ status: string }>; queue: string[] };
    expect(persisted.records[0]?.status).toBe("failed");
    expect(persisted.queue).toEqual([]);
  });
});
