import path from "node:path";
import { getConfigDir, loadConfig } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { redactText } from "../security/redact.js";

export interface KnowledgeEntry {
  id: string;
  topic: "feedback_analysis" | "specialty_research" | "task_simulation" | "diagnostic_pattern" | "procedure_guidance";
  specialty: string;
  insight: string;
  source: string;
  timestamp: number;
}

const MAX_ENTRIES = 200;

function getKnowledgePath(): string {
  return path.join(getConfigDir(), "knowledge.json");
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistKnowledge ?? true;
}

let cache: KnowledgeEntry[] | null = null;

function isKnowledgeEntry(entry: unknown): entry is KnowledgeEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as KnowledgeEntry).id === "string" &&
    typeof (entry as KnowledgeEntry).topic === "string" &&
    typeof (entry as KnowledgeEntry).specialty === "string" &&
    typeof (entry as KnowledgeEntry).insight === "string" &&
    typeof (entry as KnowledgeEntry).source === "string" &&
    typeof (entry as KnowledgeEntry).timestamp === "number"
  );
}

function readFromDisk(): KnowledgeEntry[] {
  const parsed = readProtectedJson<KnowledgeEntry[]>(getKnowledgePath(), []);
  return Array.isArray(parsed) ? parsed.filter(isKnowledgeEntry) : [];
}

export function loadKnowledge(): KnowledgeEntry[] {
  if (cache) return cache;
  cache = readFromDisk();
  return cache;
}

export function storeKnowledge(entry: KnowledgeEntry): void {
  import("./search.js")
    .then((module) => module.invalidateIndex())
    .catch((err) => console.error("Failed to invalidate search index:", err));

  const entries = loadKnowledge();

  const normalized: KnowledgeEntry = {
    ...entry,
    specialty: entry.specialty.trim() || "general",
    insight: redactText(entry.insight.trim()),
    source: redactText(entry.source.trim() || "unknown"),
  };

  const duplicateIndex = entries.findIndex(
    (existing) =>
      existing.topic === normalized.topic &&
      existing.specialty.toLowerCase() === normalized.specialty.toLowerCase() &&
      existing.insight.trim().toLowerCase() === normalized.insight.trim().toLowerCase(),
  );

  if (duplicateIndex >= 0) {
    entries[duplicateIndex] = {
      ...entries[duplicateIndex],
      ...normalized,
      id: entries[duplicateIndex].id,
      timestamp: normalized.timestamp,
    };
  } else {
    entries.push(normalized);
  }

  const trimmed = entries
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-MAX_ENTRIES);

  cache = trimmed;
  if (shouldPersist()) {
    writeProtectedJson(getKnowledgePath(), trimmed);
  }
}

export function deleteKnowledge(id: string): boolean {
  const entries = loadKnowledge();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return false;

  entries.splice(index, 1);
  cache = [...entries];

  import("./search.js")
    .then((module) => module.invalidateIndex())
    .catch((err) => console.error("Failed to invalidate search index:", err));

  if (shouldPersist()) {
    writeProtectedJson(getKnowledgePath(), entries);
  }
  return true;
}

export function getRelevantKnowledge(specialties: string[], limit = 5): KnowledgeEntry[] {
  const entries = loadKnowledge();
  const lowerSpecs = new Set(specialties.map((entry) => entry.trim().toLowerCase()).filter(Boolean));

  const matching = entries.filter(
    (entry) => entry.specialty.toLowerCase() === "general" || lowerSpecs.has(entry.specialty.toLowerCase()),
  );

  return matching
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, limit);
}
