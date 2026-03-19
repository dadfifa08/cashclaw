import http from "node:http";
import { createModelRuntime } from "../llm/runtime.js";
import { loadArtifactRecord } from "./store.js";
import { generateCateoArtifacts, reviseCateoArtifact, signOffCateoArtifact } from "./service.js";
import type { CashClawConfig } from "../config.js";
import type { CateoAssistInput, CateoRevisionRequest, CateoSignoffRequest } from "./types.js";

export const INTERNAL_CATEO_PREFIX = "/internal/cateo";
const MAX_BODY_BYTES = 20_971_520;

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseJsonBody<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
}

export async function handleCateoInternalApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: CashClawConfig | null,
  requestId: string,
): Promise<void> {
  if (!config) {
    json(res, { error: "Cateo runtime is not configured" }, 503);
    return;
  }

  switch (pathname) {
    case `${INTERNAL_CATEO_PREFIX}/health`:
      json(res, {
        ok: true,
        orchestration: config.orchestration,
        localOnly: true,
      });
      return;
    case `${INTERNAL_CATEO_PREFIX}/assist`:
      if (req.method !== "POST") {
        json(res, { error: "POST only" }, 405);
        return;
      }
      {
        const input = parseJsonBody<CateoAssistInput>(await readBody(req));
        const runtime = createModelRuntime(config);
        const result = await generateCateoArtifacts(config, runtime, input, { actor: "site", requestId });
        json(res, result);
        return;
      }
    case `${INTERNAL_CATEO_PREFIX}/artifacts/revise`:
      if (req.method !== "POST") {
        json(res, { error: "POST only" }, 405);
        return;
      }
      {
        const input = parseJsonBody<CateoRevisionRequest>(await readBody(req));
        const artifact = reviseCateoArtifact(input, { requestId });
        json(res, { ok: true, artifact });
        return;
      }
    case `${INTERNAL_CATEO_PREFIX}/artifacts/signoff`:
      if (req.method !== "POST") {
        json(res, { error: "POST only" }, 405);
        return;
      }
      {
        const input = parseJsonBody<CateoSignoffRequest>(await readBody(req));
        const artifact = signOffCateoArtifact(input, { requestId });
        json(res, { ok: true, artifact });
        return;
      }
    case `${INTERNAL_CATEO_PREFIX}/artifacts/get`:
      if (req.method !== "POST") {
        json(res, { error: "POST only" }, 405);
        return;
      }
      {
        const body = parseJsonBody<{ artifactId: string }>(await readBody(req));
        const artifact = loadArtifactRecord(body.artifactId);
        if (!artifact) {
          json(res, { error: "Artifact not found" }, 404);
          return;
        }
        json(res, { artifact });
        return;
      }
    default:
      json(res, { error: "Not found" }, 404);
  }
}
