import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteProtectedSecret, readProtectedSecret, writeProtectedSecret } from "./security/secure_store.js";
import { getConfigPath } from "./system/runtime_paths.js";
import { loadRuntimeEnv } from "./system/env.js";

export type LLMProviderName = "anthropic" | "openai" | "openrouter" | "ollama";
export type AgentCashAccessClass = "research" | "social" | "media" | "outbound";
export type OrchestrationMode = "adaptive" | "always" | "never";

export interface LLMConfig {
  provider: LLMProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface PricingConfig {
  strategy: "fixed" | "complexity";
  baseRateEth: string;
  maxRateEth: string;
}

export interface PollingConfig {
  intervalMs: number;
  urgentIntervalMs: number;
}

export interface PersonalityConfig {
  tone: "professional" | "casual" | "friendly" | "technical";
  responseStyle: "concise" | "detailed" | "balanced";
  customInstructions?: string;
}

export interface ApprovalPolicyConfig {
  quotes: boolean;
  declines: boolean;
  clientMessages: boolean;
  submissions: boolean;
  bountyClaims: boolean;
  agentCash: boolean;
}

export interface PersistencePolicyConfig {
  persistOperatorChat: boolean;
  persistKnowledge: boolean;
  persistFeedback: boolean;
  persistDatasets: boolean;
  persistActivityLog: boolean;
  auditRetentionDays: number;
}

export interface AgentCashPolicyConfig {
  maxUsdPerCall: number;
  maxUsdPerTask: number;
  allowedClasses: AgentCashAccessClass[];
}

export interface SecurityConfig {
  approvalPolicy: ApprovalPolicyConfig;
  persistence: PersistencePolicyConfig;
  agentCashPolicy: AgentCashPolicyConfig;
}

export interface LocalLeadModelConfig {
  model: string;
  baseUrl: string;
}

export interface LocalSupportModelConfig {
  enabled: boolean;
  mode: OrchestrationMode;
  model: string;
  baseUrl: string;
}

export interface OrchestrationConfig {
  enabled: boolean;
  lead: LocalLeadModelConfig;
  challenger: LocalSupportModelConfig;
  structure: LocalSupportModelConfig;
}

export interface PilotHostedRoleModelsConfig {
  lead?: string;
  challenger?: string;
  structure?: string;
  study?: string;
}

export interface PilotQuotaConfig {
  enabled: boolean;
  dailyRequestLimit: number;
  dailyInputTokenLimit: number;
  dailyOutputTokenLimit: number;
  dailyTotalTokenLimit: number;
  reservationTokensPerJob: number;
  maxPendingJobsPerProfile: number;
  maxPromptChars: number;
}

export interface PilotConfig {
  enabled: boolean;
  allowAnonymousProfiles: boolean;
  requireVerifiedEmail: boolean;
  sessionTtlDays: number;
  hostedRoleModels: PilotHostedRoleModelsConfig;
  quota: PilotQuotaConfig;
}

export interface CashClawConfig {
  agentId: string;
  llm: LLMConfig;
  polling: PollingConfig;
  pricing: PricingConfig;
  specialties: string[];
  autoQuote: boolean;
  autoWork: boolean;
  maxConcurrentTasks: number;
  maxLoopTurns?: number;
  declineKeywords: string[];
  personality?: PersonalityConfig;
  learningEnabled: boolean;
  studyIntervalMs: number;
  agentCashEnabled: boolean;
  security: SecurityConfig;
  orchestration: OrchestrationConfig;
  pilot?: PilotConfig;
}

loadRuntimeEnv();

const LLM_SECRET_NAME = "llm-api-key";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
  enabled: true,
  lead: {
    model: "qwen3:8b",
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
  },
  challenger: {
    enabled: true,
    mode: "adaptive",
    model: "llama3.3",
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
  },
  structure: {
    enabled: true,
    mode: "adaptive",
    model: "qwen2.5-coder:14b",
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
  },
};

const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  approvalPolicy: {
    quotes: true,
    declines: true,
    clientMessages: true,
    submissions: true,
    bountyClaims: true,
    agentCash: true,
  },
  persistence: {
    persistOperatorChat: false,
    persistKnowledge: true,
    persistFeedback: true,
    persistDatasets: false,
    persistActivityLog: true,
    auditRetentionDays: 90,
  },
  agentCashPolicy: {
    maxUsdPerCall: 0.05,
    maxUsdPerTask: 0.25,
    allowedClasses: ["research", "social"],
  },
};

