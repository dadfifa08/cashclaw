import type { CashClawConfig, LLMConfig } from "../config.js";
import { getOrchestrationConfig, getPilotConfig } from "../config.js";
import { createLLMProvider } from "./index.js";
import type { LLMProvider } from "./types.js";

export type CateoRuntimeRole = "operator" | "lead" | "challenger" | "structure" | "study";

export interface CateoRuntimeModelInfo {
  role: CateoRuntimeRole;
  provider: LLMConfig["provider"];
  model: string;
  baseUrl?: string;
}

export interface CateoModelRuntime {
  operator: LLMProvider;
  lead: LLMProvider;
  challenger?: LLMProvider;
  structure?: LLMProvider;
  study: LLMProvider;
  meta: {
    orchestrationEnabled: boolean;
    operator: CateoRuntimeModelInfo;
    lead: CateoRuntimeModelInfo;
    challenger?: CateoRuntimeModelInfo;
    structure?: CateoRuntimeModelInfo;
    study: CateoRuntimeModelInfo;
  };
}

function toLocalRoleConfig(model: string, baseUrl: string): LLMConfig {
  return {
    provider: "ollama",
    model,
    baseUrl,
  };
}

function toSharedRoleConfig(config: CashClawConfig, role: Exclude<CateoRuntimeRole, "operator">): LLMConfig {
  const pilot = getPilotConfig(config);
  const modelOverride = role === "lead"
    ? pilot.hostedRoleModels.lead
    : role === "challenger"
      ? pilot.hostedRoleModels.challenger
      : role === "structure"
        ? pilot.hostedRoleModels.structure
        : pilot.hostedRoleModels.study;

  return {
    provider: config.llm.provider,
    model: modelOverride?.trim() || config.llm.model,
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
  };
}

function createRoleProvider(config: LLMConfig, role: CateoRuntimeRole): { provider: LLMProvider; meta: CateoRuntimeModelInfo } {
  return {
    provider: createLLMProvider(config),
    meta: {
      role,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
  };
}

export function createModelRuntime(config: CashClawConfig): CateoModelRuntime {
  const orchestration = getOrchestrationConfig(config);
  const operator = createLLMProvider(config.llm);
  const operatorMeta: CateoRuntimeModelInfo = {
    role: "operator",
    provider: config.llm.provider,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
  };

  if (!orchestration.enabled) {
    return {
      operator,
      lead: operator,
      study: operator,
      meta: {
        orchestrationEnabled: false,
        operator: operatorMeta,
        lead: { ...operatorMeta, role: "lead" },
        study: { ...operatorMeta, role: "study" },
      },
    };
  }

  const useLocalRoles = config.llm.provider === "ollama";
  const leadRole = createRoleProvider(
    useLocalRoles
      ? toLocalRoleConfig(orchestration.lead.model, orchestration.lead.baseUrl)
      : toSharedRoleConfig(config, "lead"),
    "lead",
  );

  const challengerRole = orchestration.challenger.enabled
    ? createRoleProvider(
        useLocalRoles
          ? toLocalRoleConfig(orchestration.challenger.model, orchestration.challenger.baseUrl)
          : toSharedRoleConfig(config, "challenger"),
        "challenger",
      )
    : undefined;

  const structureRole = orchestration.structure.enabled
    ? createRoleProvider(
        useLocalRoles
          ? toLocalRoleConfig(orchestration.structure.model, orchestration.structure.baseUrl)
          : toSharedRoleConfig(config, "structure"),
        "structure",
      )
    : undefined;

  const studyRole = createRoleProvider(
    useLocalRoles
      ? toLocalRoleConfig(orchestration.lead.model, orchestration.lead.baseUrl)
      : toSharedRoleConfig(config, "study"),
    "study",
  );

  return {
    operator,
    lead: leadRole.provider,
    challenger: challengerRole?.provider,
    structure: structureRole?.provider,
    study: studyRole.provider,
    meta: {
      orchestrationEnabled: true,
      operator: operatorMeta,
      lead: leadRole.meta,
      challenger: challengerRole?.meta,
      structure: structureRole?.meta,
      study: studyRole.meta,
    },
  };
}

export function isCateoModelRuntime(value: LLMProvider | CateoModelRuntime): value is CateoModelRuntime {
  return typeof value === "object" && value !== null && "meta" in value && "lead" in value;
}