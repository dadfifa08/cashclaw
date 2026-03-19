import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

const mocks = vi.hoisted(() => {
  const heartbeatInstances: Array<{
    state: {
      running: boolean;
      activeTasks: Map<string, unknown>;
      lastPoll: number;
      totalPolls: number;
      startedAt: number;
      events: Array<{ timestamp: number; type: string; message: string; taskId?: string }>;
      wsConnected: boolean;
      lastStudyTime: number;
      totalStudySessions: number;
    };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    syncNow: ReturnType<typeof vi.fn>;
    onEvent: ReturnType<typeof vi.fn>;
    emit: (event: { timestamp: number; type: string; message: string; taskId?: string }) => void;
  }> = [];

  const createHeartbeat = vi.fn(() => {
    const listeners = new Set<(event: { timestamp: number; type: string; message: string; taskId?: string }) => void>();
    const state = {
      running: false,
      activeTasks: new Map<string, unknown>(),
      lastPoll: 0,
      totalPolls: 0,
      startedAt: Date.now(),
      events: [],
      wsConnected: false,
      lastStudyTime: 0,
      totalStudySessions: 0,
    };

    const instance = {
      state,
      start: vi.fn(() => {
        state.running = true;
        state.startedAt = Date.now();
      }),
      stop: vi.fn(() => {
        state.running = false;
      }),
      syncNow: vi.fn(() => {
        state.totalPolls += 1;
        state.lastPoll = Date.now();
      }),
      onEvent: vi.fn((listener: (event: { timestamp: number; type: string; message: string; taskId?: string }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      emit: (event: { timestamp: number; type: string; message: string; taskId?: string }) => {
        state.events.push(event);
        for (const listener of listeners) {
          listener(event);
        }
      },
    };

    heartbeatInstances.push(instance);
    return instance;
  });

  const executeTool = vi.fn(async (name: string, input: Record<string, unknown>) => ({
    success: true,
    data: `approved:${name}:${JSON.stringify(input)}`,
  }));

  const walletShow = vi.fn(async () => ({ address: "0xwallet", balance: "1.0" }));
  const getAgentByWallet = vi.fn(async () => null);
  const getInbox = vi.fn(async () => []);
  const getTask = vi.fn(async () => ({
    id: "task-from-cli",
    agentId: "agent-1",
    clientAddress: "0xclient",
    task: "Task from mocked CLI",
    status: "accepted",
    revisionCount: 0,
    messages: [],
    files: [],
  }));
  const registerAgent = vi.fn();
  const walletImport = vi.fn();

  return {
    heartbeatInstances,
    createHeartbeat,
    executeTool,
    walletShow,
    getAgentByWallet,
    getInbox,
    getTask,
    registerAgent,
    walletImport,
  };
});

vi.mock("../src/heartbeat.js", () => ({
  createHeartbeat: mocks.createHeartbeat,
}));

vi.mock("../src/tools/registry.js", () => ({
  executeTool: mocks.executeTool,
  getToolDefinitions: () => [],
}));

vi.mock("../src/security/secure_store.js", async () => {
  const fsModule = await import("node:fs");
  const pathModule = await import("node:path");

  function ensureDir(filePath: string): void {
    fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true });
  }

  function secretPath(name: string): string {
    const root = process.env.CATEO_HOME ?? process.cwd();
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    return pathModule.join(root, "security", "secrets", `${safe}.secret`);
  }

  return {
    resetSecureStoreCache: () => undefined,
    writeProtectedText: (filePath: string, text: string) => {
      ensureDir(filePath);
      fsModule.writeFileSync(filePath, text, "utf-8");
    },
    readProtectedText: (filePath: string) => {
      if (!fsModule.existsSync(filePath)) return null;
      return fsModule.readFileSync(filePath, "utf-8");
    },
    writeProtectedJson: (filePath: string, data: unknown) => {
      ensureDir(filePath);
      fsModule.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    },
    readProtectedJson: (filePath: string, fallback: unknown) => {
      if (!fsModule.existsSync(filePath)) return fallback;
      try {
        return JSON.parse(fsModule.readFileSync(filePath, "utf-8"));
      } catch {
        return fallback;
      }
    },
    appendProtectedText: (filePath: string, text: string) => {
      ensureDir(filePath);
      fsModule.appendFileSync(filePath, text, "utf-8");
    },
    removeProtectedFile: (filePath: string) => {
      if (fsModule.existsSync(filePath)) {
        fsModule.unlinkSync(filePath);
      }
    },
    writeProtectedSecret: (name: string, value: string) => {
      const filePath = secretPath(name);
      ensureDir(filePath);
      fsModule.writeFileSync(filePath, value, "utf-8");
    },
    readProtectedSecret: (name: string) => {
      const filePath = secretPath(name);
      if (!fsModule.existsSync(filePath)) return undefined;
      return fsModule.readFileSync(filePath, "utf-8");
    },
    deleteProtectedSecret: (name: string) => {
      const filePath = secretPath(name);
      if (fsModule.existsSync(filePath)) {
        fsModule.unlinkSync(filePath);
      }
    },
  };
});
vi.mock("../src/moltlaunch/cli.js", () => ({
  walletShow: mocks.walletShow,
  getAgentByWallet: mocks.getAgentByWallet,
  getInbox: mocks.getInbox,
  getTask: mocks.getTask,
  registerAgent: mocks.registerAgent,
  walletImport: mocks.walletImport,
}));

interface TestRuntime {
  baseUrl: string;
  home: string;
  server: http.Server;
}

function randomPort(): number {
  return 41000 + Math.floor(Math.random() * 8000);
}

function browserHeaders(baseUrl: string): HeadersInit {
  return {
    Origin: baseUrl,
    "Sec-Fetch-Site": "same-origin",
  };
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function getCookieHeader(response: Response): string {
  return getSetCookies(response)
    .map((entry) => entry.split(";")[0])
    .join("; ");
}

function getCookieValue(response: Response, name: string): string | undefined {
  return getSetCookies(response)
    .map((entry) => entry.split(";")[0])
    .map((entry) => entry.split("="))
    .find(([key]) => key === name)?.[1];
}

async function closeServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function bootConfiguredRuntime(): Promise<TestRuntime> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cateo-int-"));
  const port = randomPort();
  process.env.CATEO_HOME = home;
  process.env.CATEO_PORT = String(port);

  vi.resetModules();

  const { resetSecureStoreCache } = await import("../src/security/secure_store.js");
  resetSecureStoreCache();

  const { saveConfig } = await import("../src/config.js");
  saveConfig({
    agentId: "agent-1",
    llm: { provider: "ollama", model: "operator-local", baseUrl: "http://localhost:11434/v1" },
    polling: { intervalMs: 30000, urgentIntervalMs: 10000 },
    pricing: { strategy: "fixed", baseRateEth: "0.005", maxRateEth: "0.05" },
    specialties: ["inspection", "root cause analysis"],
    autoQuote: false,
    autoWork: false,
    maxConcurrentTasks: 1,
    maxLoopTurns: 8,
    declineKeywords: [],
    learningEnabled: false,
    studyIntervalMs: 1_800_000,
    agentCashEnabled: false,
    security: {
      approvalPolicy: {
        quotes: true,
        declines: true,
        clientMessages: true,
        submissions: true,
        bountyClaims: true,
        agentCash: true,
      },
      persistence: {
        persistOperatorChat: true,
        persistKnowledge: true,
        persistFeedback: true,
        persistDatasets: true,
        persistActivityLog: true,
        auditRetentionDays: 180,
      },
      agentCashPolicy: {
        maxUsdPerCall: 0.05,
        maxUsdPerTask: 0.25,
        allowedClasses: ["research", "social"],
      },
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
  if (!server.listening) {
    await once(server, "listening");
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    home,
    server,
  };
}

describe("control plane integration", () => {
  let runtime: TestRuntime | null = null;

  beforeEach(() => {
    mocks.heartbeatInstances.length = 0;
    mocks.createHeartbeat.mockClear();
    mocks.executeTool.mockClear();
    mocks.walletShow.mockClear();
    mocks.getAgentByWallet.mockClear();
    mocks.getInbox.mockClear();
    mocks.getTask.mockClear();
  });

  afterEach(async () => {
    await closeServer(runtime?.server ?? null);
    runtime = null;
    if (process.env.CATEO_HOME && fs.existsSync(process.env.CATEO_HOME)) {
      fs.rmSync(process.env.CATEO_HOME, { recursive: true, force: true });
    }
    delete process.env.CATEO_HOME;
    delete process.env.CATEO_PORT;
    vi.resetModules();
  });

  it("requires bootstrap session and csrf for privileged HTTP control", async () => {
    runtime = await bootConfiguredRuntime();

    const unauthorized = await fetch(`${runtime.baseUrl}/api/status`, {
      headers: browserHeaders(runtime.baseUrl),
    });
    expect(unauthorized.status).toBe(403);

    const bootstrap = await fetch(`${runtime.baseUrl}/api/bootstrap`, {
      headers: browserHeaders(runtime.baseUrl),
    });
    expect(bootstrap.status).toBe(200);
    const snapshot = await bootstrap.json() as { snapshot: { status: { running: boolean } } };
    expect(snapshot.snapshot.status.running).toBe(true);

    const cookie = getCookieHeader(bootstrap);
    const csrf = getCookieValue(bootstrap, "cateo_csrf");
    expect(cookie).toContain("cateo_sid=");
    expect(csrf).toBeTruthy();

    const status = await fetch(`${runtime.baseUrl}/api/status`, {
      headers: { ...browserHeaders(runtime.baseUrl), Cookie: cookie },
    });
    expect(status.status).toBe(200);

    const stopWithoutCsrf = await fetch(`${runtime.baseUrl}/api/stop`, {
      method: "POST",
      headers: {
        ...browserHeaders(runtime.baseUrl),
        Cookie: cookie,
        "Content-Type": "application/json",
      },
    });
    expect(stopWithoutCsrf.status).toBe(403);

    const stopWithCsrf = await fetch(`${runtime.baseUrl}/api/stop`, {
      method: "POST",
      headers: {
        ...browserHeaders(runtime.baseUrl),
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Cateo-CSRF": csrf ?? "",
      },
    });
    expect(stopWithCsrf.status).toBe(200);
    expect(mocks.heartbeatInstances[0]?.stop).toHaveBeenCalled();
  });

  it("delivers live snapshots over websocket after authenticated bootstrap", async () => {
    runtime = await bootConfiguredRuntime();

    const bootstrap = await fetch(`${runtime.baseUrl}/api/bootstrap`, {
      headers: browserHeaders(runtime.baseUrl),
    });
    const cookie = getCookieHeader(bootstrap);
    const csrf = getCookieValue(bootstrap, "cateo_csrf");

    const wsUrl = `${runtime.baseUrl.replace("http", "ws")}/api/live?csrf=${encodeURIComponent(csrf ?? "")}`;
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        headers: {
          Origin: runtime.baseUrl,
          Cookie: cookie,
        },
      });

      socket.once("message", (data) => {
        resolve(data.toString());
        socket.close();
      });
      socket.once("error", reject);
    });

    const payload = JSON.parse(message) as { type: string; snapshot: { status: { agentId: string } } };
    expect(payload.type).toBe("snapshot");
    expect(payload.snapshot.status.agentId).toBe("agent-1");
  });

  it("executes approved actions through the approval endpoint", async () => {
    runtime = await bootConfiguredRuntime();

    const bootstrap = await fetch(`${runtime.baseUrl}/api/bootstrap`, {
      headers: browserHeaders(runtime.baseUrl),
    });
    const cookie = getCookieHeader(bootstrap);
    const csrf = getCookieValue(bootstrap, "cateo_csrf");

    const { requestApproval } = await import("../src/security/approvals.js");
    const { approval } = requestApproval({
      toolName: "quote_task",
      summary: "Quote the task",
      reason: "Quote requires approval",
      input: { task_id: "task-1", price_eth: "0.01" },
      taskStatus: "requested",
    });

    const response = await fetch(`${runtime.baseUrl}/api/approvals/approve`, {
      method: "POST",
      headers: {
        ...browserHeaders(runtime.baseUrl),
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Cateo-CSRF": csrf ?? "",
      },
      body: JSON.stringify({ id: approval.id, note: "approved in test" }),
    });
    expect(response.status).toBe(200);

    const payload = await response.json() as { ok: boolean; approval: { status: string }; result: string };
    expect(payload.ok).toBe(true);
    expect(payload.approval.status).toBe("executed");
    expect(payload.result).toContain("approved:quote_task");
    expect(mocks.executeTool).toHaveBeenCalledWith(
      "quote_task",
      { task_id: "task-1", price_eth: "0.01" },
      expect.objectContaining({ operatorApproved: true }),
    );
  });
});

