import path from "node:path";
import { getConfigDir, loadConfig } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { redactText } from "../security/redact.js";

export interface FeedbackEntry {
  taskId: string;
  taskDescription: string;
  score: number;
  comments: string;
  timestamp: number;
}

const MAX_ENTRIES = 100;
const MAX_FEEDBACK_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function getFeedbackPath(): string {
  return path.join(getConfigDir(), "feedback.json");
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistFeedback ?? false;
}

let cache: FeedbackEntry[] | null = null;

function pruneEntries(entries: FeedbackEntry[], now = Date.now()): FeedbackEntry[] {
  const cutoff = now - MAX_FEEDBACK_AGE_MS;
  return entries
    .filter((entry) => typeof entry.timestamp === "number" && entry.timestamp >= cutoff)
    .slice(-MAX_ENTRIES);
}

function readFromDisk(): FeedbackEntry[] {
  const parsed = readProtectedJson<FeedbackEntry[]>(getFeedbackPath(), []);
  if (!Array.isArray(parsed)) return [];
  return pruneEntries(
    parsed.filter(
      (entry): entry is FeedbackEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as FeedbackEntry).taskId === "string" &&
        typeof (entry as FeedbackEntry).score === "number" &&
        typeof (entry as FeedbackEntry).timestamp === "number",
    ),
  );
}

export function loadFeedback(): FeedbackEntry[] {
  if (cache) return cache;
  cache = readFromDisk();
  return cache;
}

export function storeFeedback(entry: FeedbackEntry): void {
  import("./search.js")
    .then((module) => module.invalidateIndex())
    .catch((err) => console.error("Failed to invalidate search index:", err));

  const entries = loadFeedback();
  entries.push({
    ...entry,
    taskDescription: redactText(entry.taskDescription),
    comments: redactText(entry.comments),
  });

  const trimmed = pruneEntries(entries);
  cache = trimmed;

  if (shouldPersist()) {
    writeProtectedJson(getFeedbackPath(), trimmed);
  }
}

export function getFeedbackStats(): {
  totalTasks: number;
  avgScore: number;
  completionRate: number;
} {
  const entries = loadFeedback();
  if (entries.length === 0) {
    return { totalTasks: 0, avgScore: 0, completionRate: 0 };
  }

  const scored = entries.filter((entry) => entry.score > 0);
  const avgScore = scored.length > 0
    ? scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length
    : 0;

  return {
    totalTasks: entries.length,
    avgScore: Math.round(avgScore * 10) / 10,
    completionRate: Math.round((scored.length / entries.length) * 100),
  };
}