import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createLLMProvider: vi.fn((config: unknown) => ({ config })),
}));

vi.mock("../src/llm/index.js", () => ({ createLLMProvider: mocks.createLLMProvider }));

describe("createModelRuntime", () => {
  it("keeps distinct planner, challenger, structure, and study roles for hosted pilot providers", async () => {
    const { createModelRuntime } = await import("../src/llm/runtime.js");

    const runtime = createModelRuntime({
      agentId: "pilot-agent",
      llm: {
        provider: "openai",
        model: "gpt-4.1-mini",
        apiKey: "sk-test",
      },
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
      pilot: {
        enabled: true,
        allowAnonymousProfiles: true,
        requireVerifiedEmail: false,
        sessionTtlDays: 365,
        hostedRoleModels: {
          lead: "gpt-4.1-mini",
          challenger: "gpt-4.1-nano",
          structure: "gpt-4.1-mini",
          study: "gpt-4.1-nano",
        },
        quota: {
          enabled: true,
          dailyRequestLimit: 25,
          dailyInputTokenLimit: 200000,
          dailyOutputTokenLimit: 200000,
          dailyTotalTokenLimit: 350000,
          reservationTokensPerJob: 16000,
          maxPendingJobsPerProfile: 4,
          maxPromptChars: 12000,
        },
      },
    });

    expect(runtime.meta.operator.model).toBe("gpt-4.1-mini");
    expect(runtime.meta.lead.model).toBe("gpt-4.1-mini");
    expect(runtime.meta.challenger?.model).toBe("gpt-4.1-nano");
    expect(runtime.meta.structure?.model).toBe("gpt-4.1-mini");
    expect(runtime.meta.study.model).toBe("gpt-4.1-nano");

    expect(mocks.createLLMProvider).toHaveBeenCalledTimes(5);
    expect(mocks.createLLMProvider).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: "openai", model: "gpt-4.1-mini", apiKey: "sk-test" }));
    expect(mocks.createLLMProvider).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: "openai", model: "gpt-4.1-mini", apiKey: "sk-test" }));
    expect(mocks.createLLMProvider).toHaveBeenNthCalledWith(3, expect.objectContaining({ provider: "openai", model: "gpt-4.1-nano", apiKey: "sk-test" }));
    expect(mocks.createLLMProvider).toHaveBeenNthCalledWith(4, expect.objectContaining({ provider: "openai", model: "gpt-4.1-mini", apiKey: "sk-test" }));
    expect(mocks.createLLMProvider).toHaveBeenNthCalledWith(5, expect.objectContaining({ provider: "openai", model: "gpt-4.1-nano", apiKey: "sk-test" }));
  });
});
