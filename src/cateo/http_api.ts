import http from "node:http";
import { createModelRuntime } from "../llm/runtime.js";
import { loadArtifactRecord } from "./store.js";
import { generateCateoArtifacts, reviseCateoArtifact, signOffCateoArtifact } from "./service.js";
import type { CashClawConfig } from "../config.js";
import type { CateoAssistInput, CateoRevisionRequest, CateoSignoffRequest } from "./types.js";
import { getPilotProfile, upsertPilotProfile } from "./profiles.js";
import { readRequestBody } from "../system/request_body.js";

export const INTERNAL_CATEO_PREFIX = "/internal/cateo";
const MAX_BODY_BYTES = 20_971_520;
const PROFILE_HEADER = "x-cateo-profile-id";
const REQUESTER_HEADER = "x-cateo-client-id";
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const REQUESTER_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return readRequestBody(req, { maxBytes: MAX_BODY_BYTES });
}

function parseJsonBody<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
}

function getProfileId(req: http.IncomingMessage): string | null {
  const header = req.headers[PROFILE_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  const profileId = raw?.trim();
  if (!profileId) {
    return null;
  }
  return PROFILE_ID_PATTERN.test(profileId) ? profileId : null;
}

function getRequesterId(req: http.IncomingMessage): string | null {
  const header = req.headers[REQUESTER_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  const requesterId = raw?.trim();
  if (!requesterId) {
    return null;
  }
  return REQUESTER_ID_PATTERN.test(requesterId) ? requesterId : null;
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
        orchestration: createModelRuntime(config).meta,
        pilot: config.pilot ?? null,
        localOnly: true,
      });
      return;
    case `${INTERNAL_CATEO_PREFIX}/profile`:
      if (req.method === "GET") {
        const profileId = getProfileId(req);
        if (!profileId) {
          json(res, { error: "Missing or invalid X-Cateo-Profile-Id" }, 400);
          return;
        }
        const requesterId = getRequesterId(req) ?? undefined;
        const profile = getPilotProfile(config, profileId, requesterId, requestId);
        if (!profile) {
          json(res, { error: "Pilot profile not found" }, 404);
          return;
        }
        json(res, { ok: true, profile });
        return;
      }
      if (req.method !== "POST") {
        json(res, { error: "GET or POST only" }, 405);
        return;
      }
      {
        const body = parseJsonBody<{ displayName?: string; email?: string; organization?: string }>(await readBody(req));
        const profile = upsertPilotProfile(config, {
          profileId: getProfileId(req) ?? undefined,
          requesterId: getRequesterId(req) ?? undefined,
          displayName: body.displayName,
          email: body.email,
          organization: body.organization,
        }, requestId);
        json(res, { ok: true, profile });
        return;
      }
    case `${INTERNAL_CATEO_PREFIX}/assist`:
      if (req.method !== "POST") {
        json(res, { error: "POST only" }, 405);
        return;
      }
      {
        const input = parseJsonBody<CateoAssistInput>(await readBody(req));
        const runtime = createModelRuntime(config);
        const profileId = getProfileId(req) ?? undefined;
        const requesterId = getRequesterId(req) ?? undefined;
        const profile = profileId ? getPilotProfile(config, profileId, requesterId, requestId) : null;
        const result = await generateCateoArtifacts(config, runtime, input, {
          actor: "site",
          requestId,
          requester: profile && requesterId ? {
            profileId: profile.profileId,
            requesterId,
            displayName: profile.displayName,
            organization: profile.organization,
          } : undefined,
        });
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