const DEFAULT_PILOT_CONFIG: PilotConfig = {
  enabled: true,
  allowAnonymousProfiles: true,
  requireVerifiedEmail: false,
  sessionTtlDays: 365,
  hostedRoleModels: {},
  quota: {
    enabled: true,
    dailyRequestLimit: 8,
    dailyInputTokenLimit: 80_000,
    dailyOutputTokenLimit: 80_000,
    dailyTotalTokenLimit: 120_000,
    reservationTokensPerJob: 10_000,
    maxPendingJobsPerProfile: 2,
    maxPromptChars: 8_000,
  },
};

const DEFAULT_CONFIG: Omit<CashClawConfig, "agentId" | "llm"> = {
  polling: { intervalMs: 30000, urgentIntervalMs: 10000 },
  pricing: { strategy: "fixed", baseRateEth: "0.005", maxRateEth: "0.05" },
  specialties: [],
  autoQuote: true,
  autoWork: true,
  maxConcurrentTasks: 3,
  declineKeywords: [],
  learningEnabled: true,
  studyIntervalMs: 1_800_000,
  agentCashEnabled: false,
  security: DEFAULT_SECURITY_CONFIG,
  orchestration: DEFAULT_ORCHESTRATION_CONFIG,
  pilot: DEFAULT_PILOT_CONFIG,
};

function getDefaultConfigPath(): string {
  return getConfigPath();
}

function requiresApiKey(provider: LLMProviderName): boolean {
  return provider !== "ollama";
}

function normalizeLocalUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return (trimmed || fallback).replace(/\/+$/, "");
}

