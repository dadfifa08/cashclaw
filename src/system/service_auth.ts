import crypto from "node:crypto";
import { readProtectedSecret, writeProtectedSecret } from "../security/secure_store.js";

const INTERNAL_TOKEN_SECRET = "cateo-internal-service-token";

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
