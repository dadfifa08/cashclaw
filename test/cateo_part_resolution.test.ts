import { afterEach, describe, expect, it, vi } from "vitest";
import type { CashClawConfig } from "../src/config.js";
import { resolveCateoPart } from "../src/cateo/part_resolution.js";
import { findMatchingValidatedProcedure } from "../src/cateo/service.js";

const mocks = vi.hoisted(() => ({
  enrichMedia: vi.fn(async (_config: CashClawConfig, assistInput: typeof input) => ({ input: assistInput, mediaInsights: [] })),
}));

vi.mock("../src/security/audit.js", () => ({
  appendAuditEvent: vi.fn(),
}));

vi.mock("../src/cateo/openai_media.js", () => ({
  enrichAssistInputWithOpenAIMedia: mocks.enrichMedia,
}));

const config = {
  agentId: "part-resolution-test",
  llm: { provider: "openai", model: "gpt-5.4-mini", apiKey: "test-key" },
} as CashClawConfig;

const input = {
  symptomDescription: "The machine stopped and the component label is unreadable.",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.enrichMedia.mockClear();
});

describe("Cateo OpenAI part research", () => {
  it("keeps the validated-procedure preflight local so a customer turn does not spend a duplicate model request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await findMatchingValidatedProcedure(config, input);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.enrichMedia).not.toHaveBeenCalled();
  });

  it("uses the bounded transcript and does not source-backfill a result that still requires clarification", async () => {
    const providerResult = {
      partNumber: "UNCONFIRMED-3500",
      partDescription: null,
      manufacturer: null,
      confidencePct: 35,
      needsClarification: true,
      clarifyingQuestion: "What subassembly name is shown?",
      evidence: [],
      aliases: [],
      searchQueries: [],
      failureModes: [],
      preventiveMaintenanceHints: [],
      hazardSignals: [],
      expectedValues: [],
      groundedFindings: [],
      referenceDocuments: [],
      verifiedSources: [],
    };
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ output_text: JSON.stringify(providerResult) }),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveCateoPart(config, {
      symptomDescription: "No subassembly or part number is visible.",
      machine: { model: "Alinity i" },
      conversationContext: {
        schemaVersion: "cateo-transcript-v1",
        conversationId: "conversation-1",
        maxTurns: 16,
        maxCharacters: 12_000,
        truncated: false,
        turns: [
          { messageId: "message-1", role: "user", kind: "request", content: "My Alinity i shows error 3500 during startup.", occurredAt: 1 },
          { messageId: "message-2", role: "assistant", kind: "clarification", content: "What subassembly or part number is visible?", occurredAt: 2 },
        ],
      },
    });

    expect(result.needsClarification).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = String(init.body);
    expect(body).toContain("My Alinity i shows error 3500 during startup.");
    expect(body).toContain("conversationTranscript");
  });

  it("uses the current web search tool without reading a provider error body", async () => {
    const text = vi.fn(() => Promise.resolve("sensitive provider detail"));
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: false,
      status: 503,
      text,
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveCateoPart(config, input);

    expect(result.needsClarification).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as { tools: Array<{ type: string }>; store: boolean };
    expect(payload.tools).toEqual([{ type: "web_search" }]);
    expect(payload.store).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(text).not.toHaveBeenCalled();
  });

  it("aborts a stalled provider request and returns the safe heuristic result", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CATEO_OPENAI_TIMEOUT_MS", "1000");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = resolveCateoPart(config, input);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.needsClarification).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
