const BASE = "";
const CSRF_COOKIE = "cateo_csrf";
const CSRF_HEADER = "X-Cateo-CSRF";

let bootstrapCache: BootstrapData | null = null;
let bootstrapPromise: Promise<BootstrapData> | null = null;

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

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function getWithSession<T>(path: string, forceRefresh = false): Promise<T> {
  await getBootstrap(forceRefresh);
  const res = await fetch(`${BASE}${path}`, { credentials: "same-origin" });
  if (res.status === 403 && !forceRefresh) {
    bootstrapCache = null;
    await getBootstrap(true);
    return getWithSession<T>(path, true);
  }
  return parseResponse<T>(res);
}

async function postWithSession<T>(path: string, body?: unknown, forceRefresh = false): Promise<T> {
  await getBootstrap(forceRefresh);
  const csrf = readCookie(CSRF_COOKIE);
  if (!csrf) {
    if (!forceRefresh) {
      bootstrapCache = null;
      await getBootstrap(true);
      return postWithSession<T>(path, body, true);
    }
    throw new Error("Missing CSRF token");
  }

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      [CSRF_HEADER]: csrf,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 403 && !forceRefresh) {
    bootstrapCache = null;
    await getBootstrap(true);
    return postWithSession<T>(path, body, true);
  }

  return parseResponse<T>(res);
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

  const pending = fetch(`${BASE}/api/bootstrap`, { credentials: "same-origin" })
    .then((res) => parseResponse<BootstrapData>(res))
    .then((data) => {
      bootstrapCache = data;
      bootstrapPromise = null;
      return data;
    })
    .catch((err) => {
      bootstrapPromise = null;
      if (force) {
        bootstrapCache = null;
      }
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

