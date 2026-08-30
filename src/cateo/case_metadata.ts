import crypto from "node:crypto";
import type {
  CateoArtifactRecord,
  CateoAssistInput,
  CateoCaseMetadataField,
  CateoCaseRecord,
  CateoDatasetCandidate,
  CateoDynamicCaseMetadata,
  CateoMetadataSource,
  CateoMetadataStatus,
} from "./types.js";

const EXTRACTION_VERSION = "cateo-conversation-metadata-v1";
const SCHEMA_VERSION = "cateo-dynamic-case-metadata-v1";
const CUSTOMER_FIELD_LABELS: Record<string, string> = {
  symptom: "the reported problem",
  errorCode: "the error code",
  instrument: "the instrument or model",
  occurrenceContext: "when the problem occurs",
  manufacturer: "the manufacturer",
  module: "the module or subsystem",
  applicableVersion: "the applicable software or hardware version",
  assetId: "the equipment identifier",
  workOrderId: "the work order",
  partNumber: "the part number",
  faultArea: "the affected area",
  issueType: "the type of issue",
};

interface CandidateValue {
  key: string;
  value: unknown;
  source: CateoMetadataSource;
  status?: CateoMetadataStatus;
  confidence?: number;
  append?: boolean;
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function uniqueUnknown(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function find(text: string, pattern: RegExp): string | undefined {
  return clean(pattern.exec(text)?.[1])?.replace(/[.,;:!?]+$/, "").trim() || undefined;
}

function explicitCorrection(text: string): boolean {
  return /^(?:correction\b|actually\b|to correct that\b|i meant\b|not\b)/i.test(text.trim());
}

function naturalInstrumentReference(text: string): string | undefined {
  const value = find(
    text,
    /\bmy\s+([A-Z0-9][A-Z0-9 ._/-]{0,80}?)\s+(?:(?:is|went)\s+(?:down|offline|failing|broken|stopped|not\s+working)|(?:has|gives|shows|reports)\b)/i,
  );
  if (!value) return undefined;

  const genericTerms = new Set(["analyzer", "device", "equipment", "instrument", "machine", "system"]);
  return genericTerms.has(value.toLowerCase()) ? undefined : value;
}

function occurrenceContext(text: string): string | undefined {
  return find(
    text,
    /\b(?:during|while|at)\s+((?:initial\s+)?(?:startup|start-up|boot(?:up)?|initialization|shutdown|calibration|self-test|operation|processing|maintenance))\b/i,
  );
}

function extractCandidates(text: string, input?: CateoAssistInput): CandidateValue[] {
  const candidates: CandidateValue[] = [];
  const add = (key: string, value: unknown, options: Partial<CandidateValue> = {}) => {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return;
    candidates.push({ key, value, source: options.source ?? "USER_STATED", status: options.status ?? "CONFIRMED", confidence: options.confidence ?? 1, append: options.append });
  };

  const correctedSymptom = explicitCorrection(text)
    ? find(text, /\b(?:symptom|problem|issue)\s*(?:is|=|:)?\s*(.+)$/i)
    : undefined;
  add("symptom", correctedSymptom ?? (explicitCorrection(text) ? undefined : clean(input?.symptomDescription) ?? clean(text)));
  add("errorCode", clean(input?.errorCode) ?? find(text, /\b(?:error|alarm|fault|code)(?:\s+code)?\s*(?:is|=|:|#)?\s*([A-Z][A-Z0-9._-]*\d[A-Z0-9._-]*|\d{2,}[A-Z0-9._-]*)\b/i));
  add("instrument", clean(input?.machine?.model) ?? clean(input?.asset?.model) ?? find(text, /\b(?:(?:instrument|machine|analyzer|equipment)(?:\s+(?:model|type))?|model)\s*(?:is|=|:)\s*([A-Z0-9][A-Z0-9 ._/-]{1,80})/i) ?? naturalInstrumentReference(text));
  add("occurrenceContext", occurrenceContext(text));
  add("manufacturer", clean(input?.machine?.manufacturer) ?? find(text, /\b(?:manufacturer|make)\s*(?:is|=|:)?\s*([A-Z0-9][A-Z0-9 ._/-]{1,60})/i));
  add("module", find(text, /\b(?:module|subsystem|assembly)\s*(?:is|=|:)?\s*([A-Z0-9][A-Z0-9 ._/-]{1,80})/i));
  add("applicableVersion", find(text, /\b(?:software|firmware|hardware|version|revision|rev)\s*(?:version|is|=|:)?\s*([A-Z0-9][A-Z0-9._/-]{0,40})/i));
  add("assetId", clean(input?.asset?.assetId));
  add("workOrderId", clean(input?.workOrder?.workOrderId));
  add("partNumber", clean(input?.partNumber));
  add("faultArea", clean(input?.faultArea));
  add("issueType", clean(input?.issueType));

  if (/\b(?:tried|attempted|already|restarted|reset|replaced|cleaned|checked|tested)\b/i.test(text)) {
    add("actionsAttempted", clean(text), { append: true });
  }
  if (/\b(?:i have|we have|available|on hand)\b.*\b(?:tool|meter|part|kit|probe|wrench|multimeter|consumable)s?\b/i.test(text)) {
    add("toolsOrPartsAvailable", clean(text), { append: true });
  }
  if (/\b(?:locked out|lockout|tagout|powered off|de-energized|ppe|hazard|safe state|biohazard|radiation)\b/i.test(text)) {
    add("safetyConditions", clean(text), { append: true });
  }
  if (/\b(?:i see|we see|observed|shows|reads|measured|result(?:ed)?|after that|now it|still)\b/i.test(text)) {
    add("observations", clean(text), { append: true });
  }
  if (/\b(?:not resolved|not fixed|still failing|still broken|did not work|unresolved)\b/i.test(text)) {
    add("resolutionStatus", "UNRESOLVED");
  } else if (/\b(?:resolved|fixed|working now|returned to service)\b/i.test(text)) {
    add("resolutionStatus", "RESOLVED");
  }
  if (/\b(?:escalate|call service|contact support|qualified technician|stop work)\b/i.test(text)) {
    add("escalationRequired", true);
  }
  add("extractionVersion", EXTRACTION_VERSION, { source: "SYSTEM_OBSERVED" });
  return candidates;
}

function newField(candidate: CandidateValue, messageId: string, timestamp: string): CateoCaseMetadataField {
  return {
    value: candidate.append ? [candidate.value] : candidate.value,
    status: candidate.status ?? "PROVISIONAL",
    source: candidate.source,
    sourceMessageId: messageId,
    timestamp,
    version: 1,
    confidence: candidate.confidence,
    correctionHistory: [],
  };
}

function historyOf(field: CateoCaseMetadataField, reason: string, supersededAt?: string) {
  return {
    value: field.value,
    status: field.status,
    source: field.source,
    sourceMessageId: field.sourceMessageId,
    timestamp: field.timestamp,
    version: field.version,
    confidence: field.confidence,
    supersededAt,
    reason,
  };
}

function applyCandidate(args: {
  metadata: CateoDynamicCaseMetadata;
  candidate: CandidateValue;
  messageId: string;
  timestamp: string;
  correction: boolean;
}): void {
  const existing = args.metadata.fields[args.candidate.key];
  if (!existing) {
    args.metadata.fields[args.candidate.key] = newField(args.candidate, args.messageId, args.timestamp);
    return;
  }

  if (args.candidate.key === "symptom" && !args.correction) {
    return;
  }

  if (args.candidate.append) {
    const current = Array.isArray(existing.value) ? existing.value : [existing.value];
    const next = uniqueUnknown([...current, args.candidate.value]);
    if (sameValue(current, next)) return;
    existing.correctionHistory.push(historyOf(existing, "Additional conversational evidence appended."));
    existing.value = next;
    existing.status = args.candidate.status ?? "CONFIRMED";
    existing.source = args.candidate.source;
    existing.sourceMessageId = args.messageId;
    existing.timestamp = args.timestamp;
    existing.version += 1;
    existing.confidence = args.candidate.confidence;
    return;
  }

  if (sameValue(existing.value, args.candidate.value)) {
    if (args.correction && existing.status === "CONFLICTED") {
      existing.correctionHistory.push(historyOf(existing, "User correction resolved conflicting values.", args.timestamp));
      existing.status = "CONFIRMED";
      existing.source = "USER_CORRECTED";
      existing.sourceMessageId = args.messageId;
      existing.timestamp = args.timestamp;
      existing.version += 1;
      existing.confidence = args.candidate.confidence;
      existing.conflictingValues = undefined;
      return;
    }
    if (existing.status === "PROVISIONAL" && args.candidate.source.startsWith("USER_")) {
      existing.status = "CONFIRMED";
      existing.source = args.candidate.source;
      existing.sourceMessageId = args.messageId;
      existing.timestamp = args.timestamp;
      existing.confidence = Math.max(existing.confidence ?? 0, args.candidate.confidence ?? 0);
      existing.version += 1;
    }
    return;
  }

  const userOutranksInference = args.candidate.source.startsWith("USER_") && existing.source === "MODEL_INFERRED";
  if (args.correction || args.candidate.source === "USER_CORRECTED" || userOutranksInference) {
    existing.correctionHistory.push(historyOf(existing, args.correction ? "User correction superseded the prior value." : "User-stated evidence superseded model inference.", args.timestamp));
    existing.value = args.candidate.value;
    existing.status = "CONFIRMED";
    existing.source = args.correction ? "USER_CORRECTED" : args.candidate.source;
    existing.sourceMessageId = args.messageId;
    existing.timestamp = args.timestamp;
    existing.version += 1;
    existing.confidence = args.candidate.confidence;
    existing.conflictingValues = undefined;
    return;
  }

  if (existing.source.startsWith("USER_") && args.candidate.source === "MODEL_INFERRED") {
    existing.correctionHistory.push({
      value: args.candidate.value,
      status: "PROVISIONAL",
      source: args.candidate.source,
      sourceMessageId: args.messageId,
      timestamp: args.timestamp,
      version: existing.version + 1,
      confidence: args.candidate.confidence,
      reason: "Model inference retained without overwriting user-stated evidence.",
    });
    return;
  }

  existing.correctionHistory.push(historyOf(existing, "Conflicting evidence preserved pending clarification."));
  existing.status = "CONFLICTED";
  existing.conflictingValues = uniqueUnknown([...(existing.conflictingValues ?? [existing.value]), args.candidate.value]);
  existing.timestamp = args.timestamp;
  existing.version += 1;
  const customerLabel = CUSTOMER_FIELD_LABELS[args.candidate.key] ?? "that detail";
  args.metadata.pendingClarification = `I heard two different values for ${customerLabel}. Which value is correct: ${existing.conflictingValues.map(String).join(" or ")}?`;
}

export function accumulateConversationMetadata(args: {
  current?: CateoDynamicCaseMetadata;
  messageId: string;
  text: string;
  input?: CateoAssistInput;
  timestamp?: string;
}): CateoDynamicCaseMetadata {
  const timestamp = args.timestamp ?? new Date().toISOString();
  const metadata: CateoDynamicCaseMetadata = args.current ?? {
    schemaVersion: SCHEMA_VERSION,
    version: 0,
    updatedAt: timestamp,
    fields: {},
    processedMessageIds: [],
  };
  if (metadata.processedMessageIds.includes(args.messageId)) {
    return metadata;
  }
  metadata.pendingClarification = undefined;
  const correction = explicitCorrection(args.text);
  for (const candidate of extractCandidates(args.text, args.input)) {
    applyCandidate({ metadata, candidate: correction ? { ...candidate, source: candidate.source === "USER_STATED" ? "USER_CORRECTED" : candidate.source } : candidate, messageId: args.messageId, timestamp, correction });
  }
  metadata.processedMessageIds.push(args.messageId);
  metadata.version += 1;
  metadata.updatedAt = timestamp;
  return metadata;
}

export function attachCaseMetadataAndDatasetCandidate(args: {
  caseRecord: CateoCaseRecord;
  metadata?: CateoDynamicCaseMetadata;
  artifacts?: CateoArtifactRecord[];
}): void {
  const now = new Date().toISOString();
  const revisions = (args.artifacts ?? []).map((artifact) => artifact.revisions.at(-1)?.revisionId).filter((value): value is string => Boolean(value));
  const sources = args.caseRecord.releaseControl?.sourceGrounding.sources ?? [];
  const emptyMetadata: CateoDynamicCaseMetadata = {
    schemaVersion: SCHEMA_VERSION,
    version: 0,
    updatedAt: now,
    fields: {},
    processedMessageIds: [],
  };
  const metadata: CateoDynamicCaseMetadata = structuredClone(args.metadata ?? args.caseRecord.dynamicMetadata ?? emptyMetadata);
  let metadataChanged = false;
  const observe = (key: string, value: unknown, source: CateoMetadataSource = "SYSTEM_OBSERVED") => {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return;
    const current = metadata.fields[key];
    if (current && sameValue(current.value, value) && current.status === "CONFIRMED" && current.source === source) return;
    metadataChanged = true;
    if (!current) {
      metadata.fields[key] = {
        value,
        status: "CONFIRMED",
        source,
        timestamp: now,
        version: 1,
        confidence: 1,
        correctionHistory: [],
      };
      return;
    }
    current.correctionHistory.push(historyOf(current, "System-observed case state advanced.", now));
    current.value = value;
    current.status = "CONFIRMED";
    current.source = source;
    current.timestamp = now;
    current.version += 1;
    current.confidence = 1;
    current.conflictingValues = undefined;
  };
  const latestTransition = args.caseRecord.releaseControl?.transitions.at(-1);
  observe("conversationId", args.caseRecord.conversationId);
  observe("caseId", args.caseRecord.caseId);
  observe("generatedInstructionRevisionIds", revisions);
  observe("releaseState", args.caseRecord.releaseControl?.state);
  observe("reviewPolicyVersion", args.caseRecord.releaseControl?.policyVersion);
  observe("currentContentHash", args.caseRecord.releaseControl?.currentContentHash);
  observe("sourceDocuments", sources.map((sourceRef) => ({
    sourceId: sourceRef.sourceId,
    revision: sourceRef.revision,
    locator: sourceRef.locator,
    rightsClassification: sourceRef.rightsClassification,
  })), "DOCUMENT_GROUNDED");
  observe("promptVersion", latestTransition?.promptVersion);
  observe("retrievalVersion", latestTransition?.retrievalVersion);
  observe("modelVersions", latestTransition?.modelVersions);
  observe("releaseSchemaVersion", args.caseRecord.releaseControl?.schemaVersion);
  observe("caseMetadataSchemaVersion", SCHEMA_VERSION);
  if (metadataChanged) {
    metadata.version += 1;
    metadata.updatedAt = now;
  }
  args.caseRecord.dynamicMetadata = metadata;
  const existing = args.caseRecord.datasetCandidate;
  const candidate: CateoDatasetCandidate = existing ?? {
    schemaVersion: "cateo-dataset-candidate-v1",
    candidateId: crypto.randomUUID(),
    state: "UNREVIEWED",
    createdAt: now,
    updatedAt: now,
    conversationId: args.caseRecord.conversationId,
    caseId: args.caseRecord.caseId,
    instructionRevisionIds: revisions,
    sourceIds: sources.map((source) => source.sourceId),
    sourceRevisions: sources.map((source) => source.revision),
    deidentificationStatus: "NOT_REVIEWED",
    eligibility: { train: false, development: false, test: false },
    operationalOutcome: "UNKNOWN",
  };
  candidate.updatedAt = now;
  candidate.state = candidate.state === "REJECTED" ? "REJECTED" : "UNREVIEWED";
  candidate.eligibility = { train: false, development: false, test: false };
  args.caseRecord.datasetCandidate = candidate;
}
