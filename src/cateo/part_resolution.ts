import crypto from "node:crypto";
import type { CashClawConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import type { CateoAssistInput, CateoPartCatalogEntry, CateoPartResolution, CateoVerifiedSource } from "./types.js";

const PART_NUMBER_PATTERN = /\b[A-Z0-9]{2,}(?:[-_/][A-Z0-9]{2,})+[A-Z0-9-_/]*\b/g;
const SOURCE_LIMIT = 8;
const SEARCH_MODEL_CANDIDATES = [
  process.env.CATEO_PART_SEARCH_MODEL?.trim(),
  "gpt-4o-mini-search-preview",
  "gpt-4.1-mini",
].filter((value): value is string => Boolean(value));

interface RawVerifiedSource {
  title?: string | null;
  url?: string | null;
  domain?: string | null;
  reason?: string | null;
}

interface RawPartResolution {
  partNumber?: string | null;
  partDescription?: string | null;
  manufacturer?: string | null;
  confidencePct?: number | null;
  needsClarification?: boolean | null;
  clarifyingQuestion?: string | null;
  evidence?: string[] | null;
  aliases?: string[] | null;
  searchQueries?: string[] | null;
  failureModes?: string[] | null;
  preventiveMaintenanceHints?: string[] | null;
  verifiedSources?: RawVerifiedSource[] | null;
}

const unique = (values: Array<string | undefined | null>) => [
  ...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
];

function clampConfidence(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeSource(input: RawVerifiedSource | null | undefined): CateoVerifiedSource | null {
  const url = input?.url?.trim();
  if (!url) {
    return null;
  }
  return {
    title: input?.title?.trim() || url,
    url,
    domain: input?.domain?.trim(),
    reason: input?.reason?.trim(),
  };
}

function normalizeResolution(raw: RawPartResolution, fallback: CateoPartResolution): CateoPartResolution {
  const partNumber = raw.partNumber?.trim() || fallback.partNumber;
  const confidencePct = clampConfidence(raw.confidencePct, fallback.confidencePct);
  const verifiedSources = (raw.verifiedSources ?? []).map((entry) => normalizeSource(entry)).filter((entry): entry is CateoVerifiedSource => Boolean(entry)).slice(0, SOURCE_LIMIT);
  const needsClarification = raw.needsClarification ?? (!partNumber || confidencePct < 80);
  return {
    partNumber,
    partDescription: raw.partDescription?.trim() || fallback.partDescription,
    manufacturer: raw.manufacturer?.trim() || fallback.manufacturer,
    confidencePct,
    needsClarification,
    clarifyingQuestion: raw.clarifyingQuestion?.trim() || (needsClarification ? fallback.clarifyingQuestion : undefined),
    evidence: unique([...(raw.evidence ?? []), ...fallback.evidence]),
    aliases: unique([...(raw.aliases ?? []), ...fallback.aliases]),
    searchQueries: unique([...(raw.searchQueries ?? []), ...fallback.searchQueries]).slice(0, 8),
    failureModes: unique([...(raw.failureModes ?? []), ...fallback.failureModes]).slice(0, 8),
    preventiveMaintenanceHints: unique([...(raw.preventiveMaintenanceHints ?? []), ...fallback.preventiveMaintenanceHints]).slice(0, 8),
    verifiedSources: verifiedSources.length > 0 ? verifiedSources : fallback.verifiedSources,
  };
}

function collectPromptCorpus(input: CateoAssistInput): string {
  return [
    input.title,
    input.query,
    input.symptomDescription,
    input.errorCode,
    ...(input.observedConditions ?? []),
    input.asset?.assetId,
    input.asset?.assetType,
    input.asset?.model,
    input.machine?.manufacturer,
    input.machine?.model,
    input.machine?.serialNumber,
    ...(input.attachments ?? []).flatMap((attachment) => [attachment.name, attachment.note]),
  ].filter(Boolean).join("\n");
}

function candidateCounts(input: CateoAssistInput): Map<string, number> {
  const map = new Map<string, number>();
  const corpus = collectPromptCorpus(input).toUpperCase();
  for (const match of corpus.matchAll(PART_NUMBER_PATTERN)) {
    const candidate = match[0].replace(/[.,;:]+$/g, "");
    const explicitContextBoost = [
      `MANUFACTURING PART ${candidate}`,
      `PART NUMBER ${candidate}`,
      `PART NO ${candidate}`,
      `P/N ${candidate}`,
      `PN ${candidate}`,
    ].some((marker) => corpus.includes(marker)) ? 2 : 0;
    map.set(candidate, (map.get(candidate) ?? 0) + 1 + explicitContextBoost);
  }
  for (const part of input.partsCatalog ?? []) {
    const candidate = part.sku.trim().toUpperCase();
    if (!candidate) continue;
    map.set(candidate, (map.get(candidate) ?? 0) + 2);
  }
  return map;
}

function pickCatalogMatch(input: CateoAssistInput, partNumber: string | undefined): CateoPartCatalogEntry | undefined {
  if (!partNumber) {
    return undefined;
  }
  const normalized = partNumber.trim().toUpperCase();
  return (input.partsCatalog ?? []).find((entry) => entry.sku.trim().toUpperCase() === normalized);
}

function heuristicResolution(input: CateoAssistInput): CateoPartResolution {
  const counts = candidateCounts(input);
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length);
  const partNumber = ranked[0]?.[0];
  const catalog = pickCatalogMatch(input, partNumber);
  const confidenceBase = partNumber ? (catalog ? 88 : ranked[0][1] >= 2 ? 82 : 68) : 22;
  return {
    partNumber,
    partDescription: catalog?.description,
    manufacturer: input.machine?.manufacturer,
    confidencePct: confidenceBase,
    needsClarification: !partNumber || confidenceBase < 80,
    clarifyingQuestion: !partNumber || confidenceBase < 80
      ? "I need the exact manufacturer part number before I can build the controlled artifact package. What part number or nameplate marking is on the component?"
      : undefined,
    evidence: unique([
      partNumber ? `Detected candidate part number ${partNumber} in the submitted context.` : undefined,
      catalog ? `Matched the submitted part number against the internal parts catalog as ${catalog.sku}.` : undefined,
      input.machine?.model ? `Machine model context: ${input.machine.model}.` : undefined,
      input.machine?.manufacturer ? `Manufacturer context: ${input.machine.manufacturer}.` : undefined,
    ]),
    aliases: unique([catalog?.sku]),
    searchQueries: unique([
      partNumber && input.machine?.manufacturer ? `${input.machine.manufacturer} ${partNumber}` : undefined,
      partNumber && input.machine?.model ? `${partNumber} ${input.machine.model}` : undefined,
      partNumber,
    ]),
    failureModes: [],
    preventiveMaintenanceHints: [],
    verifiedSources: [],
  };
}

function canUseOpenAIWebSearch(config: CashClawConfig): boolean {
  return config.llm.provider === "openai" && Boolean(config.llm.apiKey);
}

function buildPartSearchPrompt(input: CateoAssistInput, fallback: CateoPartResolution): string {
  return [
    "Identify the exact manufacturing part number involved in this engineering request.",
    "Use the provided prompt, attachment-derived observations, and web search results.",
    "Only return a high confidence part number when the evidence is strong. If confidence is below 80%, set needsClarification=true and ask one concise follow-up question.",
    "Prefer manufacturer documentation, OEM pages, manuals, datasheets, and reputable distributor listings.",
    "Do not fabricate sources or part numbers.",
    "Request context:",
    JSON.stringify({
      title: input.title,
      query: input.query,
      symptomDescription: input.symptomDescription,
      errorCode: input.errorCode,
      observedConditions: input.observedConditions ?? [],
      asset: input.asset,
      machine: input.machine,
      workOrder: input.workOrder,
      attachmentNames: (input.attachments ?? []).map((attachment) => ({ name: attachment.name, note: attachment.note, kind: attachment.kind, mimeType: attachment.mimeType })),
      knownCatalogEntries: (input.partsCatalog ?? []).slice(0, 12),
      heuristicFallback: fallback,
    }, null, 2),
  ].join("\n\n");
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: Array<Record<string, unknown>> }).content : [];
    for (const block of content) {
      const text = typeof block?.text === "string" ? block.text : typeof block?.output_text === "string" ? block.output_text : undefined;
      if (text?.trim()) {
        chunks.push(text.trim());
      }
    }
  }
  return chunks.join("\n\n").trim();
}

