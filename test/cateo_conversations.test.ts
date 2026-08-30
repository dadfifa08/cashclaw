import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secureStoreState = vi.hoisted(() => ({ failCaseWrites: false }));

vi.mock("../src/security/secure_store.js", async () => {
  const fsModule = await import("node:fs");
  const pathModule = await import("node:path");
  const ensure = (filePath: string) => fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true });
  return {
    writeProtectedJson: (filePath: string, data: unknown) => {
      if (secureStoreState.failCaseWrites && filePath.includes(`${pathModule.sep}cases${pathModule.sep}`)) {
        throw new Error("Simulated protected case metadata persistence failure");
      }
      ensure(filePath);
      fsModule.writeFileSync(filePath, JSON.stringify(data), "utf8");
    },
    readProtectedJson: (filePath: string, fallback: unknown) => fsModule.existsSync(filePath) ? JSON.parse(fsModule.readFileSync(filePath, "utf8")) : fallback,
    appendProtectedText: (filePath: string, text: string) => { ensure(filePath); fsModule.appendFileSync(filePath, text, "utf8"); },
    readProtectedText: (filePath: string) => fsModule.existsSync(filePath) ? fsModule.readFileSync(filePath, "utf8") : null,
    writeProtectedText: (filePath: string, text: string) => { ensure(filePath); fsModule.writeFileSync(filePath, text, "utf8"); },
    readProtectedSecret: () => undefined,
    writeProtectedSecret: () => undefined,
    resetSecureStoreCache: () => undefined,
  };
});

