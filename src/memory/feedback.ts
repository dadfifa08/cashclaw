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

function getFeedbackPath(): string {
  return path.join(getConfigDir(), "feedback.json");
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistFeedback ?? true;
}

let cache: FeedbackEntry[] | null = null;

function readFromDisk(): FeedbackEntry[] {
  const parsed = readProtectedJson<FeedbackEntry[]>(getFeedbackPath(), []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is FeedbackEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as FeedbackEntry).taskId === "string" &&
      typeof (entry as FeedbackEntry).score === "number",
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

  const trimmed = entries.slice(-MAX_ENTRIES);
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