async function searchWithOpenAI(config: CashClawConfig, input: CateoAssistInput, fallback: CateoPartResolution, requestId?: string): Promise<CateoPartResolution> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.llm.apiKey}`,
  };

  for (const model of SEARCH_MODEL_CANDIDATES) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          tools: [{ type: "web_search_preview" }],
          max_output_tokens: 1400,
          text: {
            format: {
              type: "json_schema",
              name: "cateo_part_resolution",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  partNumber: { type: ["string", "null"] },
                  partDescription: { type: ["string", "null"] },
                  manufacturer: { type: ["string", "null"] },
                  confidencePct: { type: "number" },
                  needsClarification: { type: "boolean" },
                  clarifyingQuestion: { type: ["string", "null"] },
                  evidence: { type: "array", items: { type: "string" } },
                  aliases: { type: "array", items: { type: "string" } },
                  searchQueries: { type: "array", items: { type: "string" } },
                  failureModes: { type: "array", items: { type: "string" } },
                  preventiveMaintenanceHints: { type: "array", items: { type: "string" } },
                  verifiedSources: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        title: { type: "string" },
                        url: { type: "string" },
                        domain: { type: ["string", "null"] },
                        reason: { type: ["string", "null"] },
                      },
                      required: ["title", "url", "domain", "reason"],
                    },
                  },
                },
                required: [
                  "partNumber",
                  "partDescription",
                  "manufacturer",
                  "confidencePct",
                  "needsClarification",
                  "clarifyingQuestion",
                  "evidence",
                  "aliases",
                  "searchQueries",
                  "failureModes",
                  "preventiveMaintenanceHints",
                  "verifiedSources"
                ],
              },
            },
          },
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: "You are Cateo's part-identification and web-research stage. Resolve the exact manufacturing part number, preferring manufacturer and OEM sources. Use only the evidence you can support. If confidence is below 80 percent, ask a single clarifying follow-up question."
                }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildPartSearchPrompt(input, fallback)
                }
              ]
            }
          ]
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI part search failed for ${model}: ${response.status} ${await response.text()}`);
      }

      const payload = await response.json() as Record<string, unknown>;
      const outputText = extractOutputText(payload);
      if (!outputText) {
        throw new Error(`OpenAI part search returned no structured output for ${model}`);
      }
      const parsed = JSON.parse(outputText) as RawPartResolution;
      const normalized = normalizeResolution(parsed, fallback);
      appendAuditEvent({
        actor: "runtime",
        category: "cateo_part_resolution",
        action: "web_enrich",
        outcome: normalized.needsClarification ? "clarify" : "success",
        message: normalized.needsClarification
          ? "Cateo could not confirm the manufacturing part number and requested clarification."
          : `Cateo resolved manufacturing part number ${normalized.partNumber ?? "unknown"} from prompt and web evidence.`,
        requestId,
        metadata: {
          model,
          partNumber: normalized.partNumber,
          confidencePct: normalized.confidencePct,
          sourceCount: normalized.verifiedSources.length,
        },
      });
      return normalized;
    } catch (error) {
      appendAuditEvent({
        actor: "runtime",
        category: "cateo_part_resolution",
        action: "web_enrich",
        outcome: "failed",
        severity: "warn",
        message: error instanceof Error ? error.message : "OpenAI part search failed",
        requestId,
        metadata: { model },
      });
    }
  }

  return fallback;
}

