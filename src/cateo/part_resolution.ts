import type { CashClawConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import type { CateoAssistInput, CateoPartCatalogEntry, CateoPartResolution, CateoVerifiedSource } from "./types.js";

const PART_NUMBER_PATTERN = /\b[A-Z0-9]{2,}(?:[-_/][A-Z0-9]{2,})+[A-Z0-9-_/]*\b/g;
const SOURCE_LIMIT = 12;
const SEARCH_QUERY_LIMIT = 10;
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
  documentType?: string | null;
  publisherType?: string | null;
  summary?: string | null;
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
  hazardSignals?: string[] | null;
  expectedValues?: string[] | null;
  groundedFindings?: string[] | null;
  referenceDocuments?: string[] | null;
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
    documentType: input?.documentType?.trim(),
    publisherType: input?.publisherType?.trim(),
    summary: input?.summary?.trim(),
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
    searchQueries: unique([...(raw.searchQueries ?? []), ...fallback.searchQueries]).slice(0, SEARCH_QUERY_LIMIT),
    failureModes: unique([...(raw.failureModes ?? []), ...fallback.failureModes]).slice(0, 8),
    preventiveMaintenanceHints: unique([...(raw.preventiveMaintenanceHints ?? []), ...fallback.preventiveMaintenanceHints]).slice(0, 8),
    hazardSignals: unique([...(raw.hazardSignals ?? []), ...fallback.hazardSignals]).slice(0, 10),
    expectedValues: unique([...(raw.expectedValues ?? []), ...fallback.expectedValues]).slice(0, 10),
    groundedFindings: unique([...(raw.groundedFindings ?? []), ...fallback.groundedFindings]).slice(0, 12),
    referenceDocuments: unique([...(raw.referenceDocuments ?? []), ...fallback.referenceDocuments]).slice(0, 12),
    verifiedSources: verifiedSources.length > 0 ? verifiedSources : fallback.verifiedSources,
  };
}

