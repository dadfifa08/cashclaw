import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { getCateoHome } from "../system/runtime_paths.js";

const SECURE_PREFIX = "cateo-secure:v1:";

let cachedMasterKey: Buffer | null = null;

function getSecurityDir(): string {
  return path.join(getCateoHome(), "security");
}

function getSecretDir(): string {
  return path.join(getSecurityDir(), "secrets");
}

function getMasterKeyPath(): string {
  return path.join(getSecurityDir(), "master.key");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms that support POSIX-style permissions.
  }
}

function getPowerShellPath(): string {
  if (process.platform !== "win32") return "";
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:/Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShell(script: string, envVars: Record<string, string>): string {
  const executable = getPowerShellPath();
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf-8",
      env: { ...process.env, ...envVars },
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "PowerShell error").trim();
    throw new Error(message || "PowerShell error");
  }

  return result.stdout.trim();
}

function protectMasterKey(plain: string): string {
  if (process.platform !== "win32") {
    return plain;
  }

  return runPowerShell(
    "$secure = ConvertTo-SecureString -String $env:CATEO_SECRET -AsPlainText -Force; ConvertFrom-SecureString -SecureString $secure",
    { CATEO_SECRET: plain },
  );
}

function unprotectMasterKey(blob: string): string {
  if (process.platform !== "win32") {
    return blob;
  }

  return runPowerShell(
    "$secure = ConvertTo-SecureString -String $env:CATEO_BLOB; $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }",
    { CATEO_BLOB: blob },
  );
}

function getMasterKey(): Buffer {
  if (cachedMasterKey) {
    return cachedMasterKey;
  }

  const securityDir = getSecurityDir();
  const masterKeyPath = getMasterKeyPath();
  ensureDir(securityDir);

  if (fs.existsSync(masterKeyPath)) {
    const stored = fs.readFileSync(masterKeyPath, "utf-8").trim();
    const plain = unprotectMasterKey(stored);
    cachedMasterKey = Buffer.from(plain, "base64");
    return cachedMasterKey;
  }

  const plain = crypto.randomBytes(32).toString("base64");
  atomicWrite(masterKeyPath, protectMasterKey(plain));
  cachedMasterKey = Buffer.from(plain, "base64");
  return cachedMasterKey;
}

function encryptText(text: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return SECURE_PREFIX + JSON.stringify({
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  });
}

function decryptText(raw: string): string {
  if (!raw.startsWith(SECURE_PREFIX)) {
    return raw;
  }

  const payload = JSON.parse(raw.slice(SECURE_PREFIX.length)) as {
    iv: string;
    tag: string;
    data: string;
  };

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getMasterKey(),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

  const text = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);

  return text.toString("utf-8");
}

function sanitizeSecretName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resetSecureStoreCache(): void {
  cachedMasterKey = null;
}

export function writeProtectedText(filePath: string, text: string): void {
  atomicWrite(filePath, encryptText(text));
}

export function readProtectedText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return decryptText(raw);
  } catch {
    return null;
  }
}

export function writeProtectedJson<T>(filePath: string, data: T): void {
  writeProtectedText(filePath, JSON.stringify(data, null, 2));
}

export function readProtectedJson<T>(filePath: string, fallback: T): T {
  const raw = readProtectedText(filePath);
  if (raw === null) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function appendProtectedText(filePath: string, text: string): void {
  const existing = readProtectedText(filePath) ?? "";
  writeProtectedText(filePath, `${existing}${text}`);
}

export function removeProtectedFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function writeProtectedSecret(name: string, value: string): void {
  const secretDir = getSecretDir();
  ensureDir(secretDir);
  writeProtectedText(path.join(secretDir, `${sanitizeSecretName(name)}.secret`), value);
}

export function readProtectedSecret(name: string): string | undefined {
  const value = readProtectedText(path.join(getSecretDir(), `${sanitizeSecretName(name)}.secret`));
  return value === null ? undefined : value;
}

export function deleteProtectedSecret(name: string): void {
  removeProtectedFile(path.join(getSecretDir(), `${sanitizeSecretName(name)}.secret`));
}