describe("Cateo conversation authority and transcript context", () => {
  let home = "";

  beforeEach(() => {
    secureStoreState.failCaseWrites = false;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cateo-conversation-test-"));
    process.env.CATEO_HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    secureStoreState.failCaseWrites = false;
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CATEO_HOME;
    vi.resetModules();
  });

  it("prevents cross-requester access and makes duplicate client messages idempotent", async () => {
    const conversations = await import("../src/cateo/conversations.js");
    const input = { symptomDescription: "Pump shows alarm E-441", errorCode: "E-441" };
    const first = conversations.queueConversationTurn({
      conversationId: "conversation-a",
      viewer: { requesterId: "requester-a" },
      requesterId: "requester-a",
      jobId: "job-1",
      input,
      promptText: input.symptomDescription,
      clientMessageId: "client-message-1",
    });
    const repeated = conversations.queueConversationTurn({
      conversationId: "conversation-a",
      viewer: { requesterId: "requester-a" },
      requesterId: "requester-a",
      jobId: "job-1-retry",
      input,
      promptText: input.symptomDescription,
      clientMessageId: "client-message-1",
    });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.conversation.messages).toHaveLength(2);
    expect(repeated.assistantMessage.jobId).toBe("job-1");
    expect(() => conversations.queueConversationTurn({
      conversationId: "conversation-a",
      viewer: { requesterId: "requester-b" },
      requesterId: "requester-b",
      jobId: "job-foreign",
      input,
      promptText: "Foreign overwrite attempt",
      clientMessageId: "foreign-message",
    })).toThrow(/not found/i);
    expect(conversations.loadConversationRecord(first.conversation.conversationId)?.requesterId).toBe("requester-a");
    const customerSummary = conversations.toCustomerConversationSummary(conversations.listConversationSummaries({ requesterId: "requester-a" })[0]);
    expect(JSON.stringify(customerSummary)).not.toMatch(/requesterId|ownerUserId|profileId|shareId|titleSource|artifact/i);
  });

  it("reconstructs a bounded, role-preserving transcript from server persistence", async () => {
    const conversations = await import("../src/cateo/conversations.js");
    const queued = conversations.queueConversationTurn({
      conversationId: "conversation-context",
      viewer: { requesterId: "requester-a" },
      requesterId: "requester-a",
      jobId: "job-1",
      input: { symptomDescription: "The analyzer shows E-441." },
      promptText: "The analyzer shows E-441.",
      clientMessageId: "message-1",
    });
    const record = queued.conversation;
    record.messages[1].status = "completed";
    record.messages[1].text = "What temperature do you observe?";
    record.messages[1].kind = "clarification";
    conversations.saveConversationRecord(record);
    conversations.queueConversationTurn({
      conversationId: "conversation-context",
      viewer: { requesterId: "requester-a" },
      requesterId: "requester-a",
      jobId: "job-2",
      input: { symptomDescription: "After that I measured 82 C." },
      promptText: "After that I measured 82 C.",
      clientMessageId: "message-2",
    });
    const reloaded = conversations.loadConversationRecord("conversation-context");
    expect(reloaded).not.toBeNull();
    const context = conversations.buildBoundedConversationContext(reloaded!, { maxTurns: 3, maxCharacters: 1_000 });
    expect(context.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    expect(context.turns.map((turn) => turn.kind)).toEqual(["observation", "clarification", "observation"]);
    expect(context.turns.some((turn) => turn.content.includes("82 C"))).toBe(true);
    const customer = conversations.toCustomerConversation(reloaded!);
    expect(customer.conversationId).toBe("conversation-context");
    expect(customer.messages).toHaveLength(4);
    expect(JSON.stringify(customer)).not.toMatch(/job-2|caseId|artifactId|checkpoint|confidence/i);
  });

  it("does not mark a customer response complete when internal case metadata fails to persist", async () => {
    const conversations = await import("../src/cateo/conversations.js");
    const queued = conversations.queueConversationTurn({
      conversationId: "conversation-metadata-failure",
      viewer: { requesterId: "requester-a" },
      requesterId: "requester-a",
      jobId: "job-metadata-failure",
      input: { symptomDescription: "The analyzer stopped during startup." },
      promptText: "The analyzer stopped during startup.",
      clientMessageId: "message-metadata-failure",
    });
    const caseDir = path.join(home, "cateo", "cases");
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(path.join(caseDir, "case-metadata-failure.json"), JSON.stringify({
      caseId: "case-metadata-failure",
      runId: "run-metadata-failure",
      createdAt: "2026-08-29T10:00:00.000Z",
      updatedAt: "2026-08-29T10:00:00.000Z",
      input: { symptomDescription: "The analyzer stopped during startup." },
      context: { title: "Startup stop", taskClass: "troubleshooting" },
      artifacts: [],
      trace: {},
    }), "utf8");

    const result = {
      caseId: "case-metadata-failure",
      artifacts: [],
      checkpoints: [],
      context: {},
      interaction: {
        releaseStatus: "clarification-required",
        requiresEngineerReview: true,
        message: "Which startup phase stopped?",
        clarifyingQuestion: "Which startup phase stopped?",
      },
    } as never;
    secureStoreState.failCaseWrites = true;
    expect(() => conversations.completeConversationTurn({
      conversationId: queued.conversation.conversationId,
      assistantMessageId: queued.assistantMessage.messageId,
      result,
    })).toThrow(/metadata persistence failure/i);

    const reloaded = conversations.loadConversationRecord(queued.conversation.conversationId);
    expect(reloaded?.messages).toHaveLength(2);
    expect(reloaded?.messages[1]?.status).toBe("queued");
    expect(reloaded?.messages[1]?.text).toBe("");

    secureStoreState.failCaseWrites = false;
    conversations.completeConversationTurn({
      conversationId: queued.conversation.conversationId,
      assistantMessageId: queued.assistantMessage.messageId,
      result,
    });
    const retried = conversations.loadConversationRecord(queued.conversation.conversationId);
    expect(retried?.messages).toHaveLength(2);
    expect(retried?.messages[1]?.status).toBe("completed");
    expect(retried?.caseIds).toEqual(["case-metadata-failure"]);
  });

  it("removes internal workflow language and blocks structured backend text from customer messages", async () => {
    const conversations = await import("../src/cateo/conversations.js");

    const natural = conversations.toCustomerSafeText("I need more information before I can build the controlled artifact package.");
    expect(natural).toBe("I need more information before I can provide the next safe troubleshooting step.");
    expect(natural).not.toMatch(/artifact/i);

    const blocked = conversations.toCustomerSafeText('{"artifactId":"artifact-secret","retrievalScore":0.99}');
    expect(blocked).toMatch(/enough verified information/i);
    expect(blocked).not.toMatch(/artifact|retrieval|json|secret/i);
  });
});
