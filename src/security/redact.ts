const SENSITIVE_KEY_PATTERN = /(api[_-]?key|private[_-]?key|secret|password|token|authorization|cookie|session|csrf|mnemonic|seed)/i;

function maskHexSecret(value: string): string {
  if (/^0x[a-fA-F0-9]{64}$/.test(value)) {
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }
  return value;
}

export function redactText(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, (match) => maskHexSecret(match))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, 'Bearer ***')
    .replace(/\b(?:api[_-]?key|private[_-]?key|password|token|secret|session|csrf)\s*[:=]\s*([^\s,;]+)/gi, (_, key) => `${key}=[redacted]`);
}

export function sanitizeForAudit(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForAudit(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = '[redacted]';
      continue;
    }
    sanitized[key] = sanitizeForAudit(entry);
  }

  return sanitized;
}
