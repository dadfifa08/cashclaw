import path from "node:path";
import { getConfigDir, loadConfig } from "../config.js";
import { appendProtectedText, readProtectedText, writeProtectedText } from "../security/secure_store.js";

const volatileLogs = new Map<string, string>();

function getLogPath(date?: Date): string {
  const d = date ?? new Date();
  const dateStr = d.toISOString().split("T")[0];
  return path.join(getConfigDir(), "logs", `${dateStr}.md`);
}

function buildHeader(d?: Date): string {
  const date = d ?? new Date();
  const dateStr = date.toISOString().split("T")[0];
  return `# Cateo Activity Log - ${dateStr}\n\n`;
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistActivityLog ?? true;
}

export function appendLog(entry: string): void {
  const clean = entry.trim();
  if (!clean) return;

  const logPath = getLogPath();
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  const line = `- \`${timestamp}\` ${clean}\n`;
  const existing = volatileLogs.get(logPath) ?? readProtectedText(logPath) ?? buildHeader();
  const next = existing.endsWith("\n\n") || existing.endsWith("\n")
    ? `${existing}${line}`
    : `${existing}\n${line}`;

  volatileLogs.set(logPath, next);
  if (shouldPersist()) {
    writeProtectedText(logPath, next);
  }
}

export function readTodayLog(): string {
  const logPath = getLogPath();
  return volatileLogs.get(logPath) ?? readProtectedText(logPath) ?? "No activity today.";
}

export function readLog(date: Date): string {
  const logPath = getLogPath(date);
  return volatileLogs.get(logPath) ?? readProtectedText(logPath) ?? "";
}
