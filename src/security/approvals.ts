import crypto from "node:crypto";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "./secure_store.js";

export type ApprovalStatus = "pending" | "executed" | "rejected" | "failed" | "expired";

export interface ApprovalDraft {
  toolName: string;
  summary: string;
  reason: string;
  input: Record<string, unknown>;
  taskId?: string;
  taskStatus?: string;
  taskVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequest extends ApprovalDraft {
  id: string;
  status: ApprovalStatus;
  createdAt: number;
  updatedAt: number;
  outcome?: string;
  decisionNote?: string;
}

const MAX_APPROVALS = 300;

function getApprovalsPath(): string {
  return path.join(getConfigDir(), "security", "approvals.json");
}

function loadAll(): ApprovalRequest[] {
  return readProtectedJson<ApprovalRequest[]>(getApprovalsPath(), []);
}

function saveAll(entries: ApprovalRequest[]): void {
  writeProtectedJson(getApprovalsPath(), entries.slice(-MAX_APPROVALS));
}

function draftKey(draft: ApprovalDraft): string {
  return JSON.stringify({
    toolName: draft.toolName,
    taskId: draft.taskId,
    taskVersion: draft.taskVersion,
    input: draft.input,
  });
}

export function requestApproval(draft: ApprovalDraft): { approval: ApprovalRequest; created: boolean } {
  const approvals = loadAll();
  const key = draftKey(draft);
  const existing = approvals.find((entry) => entry.status === "pending" && draftKey(entry) === key);
  if (existing) {
    return { approval: existing, created: false };
  }

  const now = Date.now();
  const approval: ApprovalRequest = {
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...draft,
  };

  approvals.push(approval);
  saveAll(approvals);
  return { approval, created: true };
}

export function getApprovals(limit = 200): ApprovalRequest[] {
  return loadAll().slice(-limit).reverse();
}

export function getPendingApprovals(): ApprovalRequest[] {
  return getApprovals().filter((entry) => entry.status === "pending");
}

export function getApproval(id: string): ApprovalRequest | null {
  return loadAll().find((entry) => entry.id === id) ?? null;
}

export function updateApproval(
  id: string,
  status: Exclude<ApprovalStatus, "pending">,
  note?: string,
  outcome?: string,
): ApprovalRequest | null {
  const approvals = loadAll();
  const index = approvals.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return null;
  }

  approvals[index] = {
    ...approvals[index],
    status,
    decisionNote: note,
    outcome,
    updatedAt: Date.now(),
  };
  saveAll(approvals);
  return approvals[index];
}