function normalizeMode(value: unknown, fallback: OrchestrationMode): OrchestrationMode {
  return value === "adaptive" || value === "always" || value === "never"
    ? value
    : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function mergeSecurityConfig(partial?: Partial<SecurityConfig>): SecurityConfig {
  return {
    approvalPolicy: {
      ...DEFAULT_SECURITY_CONFIG.approvalPolicy,
      ...partial?.approvalPolicy,
    },
    persistence: {
      ...DEFAULT_SECURITY_CONFIG.persistence,
      ...partial?.persistence,
    },
    agentCashPolicy: {
      ...DEFAULT_SECURITY_CONFIG.agentCashPolicy,
      ...partial?.agentCashPolicy,
      allowedClasses: partial?.agentCashPolicy?.allowedClasses ?? DEFAULT_SECURITY_CONFIG.agentCashPolicy.allowedClasses,
    },
  };
}

function mergePilotConfig(partial?: Partial<PilotConfig>): PilotConfig {
  return {
    enabled: partial?.enabled ?? DEFAULT_PILOT_CONFIG.enabled,
    allowAnonymousProfiles: partial?.allowAnonymousProfiles ?? DEFAULT_PILOT_CONFIG.allowAnonymousProfiles,
    requireVerifiedEmail: partial?.requireVerifiedEmail ?? DEFAULT_PILOT_CONFIG.requireVerifiedEmail,
    sessionTtlDays: normalizePositiveInteger(partial?.sessionTtlDays, DEFAULT_PILOT_CONFIG.sessionTtlDays, 1, 3650),
    hostedRoleModels: {
      lead: partial?.hostedRoleModels?.lead?.trim() || DEFAULT_PILOT_CONFIG.hostedRoleModels.lead,
      challenger: partial?.hostedRoleModels?.challenger?.trim() || DEFAULT_PILOT_CONFIG.hostedRoleModels.challenger,
      structure: partial?.hostedRoleModels?.structure?.trim() || DEFAULT_PILOT_CONFIG.hostedRoleModels.structure,
      study: partial?.hostedRoleModels?.study?.trim() || DEFAULT_PILOT_CONFIG.hostedRoleModels.study,
    },
    quota: {
      enabled: partial?.quota?.enabled ?? DEFAULT_PILOT_CONFIG.quota.enabled,
      dailyRequestLimit: normalizePositiveInteger(partial?.quota?.dailyRequestLimit, DEFAULT_PILOT_CONFIG.quota.dailyRequestLimit, 1, 10_000),
      dailyInputTokenLimit: normalizePositiveInteger(partial?.quota?.dailyInputTokenLimit, DEFAULT_PILOT_CONFIG.quota.dailyInputTokenLimit, 1_000, 50_000_000),
      dailyOutputTokenLimit: normalizePositiveInteger(partial?.quota?.dailyOutputTokenLimit, DEFAULT_PILOT_CONFIG.quota.dailyOutputTokenLimit, 1_000, 50_000_000),
      dailyTotalTokenLimit: normalizePositiveInteger(partial?.quota?.dailyTotalTokenLimit, DEFAULT_PILOT_CONFIG.quota.dailyTotalTokenLimit, 1_000, 50_000_000),
      reservationTokensPerJob: normalizePositiveInteger(partial?.quota?.reservationTokensPerJob, DEFAULT_PILOT_CONFIG.quota.reservationTokensPerJob, 256, 10_000_000),
      maxPendingJobsPerProfile: normalizePositiveInteger(partial?.quota?.maxPendingJobsPerProfile, DEFAULT_PILOT_CONFIG.quota.maxPendingJobsPerProfile, 1, 100),
      maxPromptChars: normalizePositiveInteger(partial?.quota?.maxPromptChars, DEFAULT_PILOT_CONFIG.quota.maxPromptChars, 200, 500_000),
    },
  };
}

function mergeOrchestrationConfig(partial?: Partial<OrchestrationConfig>): OrchestrationConfig {
  return {
    enabled: partial?.enabled ?? DEFAULT_ORCHESTRATION_CONFIG.enabled,
    lead: {
      model: partial?.lead?.model?.trim() || DEFAULT_ORCHESTRATION_CONFIG.lead.model,
      baseUrl: normalizeLocalUrl(partial?.lead?.baseUrl, DEFAULT_ORCHESTRATION_CONFIG.lead.baseUrl),
    },
    challenger: {
      enabled: partial?.challenger?.enabled ?? DEFAULT_ORCHESTRATION_CONFIG.challenger.enabled,
      mode: normalizeMode(partial?.challenger?.mode, DEFAULT_ORCHESTRATION_CONFIG.challenger.mode),
      model: partial?.challenger?.model?.trim() || DEFAULT_ORCHESTRATION_CONFIG.challenger.model,
      baseUrl: normalizeLocalUrl(partial?.challenger?.baseUrl, DEFAULT_ORCHESTRATION_CONFIG.challenger.baseUrl),
    },
    structure: {
      enabled: partial?.structure?.enabled ?? DEFAULT_ORCHESTRATION_CONFIG.structure.enabled,
      mode: normalizeMode(partial?.structure?.mode, DEFAULT_ORCHESTRATION_CONFIG.structure.mode),
      model: partial?.structure?.model?.trim() || DEFAULT_ORCHESTRATION_CONFIG.structure.model,
      baseUrl: normalizeLocalUrl(partial?.structure?.baseUrl, DEFAULT_ORCHESTRATION_CONFIG.structure.baseUrl),
    },
  };
}

function normalizeConfig(parsed: Partial<CashClawConfig>): CashClawConfig {
  const plainApiKey = parsed.llm?.apiKey;
  if (plainApiKey) {
    writeProtectedSecret(LLM_SECRET_NAME, plainApiKey);
  }

  const llmFromSecret = readProtectedSecret(LLM_SECRET_NAME);
  const llmProvider = parsed.llm?.provider ?? "openai";
  const llmFromEnv = llmProvider === "openai"
    ? process.env.OPENAI_API_KEY?.trim()
    : llmProvider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY?.trim()
      : llmProvider === "openrouter"
        ? process.env.OPENROUTER_API_KEY?.trim()
        : undefined;
  const llm: LLMConfig = {
    provider: llmProvider,
    model: parsed.llm?.model ?? "",
    apiKey: requiresApiKey(llmProvider)
      ? (plainApiKey ?? llmFromSecret ?? llmFromEnv ?? "")
      : undefined,
    baseUrl: parsed.llm?.baseUrl,
  };

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    agentId: parsed.agentId ?? "",
    llm,
    security: mergeSecurityConfig(parsed.security),
    orchestration: mergeOrchestrationConfig(parsed.orchestration),
    pilot: mergePilotConfig(parsed.pilot),
  };
}

