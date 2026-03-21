import fs from "node:fs";
import path from "node:path";
import { getConfigDir, loadConfig } from "../config.js";
import { readProtectedText, writeProtectedText } from "../security/secure_store.js";

const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const volatileLogs = new Map<string, string>();

function getLogDir(): string {
  return path.join(getConfigDir(), "logs");
}

function getLogPath(date?: Date): string {
  const d = date ?? new Date();
  const dateStr = d.toISOString().split("T")[0];
  return path.join(getLogDir(), `${dateStr}.md`);
}

function buildHeader(d?: Date): string {
  const date = d ?? new Date();
  const dateStr = date.toISOString().split("T")[0];
  return `# Cateo Activity Log - ${dateStr}\n\n`;
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistActivityLog ?? false;
}

function pruneLogs(now = Date.now()): void {
  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) {
    return;
  }
  const cutoff = now - MAX_LOG_AGE_MS;
  for (const entry of fs.readdirSync(logDir)) {
    const fullPath = path.join(logDir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
      volatileLogs.delete(fullPath);
    }
  }
}

export function appendLog(entry: string): void {
  const clean = entry.trim();
  if (!clean) return;

  pruneLogs();
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
  pruneLogs();
  const logPath = getLogPath();
  return volatileLogs.get(logPath) ?? readProtectedText(logPath) ?? "No activity today.";
}

export function readLog(date: Date): string {
  pruneLogs();
  const logPath = getLogPath(date);
  return volatileLogs.get(logPath) ?? readProtectedText(logPath) ?? "";
}