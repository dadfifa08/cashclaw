import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  loadConfig,
  savePartialConfig,
  isConfigured,
  isAgentCashAvailable,
  type CashClawConfig,
  type LLMConfig,
  type SecurityConfig,
  type AgentCashAccessClass,
} from "./config.js";
import { startControlPipeServer } from "./control/pipe_server.js";
import { createLLMProvider } from "./llm/index.js";
import { createModelRuntime } from "./llm/runtime.js";
import { createHeartbeat, type Heartbeat } from "./heartbeat.js";
import { readTodayLog } from "./memory/log.js";
import { getFeedbackStats, loadFeedback } from "./memory/feedback.js";
import { loadKnowledge, getRelevantKnowledge, deleteKnowledge } from "./memory/knowledge.js";
import { loadChat, appendChat, clearChat } from "./memory/chat.js";
import { agentcashBalance } from "./tools/agentcash.js";
import { executeTool } from "./tools/registry.js";
import type { Task } from "./moltlaunch/types.js";
import { appendAuditEvent, loadRecentAuditEvents, type AuditEvent } from "./security/audit.js";
import { getApprovals, getApproval, getPendingApprovals, updateApproval, type ApprovalRequest } from "./security/approvals.js";
import { getTaskVersion } from "./security/policy.js";
import { redactText, sanitizeForAudit } from "./security/redact.js";
import * as cli from "./moltlaunch/cli.js";
import { resolveRuntimeControlSettings, type RuntimeControlSettings } from "./system/runtime_paths.js";
import { handleCateoInternalApi, INTERNAL_CATEO_PREFIX } from "./cateo/http_api.js";
import { getInternalServiceToken } from "./system/service_auth.js";

const MAX_BODY_BYTES = 1_048_576;
const LIVE_PATH = "/api/live";
const CSRF_HEADER = "x-cateo-csrf";
const CSRF_QUERY_PARAM = "csrf";
const SESSION_COOKIE = "cateo_sid";
const CSRF_COOKIE = "cateo_csrf";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const WALLET_CACHE_TTL = 60_000;
const AGENTCASH_CACHE_TTL = 60_000;
const ETH_PRICE_CACHE_TTL = 60_000;
const APPROVED_AGENTCASH_CLASSES = new Set<AgentCashAccessClass>(["research", "social", "media", "outbound"]);

type ServerMode = "setup" | "running";

interface ServerContext {
  mode: ServerMode;
  config: CashClawConfig | null;
  heartbeat: Heartbeat | null;
  sessionId: string;
  csrfToken: string;
}

interface StatusPayload {
  running: boolean;
  activeTasks: number;
  totalPolls: number;
  lastPoll: number;
  startedAt: number;
  uptime: number;
  agentId: string;
  wsConnected: boolean;
  transportMode: "live" | "polling" | "stopped";
  pendingApprovals: number;
}

interface StatsPayload {
  totalTasks: number;
  avgScore: number;
  completionRate: number;
  studySessions: number;
  knowledgeEntries: number;
}

interface WalletPayload {
  address: string;
  balance?: string;
}

interface AgentCashBalancePayload {
  address: string;
  balance: string;
  network: string;
}

interface LiveRuntimeSnapshot {
  status: StatusPayload | null;
  tasks: ReturnType<typeof getTaskStatePayload>["tasks"];
  events: ReturnType<typeof getTaskStatePayload>["events"];
  stats: StatsPayload;
  wallet: WalletPayload | null;
  knowledge: ReturnType<typeof loadKnowledge>;
  feedback: ReturnType<typeof loadFeedback>;
  chat: ReturnType<typeof loadChat>;
  approvals: ApprovalRequest[];
  audit: AuditEvent[];
  config: CashClawConfig | null;
}

interface BootstrapPayload {
  type: "snapshot";
  configured: boolean;
  mode: ServerMode;
  step: string;
  snapshot: LiveRuntimeSnapshot;
}

interface ServerHelpers {
  queueBroadcast: () => void;
  setHeartbeat: (heartbeat: Heartbeat | null) => void;
  buildBootstrap: () => Promise<BootstrapPayload>;
}

let walletCache: { info: WalletPayload; fetchedAt: number } | null = null;
let agentCashBalanceCache: { info: AgentCashBalancePayload; fetchedAt: number } | null = null;
let ethPriceCache: { price: number; fetchedAt: number } | null = null;

export async function startAgent(): Promise<http.Server> {
  const runtimeSettings = resolveRuntimeControlSettings();
  const config = loadConfig();
  const configured = isConfigured();
  if (config && config.agentCashEnabled === undefined && isAgentCashAvailable()) {
    config.agentCashEnabled = true;
    savePartialConfig({ agentCashEnabled: true });
  }

  const ctx: ServerContext = {
    mode: configured ? "running" : "setup",
    config,
    heartbeat: null,
    sessionId: crypto.randomUUID(),
    csrfToken: crypto.randomUUID(),
  };

  if (ctx.mode === "running" && ctx.config) {
    const modelRuntime = createModelRuntime(ctx.config);
    const heartbeat = createHeartbeat(ctx.config, modelRuntime);
    heartbeat.start();
    ctx.heartbeat = heartbeat;
  }

  appendAuditEvent({ actor: "system", category: "runtime", action: "boot", outcome: "success", message: `Cateo server booted in ${ctx.mode} mode` });
  return createServer(ctx, runtimeSettings);
}

