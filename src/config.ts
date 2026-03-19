import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteProtectedSecret, readProtectedSecret, writeProtectedSecret } from "./security/secure_store.js";
import { getConfigPath } from "./system/runtime_paths.js";

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
}

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
  const llmProvider = parsed.llm?.provider ?? "anthropic";
  const llm: LLMConfig = {
    provider: llmProvider,
    model: parsed.llm?.model ?? "",
    apiKey: requiresApiKey(llmProvider)
      ? (plainApiKey ?? llmFromSecret ?? "")
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
      provider: "anthropic",
      model: "",
      apiKey: "",
    },
    ...existing,
    ...partial,
    security: mergeSecurityConfig(partial.security ?? existing?.security),
    orchestration: mergeOrchestrationConfig(partial.orchestration ?? existing?.orchestration),
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
    openai: "gpt-4o",
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
