const BASE = "";
const CSRF_COOKIE = "cateo_csrf";
const CSRF_HEADER = "X-Cateo-CSRF";

let bootstrapCache: BootstrapData | null = null;
let bootstrapPromise: Promise<BootstrapData> | null = null;
let authSessionCache: AuthSessionData | null = null;
let authSessionPromise: Promise<AuthSessionData> | null = null;

export interface OperatorIdentityData {
  username: string;
  role: "admin" | "reviewer" | "analyst" | "viewer";
}

export interface AuthSessionData {
  enabled: boolean;
  authenticated: boolean;
  operator: OperatorIdentityData | null;
  expiresAt: number | null;
}

interface ErrorPayload {
  error?: string;
  code?: string;
  retryAfterSeconds?: number | null;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfterSeconds?: number | null;

  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
  }
}

function readCookie(name: string): string | null {
  const parts = document.cookie.split(/;\s*/).filter(Boolean);
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator) === name) {
      return decodeURIComponent(part.slice(separator + 1));
    }
  }
  return null;
}

export function clearClientSessionCaches(): void {
  bootstrapCache = null;
  bootstrapPromise = null;
  authSessionCache = null;
  authSessionPromise = null;
}

async function parseResponse<T>(res: Response): Promise<T> {
  const raw = await res.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      if (!res.ok) {
        throw new ApiError(raw || res.statusText || `API ${res.status}`, res.status);
      }
      return raw as T;
    }
  }

  if (!res.ok) {
    const body = (parsed && typeof parsed === "object" ? parsed : {}) as ErrorPayload;
    throw new ApiError(body.error ?? res.statusText ?? `API ${res.status}`, res.status, body.code, body.retryAfterSeconds ?? null);
  }

  return parsed as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "same-origin" });
  return parseResponse<T>(res);
}

async function postJson<T>(path: string, body?: unknown, csrfToken?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (csrfToken) {
    headers[CSRF_HEADER] = csrfToken;
  }
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseResponse<T>(res);
}

async function getWithSession<T>(path: string): Promise<T> {
  return getJson<T>(path);
}

async function postWithSession<T>(path: string, body?: unknown): Promise<T> {
  const csrf = readCookie(CSRF_COOKIE);
  if (!csrf) {
    throw new ApiError("Missing CSRF token", 403, "MISSING_CSRF");
  }
  return postJson<T>(path, body, csrf);
}