function createServer(ctx: ServerContext, runtimeSettings: RuntimeControlSettings): http.Server {
  const liveClients = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const internalServiceToken = getInternalServiceToken();
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let detachHeartbeatListener: (() => void) | null = null;

  async function buildBootstrap(): Promise<BootstrapPayload> {
    return {
      type: "snapshot",
      configured: isConfigured(),
      mode: ctx.mode,
      step: detectCurrentStep(ctx),
      snapshot: await buildLiveSnapshot(ctx),
    };
  }

  async function broadcastSnapshot() {
    const payload = JSON.stringify(await buildBootstrap());
    for (const client of liveClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function queueBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      void broadcastSnapshot();
    }, 0);
  }

  function setHeartbeat(heartbeat: Heartbeat | null) {
    if (detachHeartbeatListener) {
      detachHeartbeatListener();
      detachHeartbeatListener = null;
    }
    ctx.heartbeat = heartbeat;
    if (heartbeat) {
      detachHeartbeatListener = heartbeat.onEvent(() => queueBroadcast());
    }
    queueBroadcast();
  }

  async function restartHeartbeat() {
    if (!ctx.config) return;
    const wasRunning = ctx.heartbeat?.state.running ?? ctx.mode === "running";
    ctx.heartbeat?.stop();
    const modelRuntime = createModelRuntime(ctx.config);
    const heartbeat = createHeartbeat(ctx.config, modelRuntime);
    if (wasRunning) {
      heartbeat.start();
      ctx.mode = "running";
    }
    setHeartbeat(heartbeat);
  }

  setHeartbeat(ctx.heartbeat);

  const helpers: ServerHelpers = { queueBroadcast, setHeartbeat, buildBootstrap };

  const controlPipePromise = runtimeSettings.preferredControlEndpoint.mode === "named-pipe"
    ? startControlPipeServer({
        endpoint: runtimeSettings.preferredControlEndpoint.endpoint,
        onAudit: (event) => {
          appendAuditEvent({
            actor: "server",
            category: "control_pipe",
            action: event.action,
            outcome: event.outcome,
            message: event.message,
            metadata: event.metadata,
          });
        },
        onRequest: async (request) => {
          switch (request.action) {
            case "bootstrap":
              return helpers.buildBootstrap();
            case "status":
              return getStatusPayload(ctx);
            case "tasks":
              return getTaskStatePayload(ctx);
            case "config.get":
              return maskConfig(ctx.config);
            case "runtime.start":
              ctx.heartbeat?.start();
              queueBroadcast();
              return getStatusPayload(ctx);
            case "runtime.stop":
              ctx.heartbeat?.stop();
              queueBroadcast();
              return getStatusPayload(ctx);
            case "runtime.sync":
              ctx.heartbeat?.syncNow("Local control pipe sync");
              return getStatusPayload(ctx);
            case "approvals.list":
              return { entries: getApprovals(100) };
            default:
              throw new Error(`Unsupported control action: ${request.action}`);
          }
        },
      }).catch((error) => {
        appendAuditEvent({
          actor: "server",
          category: "control_pipe",
          action: "listen",
          outcome: "error",
          severity: "warn",
          message: `Local control pipe failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return null;
      })
    : Promise.resolve(null);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        json(res, { error: message }, 500);
        return;
      }
      res.end();
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const requestId = crypto.randomUUID();
    res.setHeader("X-Request-Id", requestId);
    setSecurityHeaders(req, res, runtimeSettings);

    if (req.method === "OPTIONS") {
      if (!isLocalSocketRequest(req, runtimeSettings) || !isTrustedBrowserContext(req, runtimeSettings)) {
        auditDeniedRequest(req, requestId, "OPTIONS rejected");
        json(res, { error: "Forbidden" }, 403);
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (!isLocalSocketRequest(req, runtimeSettings)) {
      auditDeniedRequest(req, requestId, "Non-local request blocked");
      json(res, { error: "Forbidden" }, 403);
      return;
    }

    const url = new URL(req.url ?? "/", runtimeSettings.baseUrl);

    if (url.pathname.startsWith(INTERNAL_CATEO_PREFIX)) {
      const apiAction = `${req.method ?? "GET"} ${url.pathname}`;
      res.on("finish", () => {
        appendAuditEvent({
          actor: "server",
          category: "internal_api",
          action: apiAction,
          outcome: String(res.statusCode),
          message: `${apiAction} -> ${res.statusCode}`,
          requestId,
          severity: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
          metadata: { remoteAddress: req.socket.remoteAddress },
        });
      });

      if (!hasValidInternalToken(req, internalServiceToken)) {
        auditDeniedRequest(req, requestId, "Missing or invalid internal service token");
        json(res, { error: "Unauthorized" }, 403);
        return;
      }

      await handleCateoInternalApi(url.pathname, req, res, ctx.config, requestId);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const apiAction = `${req.method ?? "GET"} ${url.pathname}`;
      res.on("finish", () => {
        appendAuditEvent({
          actor: "server",
          category: "api",
          action: apiAction,
          outcome: String(res.statusCode),
          message: `${apiAction} -> ${res.statusCode}`,
          requestId,
          severity: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
          metadata: {
            remoteAddress: req.socket.remoteAddress,
            origin: req.headers.origin,
            fetchSite: req.headers["sec-fetch-site"],
          },
        });
      });

      if (!isTrustedApiRequest(req, runtimeSettings)) {
        auditDeniedRequest(req, requestId, "Browser trust checks failed");
        json(res, { error: "Forbidden" }, 403);
        return;
      }

      if (url.pathname === "/api/bootstrap") {
        issueOperatorSessionCookies(res, ctx);
        json(res, await helpers.buildBootstrap());
        return;
      }

      if (!hasValidSession(req, ctx)) {
        auditDeniedRequest(req, requestId, "Missing or invalid operator session");
        json(res, { error: "Unauthorized" }, 403);
        return;
      }

      if (req.method === "POST" && !hasValidCsrf(req, ctx)) {
        auditDeniedRequest(req, requestId, "Invalid CSRF token");
        json(res, { error: "Unauthorized" }, 403);
        return;
      }

      await handleApi(url.pathname, req, res, ctx, helpers, restartHeartbeat, requestId);
      return;
    }

    if (!path.extname(url.pathname)) {
      issueOperatorSessionCookies(res, ctx);
    }

    serveStatic(url.pathname, res);
  }

  server.on("upgrade", (req, socket, head) => {
    const requestId = crypto.randomUUID();
    const url = new URL(req.url ?? "/", runtimeSettings.baseUrl);
    if (url.pathname !== LIVE_PATH) {
      socket.destroy();
      return;
    }

    if (!isTrustedWebSocketRequest(req, ctx, url, runtimeSettings)) {
      appendAuditEvent({
        actor: "server",
        category: "websocket",
        action: "upgrade",
        outcome: "denied",
        severity: "warn",
        message: "Live websocket upgrade denied",
        requestId,
        metadata: {
          remoteAddress: req.socket.remoteAddress,
          origin: req.headers.origin,
        },
      });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      liveClients.add(ws);
      appendAuditEvent({
        actor: "server",
        category: "websocket",
        action: "upgrade",
        outcome: "connected",
        message: "Live websocket connected",
        requestId,
      });
      ws.on("close", () => liveClients.delete(ws));
      ws.on("error", () => liveClients.delete(ws));
      void buildBootstrap().then((payload) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      });
    });
  });

  server.on("close", () => {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    if (detachHeartbeatListener) {
      detachHeartbeatListener();
      detachHeartbeatListener = null;
    }
    for (const client of liveClients) {
      client.close();
    }
    wss.close();
    void controlPipePromise.then((pipeServer) => pipeServer?.close().catch(() => undefined));
  });

  server.listen(runtimeSettings.port, runtimeSettings.host, () => {
    console.log(`Dashboard: ${runtimeSettings.baseUrl}`);
    void controlPipePromise.then((pipeServer) => {
      if (pipeServer) {
        console.log(`Control: ${pipeServer.endpoint}`);
      }
    });
  });

  return server;
}

function normalizeOrigin(origin: string | undefined): string | null {
  return origin ? origin.toLowerCase() : null;
}

function normalizeHost(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase();
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(/;\s*/).map((part) => {
      const separator = part.indexOf("=");
      if (separator === -1) return [part, ""];
      return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
    }),
  );
}

function appendCookieHeader(res: http.ServerResponse, cookie: string): void {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  const next = Array.isArray(current) ? [...current, cookie] : [String(current), cookie];
  res.setHeader("Set-Cookie", next);
}

function issueOperatorSessionCookies(res: http.ServerResponse, ctx: ServerContext): void {
  appendCookieHeader(res, `${SESSION_COOKIE}=${encodeURIComponent(ctx.sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`);
  appendCookieHeader(res, `${CSRF_COOKIE}=${encodeURIComponent(ctx.csrfToken)}; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLocalSocketRequest(req: http.IncomingMessage, runtimeSettings: RuntimeControlSettings): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) && runtimeSettings.allowedHosts.has(normalizeHost(req.headers.host));
}

function isTrustedBrowserContext(req: http.IncomingMessage, runtimeSettings: RuntimeControlSettings): boolean {
  const origin = normalizeOrigin(req.headers.origin);
  const fetchSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (origin) {
    return runtimeSettings.allowedOrigins.has(origin) && (fetchSite === "" || fetchSite === "same-origin" || fetchSite === "same-site");
  }
  return fetchSite === "same-origin" || fetchSite === "same-site";
}

function isTrustedApiRequest(req: http.IncomingMessage, runtimeSettings: RuntimeControlSettings): boolean {
  return isLocalSocketRequest(req, runtimeSettings) && isTrustedBrowserContext(req, runtimeSettings);
}

function hasValidSession(req: http.IncomingMessage, ctx: ServerContext): boolean {
  return parseCookies(req)[SESSION_COOKIE] === ctx.sessionId;
}

function hasValidCsrf(req: http.IncomingMessage, ctx: ServerContext): boolean {
  const header = Array.isArray(req.headers[CSRF_HEADER]) ? req.headers[CSRF_HEADER][0] : req.headers[CSRF_HEADER];
  const cookies = parseCookies(req);
  return cookies[CSRF_COOKIE] === ctx.csrfToken && header === ctx.csrfToken;
}

function hasValidInternalToken(req: http.IncomingMessage, expectedToken: string): boolean {
  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  const expectedBuffer = Buffer.from(expectedToken);
  const presentedBuffer = Buffer.from(presented);
  if (expectedBuffer.length !== presentedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, presentedBuffer);
}

function isTrustedWebSocketRequest(req: http.IncomingMessage, ctx: ServerContext, url: URL, runtimeSettings: RuntimeControlSettings): boolean {
  const origin = normalizeOrigin(req.headers.origin);
  return isLocalSocketRequest(req, runtimeSettings) && !!origin && runtimeSettings.allowedOrigins.has(origin) && hasValidSession(req, ctx) && url.searchParams.get(CSRF_QUERY_PARAM) === ctx.csrfToken;
}

function setSecurityHeaders(req: http.IncomingMessage, res: http.ServerResponse, runtimeSettings: RuntimeControlSettings) {
  const origin = normalizeOrigin(req.headers.origin);
  if (origin && runtimeSettings.allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Cateo-CSRF");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=() ");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const liveConnectSources = [`ws://${runtimeSettings.host}:${runtimeSettings.port}`, `ws://localhost:${runtimeSettings.port}`].join(" ");
  res.setHeader("Content-Security-Policy", `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self' ${liveConnectSources} https://min-api.cryptocompare.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self';`);
}

function auditDeniedRequest(req: http.IncomingMessage, requestId: string, reason: string): void {
  appendAuditEvent({
    actor: "server",
    category: "auth",
    action: req.method ?? "GET",
    outcome: "denied",
    severity: "warn",
    message: reason,
    requestId,
    metadata: {
      path: req.url,
      remoteAddress: req.socket.remoteAddress,
      origin: req.headers.origin,
      fetchSite: req.headers["sec-fetch-site"],
      host: req.headers.host,
    },
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseJsonBody<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
}

function maskConfig(config: CashClawConfig | null): CashClawConfig | null {
  if (!config) return null;
  return { ...config, llm: { ...config.llm, apiKey: config.llm.apiKey ? "***" : undefined } };
}

function getStatusPayload(ctx: ServerContext): StatusPayload | null {
  if (!ctx.config || !ctx.heartbeat) return null;
  const { state } = ctx.heartbeat;
  return {
    running: state.running,
    activeTasks: state.activeTasks.size,
    totalPolls: state.totalPolls,
    lastPoll: state.lastPoll,
    startedAt: state.startedAt,
    uptime: state.running ? Date.now() - state.startedAt : 0,
    agentId: ctx.config.agentId,
    wsConnected: state.wsConnected,
    transportMode: state.running ? (state.wsConnected ? "live" : "polling") : "stopped",
    pendingApprovals: getPendingApprovals().length,
  };
}

function getTaskStatePayload(ctx: ServerContext) {
  return {
    tasks: ctx.heartbeat ? [...ctx.heartbeat.state.activeTasks.values()] : [],
    events: ctx.heartbeat ? ctx.heartbeat.state.events.slice(-75) : [],
  };
}

function getStatsPayload(ctx: ServerContext): StatsPayload {
  const feedback = getFeedbackStats();
  return { ...feedback, studySessions: ctx.heartbeat?.state.totalStudySessions ?? 0, knowledgeEntries: loadKnowledge().length };
}

async function getWalletInfoCached(force = false): Promise<WalletPayload | null> {
  const now = Date.now();
  if (!force && walletCache && now - walletCache.fetchedAt < WALLET_CACHE_TTL) return walletCache.info;
  const info = await cli.walletShow();
  walletCache = { info, fetchedAt: now };
  return info;
}

async function getAgentCashBalanceCached(config: CashClawConfig, force = false): Promise<AgentCashBalancePayload | null> {
  if (!config.agentCashEnabled) return null;
  const now = Date.now();
  if (!force && agentCashBalanceCache && now - agentCashBalanceCache.fetchedAt < AGENTCASH_CACHE_TTL) return agentCashBalanceCache.info;
  const result = await agentcashBalance.execute({}, { config, taskId: "", task: buildSyntheticTask(undefined, config.agentId) });
  if (!result.success) throw new Error(result.data);
  const parsed = JSON.parse(result.data) as { address: string; balanceUSDC?: string; balance?: string; network: string };
  const info: AgentCashBalancePayload = { address: parsed.address, balance: parsed.balanceUSDC ?? parsed.balance ?? "0", network: parsed.network };
  agentCashBalanceCache = { info, fetchedAt: now };
  return info;
}

async function getEthPriceCached(force = false): Promise<number> {
  const now = Date.now();
  if (!force && ethPriceCache && now - ethPriceCache.fetchedAt < ETH_PRICE_CACHE_TTL) return ethPriceCache.price;
  const resp = await fetch("https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD");
  const data = (await resp.json()) as { USD?: number };
  if (!data.USD) throw new Error("Failed to fetch ETH price");
  ethPriceCache = { price: data.USD, fetchedAt: now };
  return data.USD;
}

async function buildLiveSnapshot(ctx: ServerContext): Promise<LiveRuntimeSnapshot> {
  const taskState = getTaskStatePayload(ctx);
  const wallet = ctx.mode === "running" ? await getWalletInfoCached().catch(() => null) : null;
  return {
    status: getStatusPayload(ctx),
    tasks: taskState.tasks,
    events: taskState.events,
    stats: getStatsPayload(ctx),
    wallet,
    knowledge: loadKnowledge(),
    feedback: loadFeedback(),
    chat: loadChat(),
    approvals: getApprovals(100),
    audit: loadRecentAuditEvents(200),
    config: maskConfig(ctx.config),
  };
}

async function handleApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  helpers: ServerHelpers,
  restartHeartbeat: () => Promise<void>,
  requestId: string,
) {
  if (pathname.startsWith("/api/setup/")) {
    await handleSetupApi(pathname, req, res, ctx, helpers, restartHeartbeat, requestId);
    return;
  }

  if (!ctx.config || !ctx.heartbeat) {
    json(res, { error: "Agent not configured", mode: "setup" }, 503);
    return;
  }

  switch (pathname) {
    case "/api/status": json(res, getStatusPayload(ctx)); break;
    case "/api/tasks": json(res, getTaskStatePayload(ctx)); break;
    case "/api/logs": json(res, { log: readTodayLog() }); break;
    case "/api/config": json(res, maskConfig(ctx.config)); break;
    case "/api/stats": json(res, getStatsPayload(ctx)); break;
    case "/api/knowledge": json(res, { entries: loadKnowledge() }); break;
    case "/api/knowledge/delete":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      await handleKnowledgeDelete(req, res, helpers.queueBroadcast, requestId);
      break;
    case "/api/feedback": json(res, { entries: loadFeedback() }); break;
    case "/api/audit": json(res, { entries: loadRecentAuditEvents(200) }); break;
    case "/api/approvals": json(res, { entries: getApprovals(100) }); break;
    case "/api/approvals/approve":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      await handleApprovalDecision(req, res, ctx, helpers.queueBroadcast, requestId, true);
      break;
    case "/api/approvals/reject":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      await handleApprovalDecision(req, res, ctx, helpers.queueBroadcast, requestId, false);
      break;
    case "/api/stop":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      ctx.heartbeat.stop();
      helpers.queueBroadcast();
      appendAuditEvent({ actor: "operator", category: "runtime", action: "stop", outcome: "success", message: "Operator stopped the runtime", requestId });
      json(res, { ok: true, running: false });
      break;
    case "/api/start":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      ctx.heartbeat.start();
      helpers.queueBroadcast();
      appendAuditEvent({ actor: "operator", category: "runtime", action: "start", outcome: "success", message: "Operator started the runtime", requestId });
      json(res, { ok: true, running: true });
      break;
    case "/api/config-update":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      await handleConfigUpdate(req, res, ctx, helpers, restartHeartbeat, requestId);
      break;
    case "/api/chat":
      if (req.method === "GET") {
        json(res, { messages: loadChat() });
      } else if (req.method === "POST") {
        await handleChat(req, res, ctx, helpers.queueBroadcast, requestId);
      } else {
        json(res, { error: "GET or POST" }, 405);
      }
      break;
    case "/api/chat/clear":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      clearChat();
      helpers.queueBroadcast();
      appendAuditEvent({ actor: "operator", category: "chat", action: "clear", outcome: "success", message: "Operator chat history cleared", requestId });
      json(res, { ok: true });
      break;
    case "/api/wallet": await handleWallet(res); break;
    case "/api/agent-info": await handleAgentInfo(res); break;
    case "/api/agentcash-balance": await handleAgentCashBalance(res, ctx); break;
    case "/api/eth-price": await handleEthPrice(res); break;
    default: json(res, { error: "Not found" }, 404);
  }
}

async function handleSetupApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  helpers: ServerHelpers,
  restartHeartbeat: () => Promise<void>,
  requestId: string,
) {
  try {
    switch (pathname) {
      case "/api/setup/status":
        json(res, { configured: isConfigured(), mode: ctx.mode, step: detectCurrentStep(ctx) });
        break;
      case "/api/setup/wallet": {
        const wallet = await cli.walletShow();
        walletCache = { info: wallet, fetchedAt: Date.now() };
        json(res, wallet);
        break;
      }
      case "/api/setup/agent-lookup": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const wallet = await cli.walletShow();
        const agent = await cli.getAgentByWallet(wallet.address);
        if (agent) {
          savePartialConfig({ agentId: agent.agentId });
          ctx.config = loadConfig();
          helpers.queueBroadcast();
        }
        appendAuditEvent({ actor: "operator", category: "setup", action: "agent_lookup", outcome: agent ? "found" : "not_found", message: agent ? `Agent lookup resolved to ${agent.agentId}` : "Agent lookup found no registered agent", requestId });
        json(res, { agent });
        break;
      }
      case "/api/setup/wallet/import": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody(await readBody(req)) as { privateKey: string };
        if (!/^0x[a-fA-F0-9]{64}$/.test(body.privateKey ?? "")) {
          json(res, { error: "Invalid private key format" }, 400);
          return;
        }
        const wallet = await cli.walletImport(body.privateKey);
        walletCache = { info: wallet, fetchedAt: Date.now() };
        helpers.queueBroadcast();
        appendAuditEvent({ actor: "operator", category: "wallet", action: "import", outcome: "success", message: "Wallet imported via setup flow", requestId });
        json(res, wallet);
        break;
      }
      case "/api/setup/register": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody(await readBody(req)) as { name: string; description: string; skills: string[]; price: string; symbol?: string; token?: string; image?: string; website?: string };
        let imagePath: string | undefined;
        if (body.image && body.image.startsWith("data:")) {
          if (body.image.length > 3_000_000) { json(res, { error: "Image payload too large" }, 400); return; }
          const match = body.image.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
          if (!match) { json(res, { error: "Unsupported image format" }, 400); return; }
          const ext = match[1] === "jpeg" ? "jpg" : match[1];
          imagePath = path.join(os.tmpdir(), `cashclaw-image-${Date.now()}.${ext}`);
          fs.writeFileSync(imagePath, Buffer.from(match[2], "base64"));
        }
        try {
          const result = await cli.registerAgent({ ...body, image: imagePath });
          savePartialConfig({ agentId: result.agentId });
          ctx.config = loadConfig();
          helpers.queueBroadcast();
          appendAuditEvent({ actor: "operator", category: "setup", action: "register_agent", outcome: "success", message: `Registered agent ${result.agentId}`, requestId });
          json(res, result);
        } finally {
          if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        }
        break;
      }
      case "/api/setup/llm": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const llm = normalizeLlmConfig(parseJsonBody(await readBody(req)) as LLMConfig);
        savePartialConfig({ llm });
        ctx.config = loadConfig();
        helpers.queueBroadcast();
        appendAuditEvent({ actor: "operator", category: "setup", action: "save_llm", outcome: "success", message: `Saved LLM provider ${llm.provider}`, requestId });
        json(res, { ok: true });
        break;
      }
      case "/api/setup/llm/test": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const llm = createLLMProvider(normalizeLlmConfig(parseJsonBody(await readBody(req)) as LLMConfig));
        const response = await llm.chat([{ role: "user", content: "Say hello in one sentence." }]);
        const text = response.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("");
        appendAuditEvent({ actor: "operator", category: "setup", action: "test_llm", outcome: "success", message: "LLM connection test succeeded", requestId });
        json(res, { ok: true, response: text });
        break;
      }
      case "/api/setup/specialization": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const current = ctx.config ?? loadConfig() ?? savePartialConfig({});
        const body = parseJsonBody(await readBody(req)) as {
          specialties: string[];
          pricing: { strategy: string; baseRateEth: string; maxRateEth: string };
          autoQuote: boolean;
          autoWork: boolean;
          maxConcurrentTasks: number;
          declineKeywords: string[];
        };
        ctx.config = savePartialConfig(applyConfigUpdates(current, {
          specialties: body.specialties,
          pricing: body.pricing as CashClawConfig["pricing"],
          autoQuote: body.autoQuote,
          autoWork: body.autoWork,
          maxConcurrentTasks: body.maxConcurrentTasks,
          declineKeywords: body.declineKeywords,
        }));
        helpers.queueBroadcast();
        appendAuditEvent({ actor: "operator", category: "setup", action: "save_specialization", outcome: "success", message: "Saved runtime specialization settings", requestId });
        json(res, { ok: true });
        break;
      }
      case "/api/setup/complete": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        if (!isConfigured()) {
          json(res, { error: "Configuration incomplete" }, 400);
          return;
        }
        ctx.config = loadConfig();
        if (!ctx.config) {
          json(res, { error: "Configuration missing" }, 400);
          return;
        }
        const modelRuntime = createModelRuntime(ctx.config);
        const heartbeat = createHeartbeat(ctx.config, modelRuntime);
        heartbeat.start();
        helpers.setHeartbeat(heartbeat);
        ctx.mode = "running";
        helpers.queueBroadcast();
        appendAuditEvent({ actor: "operator", category: "setup", action: "complete", outcome: "success", message: "Setup completed and runtime started", requestId });
        json(res, { ok: true, mode: "running" });
        break;
      }
      case "/api/setup/reset": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        ctx.heartbeat?.stop();
        helpers.setHeartbeat(null);
        ctx.config = loadConfig();
        ctx.mode = "setup";
        helpers.queueBroadcast();
        appendAuditEvent({ actor: "operator", category: "setup", action: "reset", outcome: "success", message: "Returned runtime to setup mode", requestId });
        json(res, { ok: true, mode: "setup" });
        break;
      }
      default:
        json(res, { error: "Not found" }, 404);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, { error: message }, err instanceof HttpError ? err.status : 500);
  }
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function detectCurrentStep(ctx: ServerContext): string {
  if (!ctx.config) return "wallet";
  if (!ctx.config.agentId) return "register";
  const llm = ctx.config.llm;
  if (!llm.model) return "llm";
  if (llm.provider === "ollama") {
    return llm.baseUrl ? "specialization" : "llm";
  }
  return llm.apiKey ? "specialization" : "llm";
}

