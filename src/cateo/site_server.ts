import http from "node:http";
import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { handleCateoInternalApi, INTERNAL_CATEO_PREFIX } from "./http_api.js";
import { getInternalServiceToken } from "../system/service_auth.js";

const DEFAULT_SITE_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_SITE_BRIDGE_PORT = 3788;

export interface CateoSiteBridgeSettings {
  host: string;
  port: number;
  baseUrl: string;
}

export function getCateoSiteBridgeHost(): string {
  return process.env.CATEO_SITE_HOST?.trim() || DEFAULT_SITE_BRIDGE_HOST;
}

export function getCateoSiteBridgePort(): number {
  const raw = process.env.CATEO_SITE_PORT?.trim();
  const parsed = raw ? Number(raw) : DEFAULT_SITE_BRIDGE_PORT;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_SITE_BRIDGE_PORT;
}

export function resolveCateoSiteBridgeSettings(): CateoSiteBridgeSettings {
  const host = getCateoSiteBridgeHost();
  const port = getCateoSiteBridgePort();
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
  };
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function setHeaders(res: http.ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}

function hasValidInternalToken(req: http.IncomingMessage, expectedToken: string): boolean {
  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  const expectedBuffer = Buffer.from(expectedToken);
  const presentedBuffer = Buffer.from(presented);
  if (expectedBuffer.length !== presentedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, presentedBuffer);
}

export async function startCateoSiteBridge(
  settings: CateoSiteBridgeSettings = resolveCateoSiteBridgeSettings(),
): Promise<http.Server> {
  const internalServiceToken = getInternalServiceToken();

  const server = http.createServer(async (req, res) => {
    setHeaders(res);
    const requestId = crypto.randomUUID();
    const url = new URL(req.url ?? "/", settings.baseUrl);
    const action = `${req.method ?? "GET"} ${url.pathname}`;

    res.on("finish", () => {
      appendAuditEvent({
        actor: "server",
        category: "site_bridge",
        action,
        outcome: String(res.statusCode),
        message: `${action} -> ${res.statusCode}`,
        requestId,
        severity: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        metadata: { remoteAddress: req.socket.remoteAddress },
      });
    });

    if (url.pathname === "/healthz") {
      json(res, {
        ok: true,
        configured: !!loadConfig(),
        internalApiPrefix: INTERNAL_CATEO_PREFIX,
        localOnlyListener: settings.baseUrl,
      });
      return;
    }

    if (!url.pathname.startsWith(INTERNAL_CATEO_PREFIX)) {
      json(res, { error: "Not found" }, 404);
      return;
    }

    if (!hasValidInternalToken(req, internalServiceToken)) {
      json(res, { error: "Unauthorized" }, 403);
      return;
    }

    await handleCateoInternalApi(url.pathname, req, res, loadConfig(), requestId);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => resolve());
  });

  appendAuditEvent({
    actor: "server",
    category: "runtime",
    action: "site_bridge_start",
    outcome: "success",
    message: `Cateo site bridge listening on ${settings.baseUrl}`,
    metadata: { host: settings.host, port: settings.port },
  });

  server.on("close", () => {
    appendAuditEvent({
      actor: "server",
      category: "runtime",
      action: "site_bridge_stop",
      outcome: "success",
      message: `Cateo site bridge stopped on ${settings.baseUrl}`,
      metadata: { host: settings.host, port: settings.port },
    });
  });

  return server;
}

