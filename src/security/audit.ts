import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getConfigDir, loadConfig } from "../config.js";
import { appendProtectedText, readProtectedText } from "./secure_store.js";
import { sanitizeForAudit } from "./redact.js";

export type AuditSeverity = "info" | "warn" | "error";

export interface AuditEventInput {
  actor: "operator" | "runtime" | "model" | "server" | "system";
  category: string;
  action: string;
  outcome: string;
  message: string;
  severity?: AuditSeverity;
  requestId?: string;
  taskId?: string;
  approvalId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEvent extends AuditEventInput {
  id: string;
  timestamp: number;
  prevHash: string;
  hash: string;
}

function getAuditDir(): string {
  return path.join(getConfigDir(), "audit");
}

function getAuditPath(date = new Date()): string {
  const day = date.toISOString().split("T")[0];
  return path.join(getAuditDir(), `${day}.jsonl`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sorted = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)] as const);

  return Object.fromEntries(sorted);
}

function hashEvent(prevHash: string, payload: Omit<AuditEvent, "prevHash" | "hash">): string {
  const digest = crypto.createHash("sha256");
  digest.update(prevHash);
  digest.update(JSON.stringify(canonicalize(payload)));
  return digest.digest("hex");
}

function trimAuditFiles(retentionDays: number): void {
  if (retentionDays <= 0 || !fs.existsSync(getAuditDir())) {
    return;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(getAuditDir())) {
    const fullPath = path.join(getAuditDir(), entry);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
    }
  }
}

function getPreviousHash(filePath: string): string {
  const raw = readProtectedText(filePath);
  if (!raw) {
    return "";
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(lines[lines.length - 1]) as AuditEvent;
    return parsed.hash ?? "";
  } catch {
    return "";
  }
}

export function appendAuditEvent(input: AuditEventInput): AuditEvent {
  const config = loadConfig();
  const retentionDays = config?.security.persistence.auditRetentionDays ?? 180;
  trimAuditFiles(retentionDays);

  const filePath = getAuditPath();
  const prevHash = getPreviousHash(filePath);
  const payload: Omit<AuditEvent, "prevHash" | "hash"> = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    actor: input.actor,
    category: input.category,
    action: input.action,
    outcome: input.outcome,
    message: input.message,
    severity: input.severity ?? "info",
    requestId: input.requestId,
    taskId: input.taskId,
    approvalId: input.approvalId,
    metadata: input.metadata ? sanitizeForAudit(input.metadata) as Record<string, unknown> : undefined,
  };

  const event: AuditEvent = {
    ...payload,
    prevHash,
    hash: hashEvent(prevHash, payload),
  };

  appendProtectedText(filePath, `${JSON.stringify(event)}\n`);
  return event;
}

export function loadRecentAuditEvents(limit = 200): AuditEvent[] {
  if (!fs.existsSync(getAuditDir())) {
    return [];
  }

  const files = fs.readdirSync(getAuditDir())
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort((left, right) => right.localeCompare(left));

  const events: AuditEvent[] = [];
  for (const entry of files) {
    const raw = readProtectedText(path.join(getAuditDir(), entry));
    if (!raw) continue;

    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        events.push(JSON.parse(lines[index]) as AuditEvent);
      } catch {
        // Ignore malformed lines.
      }

      if (events.length >= limit) {
        return events;
      }
    }
  }

  return events;
}