export async function getAuthSession(force = false): Promise<AuthSessionData> {
  if (!force && authSessionCache) {
    return authSessionCache;
  }
  if (!force && authSessionPromise) {
    return authSessionPromise;
  }

  const pending = getJson<AuthSessionData>("/api/auth/session")
    .then((data) => {
      authSessionCache = data;
      authSessionPromise = null;
      return data;
    })
    .catch((err) => {
      authSessionPromise = null;
      if (force) {
        authSessionCache = null;
      }
      throw err;
    });

  authSessionPromise = pending;
  return pending;
}
export interface StatusData {
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

export interface ActivityEvent {
  timestamp: number;
  type: string;
  taskId?: string;
  message: string;
}

export interface TaskData {
  id: string;
  task: string;
  status: string;
  quotedPriceWei?: string;
  ratedScore?: number;
  result?: string;
}

export interface StatsData {
  totalTasks: number;
  avgScore: number;
  completionRate: number;
  studySessions: number;
  knowledgeEntries: number;
}

export interface KnowledgeEntry {
  id: string;
  topic: string;
  specialty: string;
  insight: string;
  source: string;
  timestamp: number;
}

export interface FeedbackEntry {
  taskId: string;
  taskDescription: string;
  score: number;
  comments: string;
  timestamp: number;
}

export interface PersonalityData {
  tone: "professional" | "casual" | "friendly" | "technical";
  responseStyle: "concise" | "detailed" | "balanced";
  customInstructions?: string;
}

export interface PollingData {
  intervalMs: number;
  urgentIntervalMs: number;
}

export type AgentCashAccessClass = "research" | "social" | "media" | "outbound";

export interface ApprovalPolicyData {
  quotes: boolean;
  declines: boolean;
  clientMessages: boolean;
  submissions: boolean;
  bountyClaims: boolean;
  agentCash: boolean;
}

export interface PersistencePolicyData {
  persistOperatorChat: boolean;
  persistKnowledge: boolean;
  persistFeedback: boolean;
  persistDatasets: boolean;
  persistActivityLog: boolean;
  auditRetentionDays: number;
}

export interface AgentCashPolicyData {
  maxUsdPerCall: number;
  maxUsdPerTask: number;
  allowedClasses: AgentCashAccessClass[];
}

export interface SecurityData {
  approvalPolicy: ApprovalPolicyData;
  persistence: PersistencePolicyData;
  agentCashPolicy: AgentCashPolicyData;
}

export interface ConfigData {
  agentId: string;
  llm: { provider: string; model: string; apiKey?: string; baseUrl?: string };
  specialties: string[];
  pricing: { strategy: string; baseRateEth: string; maxRateEth: string };
  autoQuote: boolean;
  autoWork: boolean;
  maxConcurrentTasks: number;
  maxLoopTurns?: number;
  declineKeywords: string[];
  learningEnabled: boolean;
  studyIntervalMs: number;
  personality?: PersonalityData;
  polling: PollingData;
  agentCashEnabled: boolean;
  security: SecurityData;
}

export interface AgentCashBalance {
  address: string;
  balance: string;
  network: string;
}

export interface SetupStatus {
  configured: boolean;
  mode: "setup" | "running";
  step: string;
}

export interface WalletInfo {
  address: string;
  balance?: string;
}

export interface RegisterResult {
  agentId: string;
  registryTxHash?: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  flaunchUrl?: string;
  tokenTxHash?: string;
  registrationStatus?: "pending" | "approved" | "unknown";
}

export interface AgentInfo {
  agentId: string;
  name: string;
  description: string;
  skills: string[];
  priceEth: string;
  owner: string;
  flaunchToken?: string;
  reputation?: number;
}

export interface LLMTestResult {
  ok: boolean;
  response: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type ApprovalStatus = "pending" | "executed" | "rejected" | "failed" | "expired";

export interface ApprovalData {
  id: string;
  status: ApprovalStatus;
  toolName: string;
  summary: string;
  reason: string;
  input: Record<string, unknown>;
  taskId?: string;
  taskStatus?: string;
  taskVersion?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  outcome?: string;
  decisionNote?: string;
}

export type AuditSeverity = "info" | "warn" | "error";

export interface AuditEntry {
  id: string;
  timestamp: number;
  actor: "operator" | "runtime" | "model" | "server" | "system";
  category: string;
  action: string;
  outcome: string;
  message: string;
  severity: AuditSeverity;
  requestId?: string;
  taskId?: string;
  approvalId?: string;
  metadata?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface CommandCenterValuePoint {
  label: string;
  value: number;
}

export interface CommandCenterTrendPoint {
  label: string;
  artifacts: number;
  revisions: number;
  interactions: number;
  approvals: number;
}

export interface CommandCenterAlert {
  level: "info" | "warn" | "critical";
  title: string;
  detail: string;
}

export interface CommandCenterFeedItem {
  id: string;
  timestamp: number;
  type: string;
  title: string;
  detail: string;
  severity: "info" | "warn" | "error";
}

export interface CommandCenterData {
  generatedAt: number;
  seeded: boolean;
  totals: {
    artifacts: number;
    revisions: number;
    approved: number;
    reviewed: number;
    draft: number;
    cases: number;
    highRiskCases: number;
    lowConfidenceOutputs: number;
    unresolvedItems: number;
    validationFailures: number;
    retries: number;
    escalations: number;
    profiles: number;
    vectorEntries: number;
  };
  growth: {
    artifacts: number;
    revisions: number;
    interactions: number;
  };
  trend: CommandCenterTrendPoint[];
  topFailureModes: CommandCenterValuePoint[];
  topAssets: CommandCenterValuePoint[];
  approvalStates: CommandCenterValuePoint[];
  modelValidation: {
    successRate: number;
    failureRate: number;
    retryCount: number;
    escalationCount: number;
  };
  health: {
    ingestionStatus: string;
    documentCoveragePct: number;
    queueDepth: number;
    auditErrors: number;
  };
  alerts: CommandCenterAlert[];
  recentActivity: CommandCenterFeedItem[];
}
export interface LiveRuntimeSnapshot {
  status: StatusData | null;
  tasks: TaskData[];
  events: ActivityEvent[];
  stats: StatsData;
  wallet: WalletInfo | null;
  knowledge: KnowledgeEntry[];
  feedback: FeedbackEntry[];
  chat: ChatMessage[];
  approvals: ApprovalData[];
  audit: AuditEntry[];
  config: ConfigData | null;
  commandCenter: CommandCenterData;
}

export interface BootstrapData {
  type: "snapshot";
  configured: boolean;
  mode: "setup" | "running";
  step: string;
  snapshot: LiveRuntimeSnapshot;
}

export interface LiveSnapshotEnvelope {
  type: "snapshot";
  configured: boolean;
  mode: "setup" | "running";
  step: string;
  snapshot: LiveRuntimeSnapshot;
}

export async function getBootstrap(force = false): Promise<BootstrapData> {
  if (!force && bootstrapCache) {
    return bootstrapCache;
  }
  if (!force && bootstrapPromise) {
    return bootstrapPromise;
  }

  const pending = getJson<BootstrapData>("/api/bootstrap")
    .then((data) => {
      bootstrapCache = data;
      bootstrapPromise = null;
      return data;
    })
    .catch((err) => {
      bootstrapCache = null;
      bootstrapPromise = null;
      throw err;
    });

  bootstrapPromise = pending;
  return pending;
}

export function getLiveUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const csrf = readCookie(CSRF_COOKIE);
  if (!csrf) {
    throw new Error("Missing CSRF token for live connection");
  }
  return `${protocol}://${window.location.host}/api/live?csrf=${encodeURIComponent(csrf)}`;
}

export const api = {
  getAuthSession,
  login: async (username: string, password: string) => {
    const session = await postJson<AuthSessionData>("/api/auth/login", { username, password });
    authSessionCache = session;
    bootstrapCache = null;
    bootstrapPromise = null;
    return session;
  },
  logout: async () => {
    const result = await postWithSession<{ ok: boolean }>("/api/auth/logout");
    clearClientSessionCaches();
    return result;
  },
  getStatus: () => getWithSession<StatusData>("/api/status"),
  getTasks: () => getWithSession<{ tasks: TaskData[]; events: ActivityEvent[] }>("/api/tasks"),
  getLogs: () => getWithSession<{ log: string }>("/api/logs"),
  getConfig: () => getWithSession<ConfigData>("/api/config"),
  getStats: () => getWithSession<StatsData>("/api/stats"),
  getKnowledge: () => getWithSession<{ entries: KnowledgeEntry[] }>("/api/knowledge"),
  deleteKnowledge: (id: string) => postWithSession<{ ok: boolean }>("/api/knowledge/delete", { id }),
  getFeedback: () => getWithSession<{ entries: FeedbackEntry[] }>("/api/feedback"),
  getAudit: () => getWithSession<{ entries: AuditEntry[] }>("/api/audit"),
  getApprovals: () => getWithSession<{ entries: ApprovalData[] }>("/api/approvals"),
  approveAction: (id: string, note?: string) => postWithSession<{ ok: boolean; approval: ApprovalData | null; result?: string }>("/api/approvals/approve", { id, note }),
  rejectAction: (id: string, note?: string) => postWithSession<{ ok: boolean; approval: ApprovalData | null }>("/api/approvals/reject", { id, note }),
  stop: () => postWithSession<{ ok: boolean }>("/api/stop"),
  start: () => postWithSession<{ ok: boolean }>("/api/start"),
  updateConfig: (updates: Partial<ConfigData>) => postWithSession<{ ok: boolean }>("/api/config-update", updates),
  getChat: () => getWithSession<{ messages: ChatMessage[] }>("/api/chat"),
  sendChat: (message: string) => postWithSession<{ reply: string }>("/api/chat", { message }),
  clearChat: () => postWithSession<{ ok: boolean }>("/api/chat/clear"),
  getAgentInfo: () => getWithSession<{ agent: AgentInfo | null }>("/api/agent-info"),
  getWalletCached: () => getWithSession<WalletInfo>("/api/wallet"),
  getAgentCashBalance: () => getWithSession<AgentCashBalance>("/api/agentcash-balance"),
  getEthPrice: () => getWithSession<{ price: number }>("/api/eth-price"),

  getSetupStatus: async () => {
    const { configured, mode, step } = await getBootstrap();
    return { configured, mode, step } satisfies SetupStatus;
  },
  getWallet: () => getWithSession<WalletInfo>("/api/setup/wallet"),
  importWallet: (privateKey: string) => postWithSession<WalletInfo>("/api/setup/wallet/import", { privateKey }),
  lookupAgent: () => postWithSession<{ agent: AgentInfo | null }>("/api/setup/agent-lookup"),
  registerAgent: (opts: {
    name: string;
    description: string;
    skills: string[];
    price: string;
    symbol?: string;
    token?: string;
    image?: string;
    website?: string;
  }) => postWithSession<RegisterResult>("/api/setup/register", opts),
  saveLLM: (llm: { provider: string; model: string; apiKey?: string; baseUrl?: string }) =>
    postWithSession<{ ok: boolean }>("/api/setup/llm", llm),
  testLLM: (llm: { provider: string; model: string; apiKey?: string; baseUrl?: string }) =>
    postWithSession<LLMTestResult>("/api/setup/llm/test", llm),
  saveSpecialization: (spec: {
    specialties: string[];
    pricing: { strategy: string; baseRateEth: string; maxRateEth: string };
    autoQuote: boolean;
    autoWork: boolean;
    maxConcurrentTasks: number;
    declineKeywords: string[];
  }) => postWithSession<{ ok: boolean }>("/api/setup/specialization", spec),
  completeSetup: () => postWithSession<{ ok: boolean; mode: string }>("/api/setup/complete"),
};
