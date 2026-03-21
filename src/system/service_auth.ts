import crypto from "node:crypto";
import { readProtectedSecret, writeProtectedSecret } from "../security/secure_store.js";

const INTERNAL_TOKEN_SECRET = "cateo-internal-service-token";
const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
const SIGNATURE_VERSION = "cateo-internal-v1";

export const INTERNAL_AUTH_HEADERS = {
  timestamp: "x-cateo-timestamp",
  nonce: "x-cateo-nonce",
  bodySha256: "x-cateo-content-sha256",
  signature: "x-cateo-signature",
  clientId: "x-cateo-client-id",
  profileId: "x-cateo-profile-id",
} as const;

export interface InternalRequestSignatureInput {
  method: string;
  path: string;
  body?: string;
  timestamp?: number;
  nonce?: string;
  clientId?: string;
  profileId?: string;
  contentType?: string;
  accept?: string;
}

export interface InternalRequestVerificationResult {
  ok: boolean;
  reason?: string;
  body: string;
}

export function getInternalServiceToken(): string {
  const fromEnv = process.env.CATEO_INTERNAL_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const existing = readProtectedSecret(INTERNAL_TOKEN_SECRET)?.trim();
  if (existing) {
    return existing;
  }

  const generated = crypto.randomBytes(32).toString("base64url");
  writeProtectedSecret(INTERNAL_TOKEN_SECRET, generated);
  return generated;
}

export function hashInternalRequestBody(body: string): string {
  return crypto.createHash("sha256").update(body).digest("base64url");
}

function normalizeHeaderValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

function buildCanonicalPayload(
  input: Required<Pick<InternalRequestSignatureInput, "method" | "path" | "body" | "timestamp" | "nonce">> & {
    clientId?: string;
    profileId?: string;
    contentType?: string;
    accept?: string;
  },
): string {
  return [
    SIGNATURE_VERSION,
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    hashInternalRequestBody(input.body),
    normalizeHeaderValue(input.clientId),
    normalizeHeaderValue(input.profileId),
    normalizeHeaderValue(input.contentType),  ].join("\n");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function computeSignature(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signInternalRequest(secret: string, input: InternalRequestSignatureInput): Record<string, string> {
  const body = input.body ?? "";
  const timestamp = Number.isFinite(input.timestamp) ? Math.trunc(input.timestamp as number) : Date.now();
  const nonce = input.nonce?.trim() || crypto.randomBytes(18).toString("base64url");
  const canonicalPayload = buildCanonicalPayload({
    method: input.method,
    path: input.path,
    body,
    timestamp,
    nonce,
    clientId: input.clientId,
    profileId: input.profileId,
    contentType: input.contentType,
    accept: input.accept,
  });

  return {
    [INTERNAL_AUTH_HEADERS.timestamp]: String(timestamp),
    [INTERNAL_AUTH_HEADERS.nonce]: nonce,
    [INTERNAL_AUTH_HEADERS.bodySha256]: hashInternalRequestBody(body),
    [INTERNAL_AUTH_HEADERS.signature]: computeSignature(secret, canonicalPayload),
  };
}

function headerValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = raw?.trim();
  return normalized ? normalized : null;
}

function isReasonableNonce(value: string): boolean {
  return /^[a-zA-Z0-9_-]{16,160}$/.test(value);
}

export function createInternalRequestVerifier(
  secret: string,
  options?: { maxSkewMs?: number; nonceTtlMs?: number },
) {
  const maxSkewMs = Math.max(30_000, options?.maxSkewMs ?? DEFAULT_MAX_SKEW_MS);
  const nonceTtlMs = Math.max(maxSkewMs, options?.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS);
  const seenNonces = new Map<string, number>();

  function prune(now = Date.now()): void {
    for (const [nonce, expiresAt] of seenNonces) {
      if (expiresAt <= now) {
        seenNonces.delete(nonce);
      }
    }
  }

  async function verify(
    req: { method?: string; headers: Record<string, string | string[] | undefined> },
    path: string,
    readBody: () => Promise<string>,
  ): Promise<InternalRequestVerificationResult> {
    prune();

    const timestampRaw = headerValue(req.headers[INTERNAL_AUTH_HEADERS.timestamp]);
    const nonce = headerValue(req.headers[INTERNAL_AUTH_HEADERS.nonce]);
    const presentedBodyHash = headerValue(req.headers[INTERNAL_AUTH_HEADERS.bodySha256]);
    const presentedSignature = headerValue(req.headers[INTERNAL_AUTH_HEADERS.signature]);

    if (!timestampRaw || !nonce || !presentedBodyHash || !presentedSignature) {
      return { ok: false, reason: "Missing signed internal request headers", body: "" };
    }

    if (!isReasonableNonce(nonce)) {
      return { ok: false, reason: "Malformed internal request nonce", body: "" };
    }

    const timestamp = Number(timestampRaw);
    if (!Number.isFinite(timestamp)) {
      return { ok: false, reason: "Invalid internal request timestamp", body: "" };
    }

    const now = Date.now();
    if (Math.abs(now - timestamp) > maxSkewMs) {
      return { ok: false, reason: "Signed internal request expired", body: "" };
    }

    if (seenNonces.has(nonce)) {
      return { ok: false, reason: "Signed internal request replay detected", body: "" };
    }

    const body = await readBody();
    const actualBodyHash = hashInternalRequestBody(body);
    if (!safeEqual(actualBodyHash, presentedBodyHash)) {
      return { ok: false, reason: "Signed internal request body digest mismatch", body };
    }

    const canonicalPayload = buildCanonicalPayload({
      method: req.method ?? "GET",
      path,
      body,
      timestamp,
      nonce,
      clientId: headerValue(req.headers[INTERNAL_AUTH_HEADERS.clientId]) ?? undefined,
      profileId: headerValue(req.headers[INTERNAL_AUTH_HEADERS.profileId]) ?? undefined,
      contentType: headerValue(req.headers["content-type"]) ?? undefined,    });
    const expectedSignature = computeSignature(secret, canonicalPayload);
    if (!safeEqual(expectedSignature, presentedSignature)) {
      return { ok: false, reason: "Signed internal request signature mismatch", body };
    }

    seenNonces.set(nonce, now + nonceTtlMs);
    return { ok: true, body };
  }

  return { verify };
}