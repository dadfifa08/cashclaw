import crypto from "node:crypto";
import type { AuthenticatedOperator } from "./operators.js";

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_BASE_MS = 60 * 1000;
const LOCKOUT_MAX_MS = 15 * 60 * 1000;
const MAX_FAILURES_BEFORE_LOCKOUT = 5;

export interface OperatorSessionBinding {
  remoteAddress?: string;
  userAgent?: string;
}

export interface OperatorSessionRecord {
  sessionId: string;
  csrfToken: string;
  operator: AuthenticatedOperator;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  remoteAddress?: string;
  userAgentHash?: string;
}

export interface LoginThrottleResult {
  allowed: boolean;
  failures: number;
  retryAfterSeconds?: number;
}

interface LoginAttemptRecord {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

function hashBindingValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeBinding(binding: OperatorSessionBinding | null | undefined): Required<OperatorSessionBinding> {
  return {
    remoteAddress: binding?.remoteAddress?.trim() ?? "",
    userAgent: binding?.userAgent?.trim() ?? "",
  };
}

function createSession(operator: AuthenticatedOperator, ttlMs: number, binding?: OperatorSessionBinding): OperatorSessionRecord {
  const now = Date.now();
  const normalizedBinding = normalizeBinding(binding);
  return {
    sessionId: crypto.randomUUID(),
    csrfToken: crypto.randomUUID(),
    operator,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ttlMs,
    remoteAddress: normalizedBinding.remoteAddress || undefined,
    userAgentHash: normalizedBinding.userAgent ? hashBindingValue(normalizedBinding.userAgent) : undefined,
  };
}

function getRetryAfterSeconds(blockedUntil: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((blockedUntil - now) / 1000));
}

function matchesBinding(session: OperatorSessionRecord, binding?: OperatorSessionBinding): boolean {
  const normalizedBinding = normalizeBinding(binding);
  if (session.remoteAddress && normalizedBinding.remoteAddress !== session.remoteAddress) {
    return false;
  }
  if (session.userAgentHash) {
    if (!normalizedBinding.userAgent) {
      return false;
    }
    if (hashBindingValue(normalizedBinding.userAgent) !== session.userAgentHash) {
      return false;
    }
  }
  return true;
}

export function createOperatorSessionManager(options?: { sessionTtlMs?: number }) {
  const sessionTtlMs = Math.max(60_000, options?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
  const sessions = new Map<string, OperatorSessionRecord>();
  const loginAttempts = new Map<string, LoginAttemptRecord>();

  function prune(now = Date.now()): void {
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(sessionId);
      }
    }

    for (const [key, attempt] of loginAttempts) {
      if (attempt.blockedUntil > now) {
        continue;
      }
      if (now - attempt.lastFailureAt > LOGIN_WINDOW_MS) {
        loginAttempts.delete(key);
      }
    }
  }

  function getSession(sessionId: string | null | undefined, binding?: OperatorSessionBinding): OperatorSessionRecord | null {
    prune();
    if (!sessionId) {
      return null;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (session.expiresAt <= Date.now() || !matchesBinding(session, binding)) {
      sessions.delete(sessionId);
      return null;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  function issueSession(operator: AuthenticatedOperator, binding?: OperatorSessionBinding): OperatorSessionRecord {
    prune();
    const session = createSession(operator, sessionTtlMs, binding);
    sessions.set(session.sessionId, session);
    return session;
  }

  function revokeSession(sessionId: string | null | undefined): void {
    if (!sessionId) {
      return;
    }
    sessions.delete(sessionId);
  }

  function revokeUserSessions(userId: string): void {
    for (const [sessionId, session] of sessions) {
      if (session.operator.userId === userId) {
        sessions.delete(sessionId);
      }
    }
  }

  function checkLoginThrottle(key: string): LoginThrottleResult {
    prune();
    const attempt = loginAttempts.get(key);
    if (!attempt) {
      return { allowed: true, failures: 0 };
    }
    const now = Date.now();
    if (attempt.blockedUntil > now) {
      return {
        allowed: false,
        failures: attempt.failures,
        retryAfterSeconds: getRetryAfterSeconds(attempt.blockedUntil, now),
      };
    }
    if (now - attempt.lastFailureAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
      return { allowed: true, failures: 0 };
    }
    return { allowed: true, failures: attempt.failures };
  }

  function recordFailedLogin(key: string): LoginThrottleResult {
    const now = Date.now();
    const current = loginAttempts.get(key);
    const failures = current && now - current.lastFailureAt <= LOGIN_WINDOW_MS ? current.failures + 1 : 1;
    const lockMultiplier = failures >= MAX_FAILURES_BEFORE_LOCKOUT ? failures - MAX_FAILURES_BEFORE_LOCKOUT + 1 : 0;
    const blockedUntil = lockMultiplier > 0
      ? now + Math.min(LOCKOUT_BASE_MS * 2 ** (lockMultiplier - 1), LOCKOUT_MAX_MS)
      : 0;
    loginAttempts.set(key, {
      failures,
      lastFailureAt: now,
      blockedUntil,
    });
    if (blockedUntil > now) {
      return {
        allowed: false,
        failures,
        retryAfterSeconds: getRetryAfterSeconds(blockedUntil, now),
      };
    }
    return { allowed: true, failures };
  }

  function clearLoginThrottle(key: string): void {
    loginAttempts.delete(key);
  }

  function snapshot() {
    prune();
    return {
      activeSessions: sessions.size,
      throttledKeys: [...loginAttempts.values()].filter((entry) => entry.blockedUntil > Date.now()).length,
    };
  }

  return {
    getSession,
    issueSession,
    revokeSession,
    revokeUserSessions,
    checkLoginThrottle,
    recordFailedLogin,
    clearLoginThrottle,
    snapshot,
  };
}