export async function resolveCateoPart(config: CashClawConfig, input: CateoAssistInput, requestId?: string): Promise<CateoPartResolution> {
  const fallback = heuristicResolution(input);
  if (!canUseOpenAIWebSearch(config)) {
    appendAuditEvent({
      actor: "runtime",
      category: "cateo_part_resolution",
      action: "heuristic_only",
      outcome: fallback.needsClarification ? "clarify" : "success",
      message: fallback.needsClarification
        ? "Cateo used heuristic part detection and still requires clarification."
        : `Cateo resolved manufacturing part number ${fallback.partNumber ?? "unknown"} without web enrichment.`,
      requestId,
      metadata: {
        partNumber: fallback.partNumber,
        confidencePct: fallback.confidencePct,
      },
    });
    return fallback;
  }

  const resolved = await searchWithOpenAI(config, input, fallback, requestId);
  const catalog = pickCatalogMatch(input, resolved.partNumber);
  if (catalog) {
    return normalizeResolution({
      ...resolved,
      partDescription: resolved.partDescription || catalog.description,
      aliases: unique([...(resolved.aliases ?? []), catalog.sku]),
      evidence: unique([...(resolved.evidence ?? []), `Matched the resolved part number to internal catalog entry ${catalog.sku}.`]),
      confidencePct: Math.max(resolved.confidencePct, 88),
      needsClarification: false,
      clarifyingQuestion: null,
    }, resolved);
  }
  return resolved;
}

