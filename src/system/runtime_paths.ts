import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_HOME_DIR = ".cashclaw";
const DEFAULT_CONTROL_HOST = "127.0.0.1";
const DEFAULT_CONTROL_PORT = 3777;

export interface PreferredControlEndpoint {
  mode: "named-pipe" | "http";
  endpoint: string;
  fallbackHttpUrl: string;
}

export interface RuntimeControlSettings {
  host: string;
  port: number;
  baseUrl: string;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  preferredControlEndpoint: PreferredControlEndpoint;
}

export function getCateoHome(): string {
  const override = process.env.CATEO_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), DEFAULT_HOME_DIR);
}

export function getConfigPath(): string {
  return path.join(getCateoHome(), "cashclaw.json");
}

export function getControlHost(): string {
  return process.env.CATEO_HOST?.trim() || DEFAULT_CONTROL_HOST;
}

export function getControlPort(): number {
  const raw = process.env.CATEO_PORT?.trim();
  const parsed = raw ? Number(raw) : DEFAULT_CONTROL_PORT;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_CONTROL_PORT;
}

export function getDashboardUrl(): string {
  return `http://${getControlHost()}:${getControlPort()}`;
}

export function getAllowedHosts(): Set<string> {
  const host = getControlHost();
  const port = getControlPort();
  return new Set([`localhost:${port}`, `${host}:${port}`]);
}

export function getAllowedOrigins(): Set<string> {
  const port = getControlPort();
  return new Set([`http://localhost:${port}`, getDashboardUrl()]);
}

export function getPreferredControlEndpoint(): PreferredControlEndpoint {
  const fallbackHttpUrl = getDashboardUrl();
  if (process.platform !== "win32") {
    return { mode: "http", endpoint: fallbackHttpUrl, fallbackHttpUrl };
  }

  const identity = `${os.userInfo().username}:${getCateoHome()}`;
  const scope = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return {
    mode: "named-pipe",
    endpoint: `\\\\.\\pipe\\cateo-control-${scope}`,
    fallbackHttpUrl,
  };
}

export function resolveRuntimeControlSettings(): RuntimeControlSettings {
  const host = getControlHost();
  const port = getControlPort();
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    allowedHosts: getAllowedHosts(),
    allowedOrigins: getAllowedOrigins(),
    preferredControlEndpoint: getPreferredControlEndpoint(),
  };
}
