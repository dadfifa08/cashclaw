import fs from "node:fs";
import path from "node:path";

let loaded = false;
let loadedFiles: string[] = [];

function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const clean = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = clean.indexOf("=");
    if (separator <= 0) continue;
    const key = clean.slice(0, separator).trim();
    let value = clean.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function applyEnvFile(filePath: string): void {
  const text = fs.readFileSync(filePath, "utf8");
  const parsed = parseEnvText(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function loadRuntimeEnv(baseDir = process.cwd()): string[] {
  if (loaded) {
    return [...loadedFiles];
  }

  const candidates = [
    path.join(baseDir, ".env"),
    path.join(baseDir, ".env.local"),
  ];

  loadedFiles = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    applyEnvFile(candidate);
    loadedFiles.push(candidate);
  }

  loaded = true;
  return [...loadedFiles];
}

export function getLoadedEnvFiles(): string[] {
  return [...loadedFiles];
}
