import type { CashClawConfig, LLMConfig } from "../config.js";
import { getOrchestrationConfig } from "../config.js";
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

  const leadConfig = toLocalRoleConfig(orchestration.lead.model, orchestration.lead.baseUrl);
  const lead = createLLMProvider(leadConfig);
  const leadMeta: CateoRuntimeModelInfo = {
    role: "lead",
    provider: leadConfig.provider,
    model: leadConfig.model,
    baseUrl: leadConfig.baseUrl,
  };

  const challenger = orchestration.challenger.enabled
    ? createLLMProvider(toLocalRoleConfig(orchestration.challenger.model, orchestration.challenger.baseUrl))
    : undefined;
  const challengerMeta = orchestration.challenger.enabled
    ? {
        role: "challenger" as const,
        provider: "ollama" as const,
        model: orchestration.challenger.model,
        baseUrl: orchestration.challenger.baseUrl,
      }
    : undefined;

  const structure = orchestration.structure.enabled
    ? createLLMProvider(toLocalRoleConfig(orchestration.structure.model, orchestration.structure.baseUrl))
    : undefined;
  const structureMeta = orchestration.structure.enabled
    ? {
        role: "structure" as const,
        provider: "ollama" as const,
        model: orchestration.structure.model,
        baseUrl: orchestration.structure.baseUrl,
      }
    : undefined;

  return {
    operator,
    lead,
    challenger,
    structure,
    study: lead,
    meta: {
      orchestrationEnabled: true,
      operator: operatorMeta,
      lead: leadMeta,
      challenger: challengerMeta,
      structure: structureMeta,
      study: { ...leadMeta, role: "study" },
    },
  };
}

export function isCateoModelRuntime(value: LLMProvider | CateoModelRuntime): value is CateoModelRuntime {
  return typeof value === "object" && value !== null && "meta" in value && "lead" in value;
}
