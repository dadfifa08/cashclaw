import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_WINDOW = 1;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

function normalizeSecret(secret: string): string {
  return secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

function base32Encode(buffer: Buffer): string {
  let bits = "";
  for (const value of buffer) {
    bits += value.toString(2).padStart(8, "0");
  }

  let encoded = "";
  for (let offset = 0; offset < bits.length; offset += 5) {
    const chunk = bits.slice(offset, offset + 5).padEnd(5, "0");
    encoded += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }
  return encoded;
}

function base32Decode(secret: string): Buffer {
  const normalized = normalizeSecret(secret);
  let bits = "";
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      continue;
    }
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function formatManualKey(secret: string): string {
  return normalizeSecret(secret).replace(/(.{4})/g, "$1 ").trim();
}

function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, "0");
}

function counterFor(timestampMs: number, periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(timestampMs / 1000 / periodSeconds);
}

export function generateTotpSecret(lengthBytes = 20): string {
  return base32Encode(crypto.randomBytes(lengthBytes));
}

export function buildTotpProvisioningUri(args: { secret: string; accountName: string; issuer: string }): string {
  const label = `${args.issuer}:${args.accountName}`;
  const params = new URLSearchParams({
    secret: normalizeSecret(args.secret),
    issuer: args.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function verifyTotpCode(secret: string, code: string, options?: { timestampMs?: number; window?: number; periodSeconds?: number; digits?: number }): boolean {
  const normalizedCode = code.replace(/\s+/g, "").trim();
  if (!/^\d{6,8}$/.test(normalizedCode)) {
    return false;
  }
  const timestampMs = options?.timestampMs ?? Date.now();
  const window = Math.max(0, options?.window ?? TOTP_WINDOW);
  const periodSeconds = Math.max(15, options?.periodSeconds ?? TOTP_PERIOD_SECONDS);
  const digits = Math.max(6, Math.min(8, options?.digits ?? TOTP_DIGITS));
  const baseCounter = counterFor(timestampMs, periodSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    if (hotp(secret, baseCounter + offset, digits) === normalizedCode) {
      return true;
    }
  }
  return false;
}

export function describeTotpSecret(secret: string): { secret: string; manualEntryKey: string } {
  const normalized = normalizeSecret(secret);
  return {
    secret: normalized,
    manualEntryKey: formatManualKey(normalized),
  };
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: Math.max(4, count) }, () => {
    const left = crypto.randomBytes(3).toString("hex").toUpperCase();
    const right = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `${left}-${right}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function verifyRecoveryCode(code: string, hashes: string[]): { valid: boolean; remainingHashes: string[] } {
  const hash = hashRecoveryCode(code);
  const index = hashes.indexOf(hash);
  if (index === -1) {
    return { valid: false, remainingHashes: hashes };
  }
  return {
    valid: true,
    remainingHashes: hashes.filter((_, currentIndex) => currentIndex !== index),
  };
}