function collectPromptCorpus(input: CateoAssistInput): string {
  return [
    input.title,
    input.query,
    input.symptomDescription,
    input.errorCode,
    input.partNumber,
    input.issueType,
    input.contextNotes,
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
  const explicitPartNumber = input.partNumber?.trim().toUpperCase();
  if (explicitPartNumber) {
    map.set(explicitPartNumber, (map.get(explicitPartNumber) ?? 0) + 6);
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
    hazardSignals: [],
    expectedValues: [],
    groundedFindings: [],
    referenceDocuments: [],
    verifiedSources: [],
  };
}

function buildSearchQueryHints(input: CateoAssistInput, fallback: CateoPartResolution): string[] {
  const manufacturer = input.machine?.manufacturer?.trim() || fallback.manufacturer?.trim();
  const model = input.machine?.model?.trim();
  const assetType = input.asset?.assetType?.trim();
  const issueType = input.issueType?.trim();
  const errorCode = input.errorCode?.trim();
  const symptom = input.symptomDescription?.trim();
  const title = input.title?.trim();
  const partNumber = fallback.partNumber?.trim();

  return unique([
    ...(fallback.searchQueries ?? []),
    partNumber && manufacturer ? `${manufacturer} ${partNumber} manual` : undefined,
    partNumber && manufacturer ? `${manufacturer} ${partNumber} datasheet` : undefined,
    partNumber && manufacturer ? `${manufacturer} ${partNumber} service bulletin` : undefined,
    partNumber && manufacturer ? `${manufacturer} ${partNumber} troubleshooting` : undefined,
    partNumber && model ? `${partNumber} ${model}` : undefined,
    partNumber && errorCode ? `${partNumber} ${errorCode}` : undefined,
    partNumber && issueType ? `${partNumber} ${issueType}` : undefined,
    manufacturer && model && issueType ? `${manufacturer} ${model} ${issueType}` : undefined,
    manufacturer && assetType && issueType ? `${manufacturer} ${assetType} ${issueType}` : undefined,
    manufacturer && errorCode ? `${manufacturer} ${errorCode}` : undefined,
    manufacturer && symptom ? `${manufacturer} ${symptom}` : undefined,
    title && manufacturer ? `${manufacturer} ${title}` : undefined,
  ]).slice(0, SEARCH_QUERY_LIMIT);
}

function needsSourceBackfill(resolved: CateoPartResolution): boolean {
  if (!resolved.partNumber) {
    return false;
  }
  return resolved.verifiedSources.length < 4
    || resolved.referenceDocuments.length < 3
    || resolved.groundedFindings.length < 4
    || resolved.expectedValues.length < 2
    || resolved.hazardSignals.length < 2;
}

function canUseOpenAIWebSearch(config: CashClawConfig): boolean {
  return config.llm.provider === "openai" && Boolean(config.llm.apiKey);
}

function buildPartSearchPrompt(input: CateoAssistInput, fallback: CateoPartResolution): string {
  return [
    "Identify the exact manufacturing part number involved in this engineering request.",
    "Use the provided prompt, attachment-derived observations, and web search results.",
    "Only return a high confidence part number when the evidence is strong. If confidence is below 80%, set needsClarification=true and ask one concise follow-up question.",
    "Prefer manufacturer documentation, OEM pages, manuals, datasheets, service bulletins, standards, and reputable technical distributor listings.",
    "Use the searchQueryHints to widen coverage and try to return 3 to 6 reliable verified sources when the web evidence supports them.",
    "Collect concrete hazard labels, expected values, diagnostic anchors, related manuals, and reference document titles whenever the sources support them.",
    "Do not fabricate sources, part numbers, warnings, or operating values.",
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
      searchQueryHints: buildSearchQueryHints(input, fallback),
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
          max_output_tokens: 1800,
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
                  hazardSignals: { type: "array", items: { type: "string" } },
                  expectedValues: { type: "array", items: { type: "string" } },
                  groundedFindings: { type: "array", items: { type: "string" } },
                  referenceDocuments: { type: "array", items: { type: "string" } },
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
                        documentType: { type: ["string", "null"] },
                        publisherType: { type: ["string", "null"] },
                        summary: { type: ["string", "null"] },
                      },
                      required: ["title", "url", "domain", "reason", "documentType", "publisherType", "summary"],
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
                  "hazardSignals",
                  "expectedValues",
                  "groundedFindings",
                  "referenceDocuments",
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
                  text: "You are Cateo's part-identification and web-research stage. Resolve the exact manufacturing part number, preferring manufacturer, OEM, service-manual, datasheet, standards, and service-bulletin sources. Return only evidence-backed findings. If confidence is below 80 percent, ask a single clarifying follow-up question. Use the provided searchQueryHints, gather 3 to 6 reliable sources when possible, and capture hazards, expected values, reference documents, and concise grounded findings when the sources support them."
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
          hazardCount: normalized.hazardSignals.length,
          expectedValueCount: normalized.expectedValues.length,
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

async function backfillVerifiedSources(config: CashClawConfig, input: CateoAssistInput, resolved: CateoPartResolution, requestId?: string): Promise<CateoPartResolution> {
  if (!resolved.partNumber) {
    return resolved;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.llm.apiKey}`,
  };

  const prompt = [
    `The manufacturing part number has already been resolved as ${resolved.partNumber}.`,
    resolved.manufacturer ? `Manufacturer: ${resolved.manufacturer}.` : "",
    resolved.partDescription ? `Part description: ${resolved.partDescription}.` : "",
    `Original issue: ${input.symptomDescription}`,
    input.issueType ? `Issue type: ${input.issueType}.` : "",
    input.businessType ? `Operating domain: ${input.businessType}.` : "",
    `Search query hints: ${buildSearchQueryHints(input, resolved).join(" | ") || "none"}.`,
    "Find 3 to 6 reliable sources that directly support the identified part, preferring manufacturer/OEM manuals, datasheets, service bulletins, standards, and reputable technical distributors.",
    "Return hazards, expected values, grounded findings, and reference document titles only when the sources support them.",
    "Do not change the part number. Keep sources diverse and do not return empty verifiedSources unless the web search genuinely failed.",
  ].filter(Boolean).join("\n\n");

  for (const model of SEARCH_MODEL_CANDIDATES) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          tools: [{ type: "web_search_preview" }],
          max_output_tokens: 1500,
          text: {
            format: {
              type: "json_schema",
              name: "cateo_part_source_backfill",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  partDescription: { type: ["string", "null"] },
                  manufacturer: { type: ["string", "null"] },
                  failureModes: { type: "array", items: { type: "string" } },
                  preventiveMaintenanceHints: { type: "array", items: { type: "string" } },
                  hazardSignals: { type: "array", items: { type: "string" } },
                  expectedValues: { type: "array", items: { type: "string" } },
                  groundedFindings: { type: "array", items: { type: "string" } },
                  referenceDocuments: { type: "array", items: { type: "string" } },
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
                        documentType: { type: ["string", "null"] },
                        publisherType: { type: ["string", "null"] },
                        summary: { type: ["string", "null"] },
                      },
                      required: ["title", "url", "domain", "reason", "documentType", "publisherType", "summary"],
                    },
                  },
                },
                required: ["partDescription", "manufacturer", "failureModes", "preventiveMaintenanceHints", "hazardSignals", "expectedValues", "groundedFindings", "referenceDocuments", "verifiedSources"],
              },
            },
          },
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: "You are Cateo's source-backfill stage. Keep the resolved part number fixed, gather 3 to 6 reliable sources when possible, and return source-backed hazards, expected values, reference documents, and concise grounded findings." }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: prompt }],
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI source backfill failed for ${model}: ${response.status} ${await response.text()}`);
      }

      const payload = await response.json() as Record<string, unknown>;
      const outputText = extractOutputText(payload);
      if (!outputText) {
        throw new Error(`OpenAI source backfill returned no structured output for ${model}`);
      }

      const parsed = JSON.parse(outputText) as RawPartResolution;
      const merged = normalizeResolution({
        ...parsed,
        partNumber: resolved.partNumber,
        confidencePct: resolved.confidencePct,
        needsClarification: resolved.needsClarification,
        clarifyingQuestion: resolved.clarifyingQuestion ?? null,
        evidence: [...(resolved.evidence ?? []), ...(parsed.evidence ?? [])],
        aliases: [...(resolved.aliases ?? []), ...(parsed.aliases ?? [])],
        searchQueries: [...(resolved.searchQueries ?? [])],
      }, resolved);
      appendAuditEvent({
        actor: "runtime",
        category: "cateo_part_resolution",
        action: "source_backfill",
        outcome: merged.verifiedSources.length > 0 ? "success" : "warn",
        severity: merged.verifiedSources.length > 0 ? "info" : "warn",
        message: merged.verifiedSources.length > 0
          ? `Cateo backfilled ${merged.verifiedSources.length} verified source(s) for ${merged.partNumber}.`
          : `Cateo could not backfill verified sources for ${merged.partNumber}.`,
        requestId,
        metadata: { model, partNumber: merged.partNumber, sourceCount: merged.verifiedSources.length },
      });
      return merged;
    } catch (error) {
      appendAuditEvent({
        actor: "runtime",
        category: "cateo_part_resolution",
        action: "source_backfill",
        outcome: "failed",
        severity: "warn",
        message: error instanceof Error ? error.message : "OpenAI source backfill failed",
        requestId,
        metadata: { model, partNumber: resolved.partNumber },
      });
    }
  }

  return resolved;
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

  let resolved = await searchWithOpenAI(config, input, fallback, requestId);
  if (needsSourceBackfill(resolved)) {
    resolved = await backfillVerifiedSources(config, input, resolved, requestId);
  }
  const catalog = pickCatalogMatch(input, resolved.partNumber);
  if (catalog) {
    return normalizeResolution({
      ...resolved,
      partDescription: resolved.partDescription || catalog.description,
      aliases: unique([...(resolved.aliases ?? []), catalog.sku]),
      evidence: unique([...(resolved.evidence ?? []), `Matched the resolved part number to internal catalog entry ${catalog.sku}.`]),
      groundedFindings: unique([...(resolved.groundedFindings ?? []), `Internal parts catalog confirms ${catalog.sku} as a valid local identifier.`]),
      referenceDocuments: unique([...(resolved.referenceDocuments ?? []), `Internal catalog entry ${catalog.sku}`]),
      confidencePct: Math.max(resolved.confidencePct, 88),
      needsClarification: false,
      clarifyingQuestion: null,
    }, resolved);
  }
  return resolved;
}