function buildSyntheticTask(status: Task["status"] = "requested", agentId = ""): Task {
  return {
    id: "local-operator-action",
    agentId,
    clientAddress: "local-operator",
    task: "Local operator security action",
    status,
    revisionCount: 0,
    messages: [],
    files: [],
  };
}

function expectNonEmptyString(value: unknown, fieldName: string, maxLength = 2000): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, `${fieldName} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function normalizeOptionalString(value: unknown, fieldName: string, maxLength = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function normalizeStringArray(value: unknown, fieldName: string, maxItems = 50, maxLength = 120): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be an array`);
  }
  const normalized = value.map((entry) => expectNonEmptyString(entry, fieldName, maxLength));
  const unique = [...new Set(normalized)];
  if (unique.length > maxItems) {
    throw new HttpError(400, `${fieldName} must contain ${maxItems} items or fewer`);
  }
  return unique;
}

function normalizeInteger(value: unknown, fieldName: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${fieldName} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeNumber(value: unknown, fieldName: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${fieldName} must be between ${min} and ${max}`);
  }
  return parsed;
}

function normalizePricing(pricing: Partial<CashClawConfig["pricing"]>): CashClawConfig["pricing"] {
  const strategy = pricing.strategy;
  if (strategy !== "fixed" && strategy !== "complexity") {
    throw new HttpError(400, "pricing.strategy must be fixed or complexity");
  }
  const baseRateEth = expectNonEmptyString(pricing.baseRateEth, "pricing.baseRateEth", 32);
  const maxRateEth = expectNonEmptyString(pricing.maxRateEth, "pricing.maxRateEth", 32);
  const ethPattern = /^\d+(\.\d{1,18})?$/;
  if (!ethPattern.test(baseRateEth) || !ethPattern.test(maxRateEth)) {
    throw new HttpError(400, "Pricing ETH amounts must be decimal strings with up to 18 places");
  }
  if (parseFloat(baseRateEth) > parseFloat(maxRateEth)) {
    throw new HttpError(400, "pricing.baseRateEth cannot exceed pricing.maxRateEth");
  }
  return { strategy, baseRateEth, maxRateEth };
}
function normalizeBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new HttpError(400, `${fieldName} must be true or false`);
  }
  return value;
}

function normalizePersonality(personality: CashClawConfig["personality"] | undefined): CashClawConfig["personality"] {
  if (personality === undefined) return undefined;
  if (!personality) return undefined;
  const tone = personality.tone;
  const responseStyle = personality.responseStyle;
  if (!tone || !["professional", "casual", "friendly", "technical"].includes(tone)) {
    throw new HttpError(400, "personality.tone is invalid");
  }
  if (!responseStyle || !["concise", "detailed", "balanced"].includes(responseStyle)) {
    throw new HttpError(400, "personality.responseStyle is invalid");
  }
  const customInstructions = normalizeOptionalString(personality.customInstructions, "personality.customInstructions", 2000);
  return { tone, responseStyle, customInstructions };
}

function normalizeSecurityConfigUpdate(input: Partial<SecurityConfig> | undefined, current: SecurityConfig): SecurityConfig {
  const approvalPolicy = {
    quotes: input?.approvalPolicy?.quotes !== undefined ? normalizeBoolean(input.approvalPolicy.quotes, "security.approvalPolicy.quotes") : current.approvalPolicy.quotes,
    declines: input?.approvalPolicy?.declines !== undefined ? normalizeBoolean(input.approvalPolicy.declines, "security.approvalPolicy.declines") : current.approvalPolicy.declines,
    clientMessages: input?.approvalPolicy?.clientMessages !== undefined ? normalizeBoolean(input.approvalPolicy.clientMessages, "security.approvalPolicy.clientMessages") : current.approvalPolicy.clientMessages,
    submissions: input?.approvalPolicy?.submissions !== undefined ? normalizeBoolean(input.approvalPolicy.submissions, "security.approvalPolicy.submissions") : current.approvalPolicy.submissions,
    bountyClaims: input?.approvalPolicy?.bountyClaims !== undefined ? normalizeBoolean(input.approvalPolicy.bountyClaims, "security.approvalPolicy.bountyClaims") : current.approvalPolicy.bountyClaims,
    agentCash: input?.approvalPolicy?.agentCash !== undefined ? normalizeBoolean(input.approvalPolicy.agentCash, "security.approvalPolicy.agentCash") : current.approvalPolicy.agentCash,
  };

  const persistence = {
    persistOperatorChat: input?.persistence?.persistOperatorChat !== undefined ? normalizeBoolean(input.persistence.persistOperatorChat, "security.persistence.persistOperatorChat") : current.persistence.persistOperatorChat,
    persistKnowledge: input?.persistence?.persistKnowledge !== undefined ? normalizeBoolean(input.persistence.persistKnowledge, "security.persistence.persistKnowledge") : current.persistence.persistKnowledge,
    persistFeedback: input?.persistence?.persistFeedback !== undefined ? normalizeBoolean(input.persistence.persistFeedback, "security.persistence.persistFeedback") : current.persistence.persistFeedback,
    persistDatasets: input?.persistence?.persistDatasets !== undefined ? normalizeBoolean(input.persistence.persistDatasets, "security.persistence.persistDatasets") : current.persistence.persistDatasets,
    persistActivityLog: input?.persistence?.persistActivityLog !== undefined ? normalizeBoolean(input.persistence.persistActivityLog, "security.persistence.persistActivityLog") : current.persistence.persistActivityLog,
    auditRetentionDays: input?.persistence?.auditRetentionDays !== undefined ? normalizeInteger(input.persistence.auditRetentionDays, "security.persistence.auditRetentionDays", 1, 3650) : current.persistence.auditRetentionDays,
  };

  let allowedClasses = current.agentCashPolicy.allowedClasses;
  if (input?.agentCashPolicy?.allowedClasses !== undefined) {
    if (!Array.isArray(input.agentCashPolicy.allowedClasses)) {
      throw new HttpError(400, "security.agentCashPolicy.allowedClasses must be an array");
    }
    const unique = [...new Set(input.agentCashPolicy.allowedClasses.map((entry) => expectNonEmptyString(entry, "security.agentCashPolicy.allowedClasses", 20)))];
    if (unique.some((entry) => !APPROVED_AGENTCASH_CLASSES.has(entry as AgentCashAccessClass))) {
      throw new HttpError(400, "security.agentCashPolicy.allowedClasses contains an unsupported class");
    }
    allowedClasses = unique as AgentCashAccessClass[];
  }

  const agentCashPolicy = {
    maxUsdPerCall: input?.agentCashPolicy?.maxUsdPerCall !== undefined ? normalizeNumber(input.agentCashPolicy.maxUsdPerCall, "security.agentCashPolicy.maxUsdPerCall", 0, 1000) : current.agentCashPolicy.maxUsdPerCall,
    maxUsdPerTask: input?.agentCashPolicy?.maxUsdPerTask !== undefined ? normalizeNumber(input.agentCashPolicy.maxUsdPerTask, "security.agentCashPolicy.maxUsdPerTask", 0, 5000) : current.agentCashPolicy.maxUsdPerTask,
    allowedClasses,
  };

  if (agentCashPolicy.maxUsdPerTask < agentCashPolicy.maxUsdPerCall) {
    throw new HttpError(400, "security.agentCashPolicy.maxUsdPerTask must be greater than or equal to maxUsdPerCall");
  }

  return { approvalPolicy, persistence, agentCashPolicy };
}

function normalizeOrchestrationMode(value: unknown, fieldName: string): CashClawConfig["orchestration"]["challenger"]["mode"] {
  if (value !== "adaptive" && value !== "always" && value !== "never") {
    throw new HttpError(400, `${fieldName} must be adaptive, always, or never`);
  }
  return value;
}

function normalizeLeadRoleConfig(
  input: Partial<CashClawConfig["orchestration"]["lead"]> | undefined,
  current: CashClawConfig["orchestration"]["lead"],
): CashClawConfig["orchestration"]["lead"] {
  return {
    model: input?.model !== undefined ? expectNonEmptyString(input.model, "orchestration.lead.model", 200) : current.model,
    baseUrl: input?.baseUrl !== undefined ? normalizeLoopbackUrl(expectNonEmptyString(input.baseUrl, "orchestration.lead.baseUrl", 500)) : current.baseUrl,
  };
}

function normalizeSupportRoleConfig(
  input: Partial<CashClawConfig["orchestration"]["challenger"]> | undefined,
  current: CashClawConfig["orchestration"]["challenger"],
  prefix: "orchestration.challenger" | "orchestration.structure",
): CashClawConfig["orchestration"]["challenger"] {
  return {
    enabled: input?.enabled !== undefined ? normalizeBoolean(input.enabled, `${prefix}.enabled`) : current.enabled,
    mode: input?.mode !== undefined ? normalizeOrchestrationMode(input.mode, `${prefix}.mode`) : current.mode,
    model: input?.model !== undefined ? expectNonEmptyString(input.model, `${prefix}.model`, 200) : current.model,
    baseUrl: input?.baseUrl !== undefined ? normalizeLoopbackUrl(expectNonEmptyString(input.baseUrl, `${prefix}.baseUrl`, 500)) : current.baseUrl,
  };
}

function normalizeOrchestrationConfigUpdate(
  input: Partial<CashClawConfig["orchestration"]> | undefined,
  current: CashClawConfig["orchestration"],
): CashClawConfig["orchestration"] {
  return {
    enabled: input?.enabled !== undefined ? normalizeBoolean(input.enabled, "orchestration.enabled") : current.enabled,
    lead: normalizeLeadRoleConfig(input?.lead, current.lead),
    challenger: normalizeSupportRoleConfig(input?.challenger, current.challenger, "orchestration.challenger"),
    structure: normalizeSupportRoleConfig(input?.structure, current.structure, "orchestration.structure"),
  };
}

function normalizeLoopbackUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "llm.baseUrl must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HttpError(400, "llm.baseUrl must use http or https");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new HttpError(400, "Ollama base URL must target localhost or loopback only");
  }
  return value.replace(/\/+$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function normalizeLlmConfig(input: LLMConfig, current?: LLMConfig): LLMConfig {
  if (!["anthropic", "openai", "openrouter", "ollama"].includes(input.provider)) {
    throw new HttpError(400, "llm.provider is invalid");
  }

  const provider = input.provider;
  const model = expectNonEmptyString(input.model, "llm.model", 200);

  if (provider === "ollama") {
    return {
      provider,
      model,
      baseUrl: normalizeLoopbackUrl(input.baseUrl ?? current?.baseUrl ?? "http://localhost:11434/v1"),
    };
  }

  let apiKey: string | undefined;
  if (input.apiKey === "***") {
    if (current?.provider !== provider || !current.apiKey) {
      throw new HttpError(400, "A new provider requires a real API key");
    }
    apiKey = current.apiKey;
  } else {
    apiKey = normalizeOptionalString(input.apiKey, "llm.apiKey", 500) ?? (current?.provider === provider ? current.apiKey : undefined);
  }

  if (!apiKey) {
    throw new HttpError(400, "llm.apiKey is required");
  }

  return { provider, model, apiKey };
}

function applyConfigUpdates(current: CashClawConfig, updates: Partial<CashClawConfig>): CashClawConfig {
  return {
    ...current,
    agentId: updates.agentId !== undefined ? expectNonEmptyString(updates.agentId, "agentId", 200) : current.agentId,
    llm: updates.llm ? normalizeLlmConfig({ ...current.llm, ...updates.llm }, current.llm) : current.llm,
    polling: updates.polling
      ? {
          intervalMs: updates.polling.intervalMs !== undefined ? normalizeInteger(updates.polling.intervalMs, "polling.intervalMs", 5_000, 600_000) : current.polling.intervalMs,
          urgentIntervalMs: updates.polling.urgentIntervalMs !== undefined ? normalizeInteger(updates.polling.urgentIntervalMs, "polling.urgentIntervalMs", 3_000, 120_000) : current.polling.urgentIntervalMs,
        }
      : current.polling,
    pricing: updates.pricing ? normalizePricing(updates.pricing) : current.pricing,
    specialties: updates.specialties ? normalizeStringArray(updates.specialties, "specialties", 50, 120) : current.specialties,
    autoQuote: updates.autoQuote !== undefined ? normalizeBoolean(updates.autoQuote, "autoQuote") : current.autoQuote,
    autoWork: updates.autoWork !== undefined ? normalizeBoolean(updates.autoWork, "autoWork") : current.autoWork,
    maxConcurrentTasks: updates.maxConcurrentTasks !== undefined ? normalizeInteger(updates.maxConcurrentTasks, "maxConcurrentTasks", 1, 20) : current.maxConcurrentTasks,
    maxLoopTurns: updates.maxLoopTurns !== undefined ? normalizeInteger(updates.maxLoopTurns, "maxLoopTurns", 1, 20) : current.maxLoopTurns,
    declineKeywords: updates.declineKeywords ? normalizeStringArray(updates.declineKeywords, "declineKeywords", 100, 120) : current.declineKeywords,
    personality: updates.personality !== undefined ? normalizePersonality(updates.personality) : current.personality,
    learningEnabled: updates.learningEnabled !== undefined ? normalizeBoolean(updates.learningEnabled, "learningEnabled") : current.learningEnabled,
    studyIntervalMs: updates.studyIntervalMs !== undefined ? normalizeInteger(updates.studyIntervalMs, "studyIntervalMs", 60_000, 86_400_000) : current.studyIntervalMs,
    agentCashEnabled: updates.agentCashEnabled !== undefined ? normalizeBoolean(updates.agentCashEnabled, "agentCashEnabled") : current.agentCashEnabled,
    security: updates.security ? normalizeSecurityConfigUpdate(updates.security, current.security) : current.security,
    orchestration: updates.orchestration ? normalizeOrchestrationConfigUpdate(updates.orchestration, current.orchestration) : current.orchestration,
  };
}
async function handleConfigUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  helpers: ServerHelpers,
  restartHeartbeat: () => Promise<void>,
  requestId: string,
) {
  const current = ctx.config ?? loadConfig();
  if (!current) {
    json(res, { error: "No config" }, 400);
    return;
  }

  const updates = parseJsonBody<Partial<CashClawConfig>>(await readBody(req));
  ctx.config = savePartialConfig(applyConfigUpdates(current, updates));

  if (ctx.mode === "running" && isConfigured()) {
    await restartHeartbeat();
  }

  helpers.queueBroadcast();
  appendAuditEvent({
    actor: "operator",
    category: "config",
    action: "update",
    outcome: "success",
    message: "Configuration updated",
    requestId,
    metadata: { updatedFields: Object.keys(updates).sort() },
  });
  json(res, { ok: true, config: maskConfig(ctx.config) });
}

async function handleWallet(res: http.ServerResponse) {
  try {
    json(res, await getWalletInfoCached(true));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, { error: message }, 500);
  }
}

async function handleAgentInfo(res: http.ServerResponse) {
  try {
    const wallet = await cli.walletShow();
    json(res, { agent: await cli.getAgentByWallet(wallet.address) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, { error: message }, 500);
  }
}

async function handleAgentCashBalance(res: http.ServerResponse, ctx: ServerContext) {
  if (!ctx.config?.agentCashEnabled) {
    json(res, { error: "AgentCash not enabled" }, 400);
    return;
  }
  try {
    const balance = await getAgentCashBalanceCached(ctx.config, true);
    json(res, balance);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, { error: message }, 500);
  }
}

async function handleEthPrice(res: http.ServerResponse) {
  try {
    json(res, { price: await getEthPriceCached(true) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, { error: message }, 502);
  }
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  queueBroadcast: () => void,
  requestId: string,
) {
  const body = parseJsonBody(await readBody(req)) as { message: string };
  const userMessage = expectNonEmptyString(body.message, "message", 4000);

  if (!ctx.config) {
    json(res, { error: "Not configured" }, 400);
    return;
  }

  appendChat({ role: "user", content: userMessage, timestamp: Date.now() });
  queueBroadcast();

  try {
    const llm = createLLMProvider(ctx.config.llm);
    const specialties = ctx.config.specialties.length > 0 ? ctx.config.specialties.join(", ") : "general tasks";
    const knowledge = getRelevantKnowledge(ctx.config.specialties, 5);
    const stats = getFeedbackStats();
    const heartbeatState = ctx.heartbeat?.state;
    const personality = ctx.config.personality
      ? `\nOperator style: tone=${ctx.config.personality.tone}, response_style=${ctx.config.personality.responseStyle}.${ctx.config.personality.customInstructions ? ` Custom instructions: ${ctx.config.personality.customInstructions}` : ""}`
      : "";
    const knowledgeSection = knowledge.length > 0
      ? `\nRecent retained knowledge:\n${knowledge.map((entry) => `- ${entry.insight.slice(0, 200)}`).join("\n")}`
      : "";

    const systemPrompt = `You are Cateo (agent \"${ctx.config.agentId}\"), the operator-facing control assistant for this runtime.\nYour specialties are: ${specialties}.\nStatus: ${heartbeatState?.running ? "RUNNING" : "STOPPED"}.\nLive transport: ${heartbeatState?.wsConnected ? "CONNECTED" : "FALLBACK"}.\nStudy sessions: ${heartbeatState?.totalStudySessions ?? 0}.\nKnowledge entries: ${loadKnowledge().length}.\nTasks completed: ${stats.totalTasks}. Average score: ${stats.avgScore}/5.${personality}\nBe concise, factual, and grounded in the actual runtime state.${knowledgeSection}`;

    const history = loadChat().slice(-20);
    const response = await llm.chat([
      { role: "system", content: systemPrompt },
      ...history.map((message) => ({ role: message.role, content: message.content })),
    ]);
    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    appendChat({ role: "assistant", content: text, timestamp: Date.now() });
    queueBroadcast();
    appendAuditEvent({
      actor: "operator",
      category: "chat",
      action: "message",
      outcome: "success",
      message: "Operator chat exchange completed",
      requestId,
      metadata: { promptLength: userMessage.length, replyLength: text.length },
    });
    json(res, { reply: text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAuditEvent({ actor: "operator", category: "chat", action: "message", outcome: "error", severity: "error", message: `Operator chat failed: ${message}`, requestId });
    json(res, { error: message }, 500);
  }
}

async function handleKnowledgeDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  queueBroadcast: () => void,
  requestId: string,
) {
  const body = parseJsonBody<{ id: string }>(await readBody(req));
  const id = expectNonEmptyString(body.id, "id", 200);
  const deleted = deleteKnowledge(id);
  if (!deleted) {
    json(res, { error: "Entry not found" }, 404);
    return;
  }
  queueBroadcast();
  appendAuditEvent({ actor: "operator", category: "knowledge", action: "delete", outcome: "success", message: `Deleted knowledge entry ${id}`, requestId });
  json(res, { ok: true });
}

async function handleApprovalDecision(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  queueBroadcast: () => void,
  requestId: string,
  approve: boolean,
) {
  const body = parseJsonBody<{ id: string; note?: string }>(await readBody(req));
  const id = expectNonEmptyString(body.id, "id", 200);
  const note = normalizeOptionalString(body.note, "note", 1000);
  const approval = getApproval(id);

  if (!approval) {
    json(res, { error: "Approval not found" }, 404);
    return;
  }
  if (approval.status !== "pending") {
    json(res, { error: `Approval is already ${approval.status}` }, 409);
    return;
  }

  if (!approve) {
    const updated = updateApproval(id, "rejected", note, "Rejected by operator");
    appendAuditEvent({ actor: "operator", category: "approval", action: "reject", outcome: "success", message: `Rejected approval ${id}`, approvalId: id, taskId: approval.taskId, requestId, metadata: { toolName: approval.toolName, note } });
    queueBroadcast();
    json(res, { ok: true, approval: updated });
    return;
  }

  if (!ctx.config) {
    json(res, { error: "Agent not configured" }, 400);
    return;
  }

  let task: Task | null = null;
  if (approval.taskId) {
    task = await cli.getTask(approval.taskId).catch(() => null);
    if (!task) {
      const updated = updateApproval(id, "expired", note, "Task is no longer available");
      appendAuditEvent({ actor: "operator", category: "approval", action: "approve", outcome: "expired", severity: "warn", message: `Approval ${id} expired because task is no longer available`, approvalId: id, taskId: approval.taskId, requestId, metadata: { toolName: approval.toolName } });
      queueBroadcast();
      json(res, { ok: false, approval: updated, error: "Task is no longer available" }, 409);
      return;
    }
    if (approval.taskVersion && getTaskVersion(task) !== approval.taskVersion) {
      const updated = updateApproval(id, "expired", note, "Task changed since approval was requested");
      appendAuditEvent({ actor: "operator", category: "approval", action: "approve", outcome: "expired", severity: "warn", message: `Approval ${id} expired because task state changed`, approvalId: id, taskId: approval.taskId, requestId, metadata: { toolName: approval.toolName } });
      queueBroadcast();
      json(res, { ok: false, approval: updated, error: "Task state changed; review and request approval again" }, 409);
      return;
    }
  } else {
    task = buildSyntheticTask((approval.taskStatus as Task["status"] | undefined) ?? "requested", ctx.config.agentId);
  }

  const result = await executeTool(approval.toolName, approval.input, {
    config: ctx.config,
    taskId: approval.taskId ?? task.id,
    task,
    operatorApproved: true,
    requestApproval: () => ({ id, created: false }),
    recordAudit: (event) => {
      appendAuditEvent({
        actor: "operator",
        category: event.category,
        action: event.action,
        outcome: event.outcome,
        severity: event.severity,
        message: event.message,
        approvalId: id,
        taskId: approval.taskId ?? task.id,
        requestId,
        metadata: event.metadata,
      });
    },
  });

  const updated = updateApproval(id, result.success ? "executed" : "failed", note, result.data);
  appendAuditEvent({
    actor: "operator",
    category: "approval",
    action: "approve",
    outcome: result.success ? "success" : "failed",
    severity: result.success ? "info" : "warn",
    message: result.success ? `Executed approval ${id}` : `Approval ${id} failed during execution`,
    approvalId: id,
    taskId: approval.taskId,
    requestId,
    metadata: { toolName: approval.toolName, note, result: result.data },
  });
  queueBroadcast();
  if (result.success) {
    ctx.heartbeat?.syncNow("Operator approval executed");
  }
  json(res, { ok: result.success, approval: updated, result: result.data });
}

function serveStatic(pathname: string, res: http.ServerResponse) {
  const baseDir = import.meta.dirname;
  const distUi = path.join(baseDir, "..", "dist", "ui");
  const uiDir = fs.existsSync(path.join(distUi, "index.html")) ? distUi : path.join(baseDir, "ui");
  const resolvedUiDir = path.resolve(uiDir);
  let filePath = path.resolve(uiDir, pathname === "/" ? "index.html" : pathname.slice(1));

  if (!filePath.startsWith(resolvedUiDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!path.extname(filePath)) {
    filePath = path.join(resolvedUiDir, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
  };

  res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}





