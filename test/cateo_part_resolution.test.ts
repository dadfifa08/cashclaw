import { afterEach, describe, expect, it, vi } from "vitest";
import type { CashClawConfig } from "../src/config.js";
import { resolveCateoPart } from "../src/cateo/part_resolution.js";

vi.mock("../src/security/audit.js", () => ({
  appendAuditEvent: vi.fn(),
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
});

describe("Cateo OpenAI part research", () => {
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