export function loadConfig(): CashClawConfig | null {
  const configPath = getDefaultConfigPath();
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CashClawConfig>;
    if (!parsed || typeof parsed !== "object") return null;

    const normalized = normalizeConfig(parsed);

    if (parsed.llm?.apiKey) {
      saveConfig(normalized);
    }

    return normalized;
  } catch {
    return null;
  }
}

export function requireConfig(): CashClawConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error("No config found. Run `cashclaw init` first.");
  }
  return config;
}

export function saveConfig(config: CashClawConfig): void {
  const configPath = getDefaultConfigPath();
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const normalized = normalizeConfig(config);
  const apiKey = normalized.llm.apiKey?.trim();
  if (apiKey) {
    writeProtectedSecret(LLM_SECRET_NAME, apiKey);
  } else {
    deleteProtectedSecret(LLM_SECRET_NAME);
  }

  const persisted: CashClawConfig = {
    ...normalized,
    llm: {
      ...normalized.llm,
      apiKey: undefined,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(persisted, null, 2));
  fs.chmodSync(configPath, 0o600);
}

export function getSecurityConfig(config?: CashClawConfig | null): SecurityConfig {
  return mergeSecurityConfig(config?.security);
}

export function getOrchestrationConfig(config?: CashClawConfig | null): OrchestrationConfig {
  return mergeOrchestrationConfig(config?.orchestration);
}

export function getPilotConfig(config?: CashClawConfig | null): PilotConfig {
  return mergePilotConfig(config?.pilot);
}

export function isConfigured(): boolean {
  const config = loadConfig();
  if (!config) return false;
  if (!config.agentId || !config.llm?.provider || !config.llm?.model) return false;

  if (config.llm.provider === "ollama") {
    return Boolean(config.llm.baseUrl || DEFAULT_OLLAMA_BASE_URL);
  }

  return Boolean(config.llm.apiKey);
}

export function savePartialConfig(partial: Partial<CashClawConfig>): CashClawConfig {
  const existing = loadConfig();

  const config: CashClawConfig = normalizeConfig({
    ...DEFAULT_CONFIG,
    agentId: "",
    llm: {
      provider: "openai",
      model: "",
      apiKey: "",
    },
    ...existing,
    ...partial,
    security: mergeSecurityConfig(partial.security ?? existing?.security),
    orchestration: mergeOrchestrationConfig(partial.orchestration ?? existing?.orchestration),
    pilot: mergePilotConfig(partial.pilot ?? existing?.pilot),
  });

  saveConfig(config);
  return config;
}

export function initConfig(opts: {
  agentId: string;
  provider: LLMProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  specialties?: string[];
}): CashClawConfig {
  const modelDefaults: Record<LLMProviderName, string> = {
    anthropic: "claude-sonnet-4-20250514",
    openai: "gpt-4.1-mini",
    openrouter: "anthropic/claude-sonnet-4-20250514",
    ollama: "qwen3-coder-next",
  };

  const baseUrlDefaults: Partial<Record<LLMProviderName, string>> = {
    ollama: DEFAULT_OLLAMA_BASE_URL,
  };

  const llm: LLMConfig = {
    provider: opts.provider,
    model: opts.model ?? modelDefaults[opts.provider],
  };

  if (requiresApiKey(opts.provider)) {
    llm.apiKey = opts.apiKey ?? "";
  }

  if (opts.baseUrl ?? baseUrlDefaults[opts.provider]) {
    llm.baseUrl = opts.baseUrl ?? baseUrlDefaults[opts.provider];
  }

  const config: CashClawConfig = {
    ...DEFAULT_CONFIG,
    agentId: opts.agentId,
    llm,
    specialties: opts.specialties ?? [],
    security: mergeSecurityConfig(),
    orchestration: mergeOrchestrationConfig(),
    pilot: mergePilotConfig(),
  };

  saveConfig(config);
  return config;
}

export function getConfigDir(): string {
  return path.dirname(getDefaultConfigPath());
}

export function isAgentCashAvailable(): boolean {
  const walletPath = path.join(os.homedir(), ".agentcash", "wallet.json");
  return fs.existsSync(walletPath);
}

