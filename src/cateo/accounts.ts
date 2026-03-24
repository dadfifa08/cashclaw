import crypto from "node:crypto";
import path from "node:path";
import type { CashClawConfig } from "../config.js";
import { getConfigDir, getPilotConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { authenticateOperator } from "../security/operators.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { getPilotProfile, type CateoProfileSnapshot, updatePilotProfileAdmin, upsertPilotProfile } from "./profiles.js";
import { buildTotpProvisioningUri, describeTotpSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, verifyRecoveryCode, verifyTotpCode } from "./totp.js";

const USER_DB = "cateo-public-users-v2";
const SESSION_DB = "cateo-public-sessions-v1";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const USERNAME = /^[a-z0-9._-]{3,64}$/i;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const LIMIT = 6;
const throttle = new Map<string, { failures: number[]; lockedUntil?: number }>();

export type CateoPublicUserRole = "user" | "admin" | "technical-reviewer" | "quality-reviewer";

interface UserSecurityRec {
  passwordChangedAt?: string;
  twoFactor: {
    enabled: boolean;
    secret?: string;
    pendingSecret?: string;
    recoveryCodeHashes: string[];
    enabledAt?: string;
    lastVerifiedAt?: string;
  };
}

interface UserPreferencesRec {
  timezone?: string;
  responseDetail?: "balanced" | "concise" | "detailed";
  emailUpdates?: boolean;
}

interface UserRec {
  userId: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  status: "active" | "suspended";
  authSource: "local" | "operator";
  email?: string;
  emailHash?: string;
  username?: string;
  displayName: string;
  organization?: string;
  roles: CateoPublicUserRole[];
  requesterIds: string[];
  profileId?: string;
  passwordSalt?: string;
  passwordHash?: string;
  security: UserSecurityRec;
  preferences?: UserPreferencesRec;
}
interface UserFile { version: string; updatedAt: string; users: UserRec[]; }
interface SessionRec { sessionId: string; userId: string; requesterId?: string; createdAt: string; updatedAt: string; expiresAt: string; }
interface SessionFile { version: string; updatedAt: string; sessions: SessionRec[]; }

export interface CateoPublicUserSnapshot {
  userId: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  status: "active" | "suspended";
  email?: string;
  username?: string;
  displayName: string;
  organization?: string;
  roles: CateoPublicUserRole[];
  profileId?: string;
  profile?: CateoProfileSnapshot | null;
  security: {
    twoFactorEnabled: boolean;
    passwordChangedAt?: string;
  };
  preferences?: UserPreferencesRec;
}
export interface CateoPublicSessionSnapshot { sessionId: string; expiresAt: string; user: CateoPublicUserSnapshot; }
export interface CateoTwoFactorSetupSnapshot { manualEntryKey: string; otpauthUrl: string; issuer: string; accountName: string; }
export interface CateoTwoFactorConfirmSnapshot { user: CateoPublicUserSnapshot; recoveryCodes: string[]; }
export class CateoPublicAuthError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); this.name = "CateoPublicAuthError"; } }

const userPath = () => path.join(getConfigDir(), "cateo", "security", "public_users.json");
const sessionPath = () => path.join(getConfigDir(), "cateo", "security", "public_sessions.json");
const loadUsers = () => normalizeUserFile(readProtectedJson<UserFile>(userPath(), { version: USER_DB, updatedAt: new Date(0).toISOString(), users: [] }));
const saveUsers = (file: UserFile) => writeProtectedJson(userPath(), normalizeUserFile(file));
const loadSessions = () => readProtectedJson<SessionFile>(sessionPath(), { version: SESSION_DB, updatedAt: new Date(0).toISOString(), sessions: [] });
const saveSessions = (file: SessionFile) => writeProtectedJson(sessionPath(), file);
const hashEmail = (email?: string) => email ? crypto.createHash("sha256").update(email).digest("hex") : undefined;
const hashPassword = (password: string, salt: string) => crypto.scryptSync(password, salt, 64).toString("base64");
const verifyPassword = (password: string, salt: string, expected: string) => { const left = Buffer.from(hashPassword(password, salt), "base64"); const right = Buffer.from(expected, "base64"); return left.length === right.length && crypto.timingSafeEqual(left, right); };
const nowIso = () => new Date().toISOString();
const trim = (value?: string) => value?.trim() || undefined;
function normalizeEmail(value?: string) { const email = trim(value)?.toLowerCase(); if (!email) return undefined; if (!EMAIL.test(email)) throw new CateoPublicAuthError("EMAIL_INVALID", "Enter a valid email address."); return email; }
function normalizeUsername(value?: string) { const username = trim(value); if (!username) return undefined; if (!USERNAME.test(username)) throw new CateoPublicAuthError("USERNAME_INVALID", "Usernames must be 3-64 characters and use letters, numbers, dots, underscores, or hyphens."); return username; }
function touchRequester(record: UserRec, requesterId?: string) { const id = trim(requesterId); if (!id) return; record.requesterIds = [id, ...record.requesterIds.filter((entry) => entry !== id)].slice(0, 20); }
function profileIdFor(config: CashClawConfig, record: UserRec, requesterId?: string, requestId?: string) {
  const profile = upsertPilotProfile(config, {
    profileId: record.profileId,
    requesterId,
    displayName: record.displayName,
    email: record.email,
    organization: record.organization,
  }, requestId);

  if (record.roles.includes("admin")) {
    updatePilotProfileAdmin(config, profile.profileId, {
      serviceTier: "enterprise",
      reviewedOutputs: true,
      artifactDownloadAccess: true,
      status: "active",
      displayName: record.displayName,
      organization: record.organization,
    }, requestId);
  }

  return profile.profileId;
}
function userSnapshot(config: CashClawConfig, record: UserRec): CateoPublicUserSnapshot { const normalized = normalizeUserRecord(record); return { userId: normalized.userId, createdAt: normalized.createdAt, updatedAt: normalized.updatedAt, lastLoginAt: normalized.lastLoginAt, status: normalized.status, email: normalized.email, username: normalized.username, displayName: normalized.displayName, organization: normalized.organization, roles: [...normalized.roles], profileId: normalized.profileId, profile: normalized.profileId ? getPilotProfile(config, normalized.profileId, normalized.requesterIds[0]) ?? null : null, security: { twoFactorEnabled: normalized.security.twoFactor.enabled, passwordChangedAt: normalized.security.passwordChangedAt }, preferences: normalized.preferences }; }
function saveUser(config: CashClawConfig, store: UserFile, record: UserRec) { const normalized = normalizeUserRecord(record); const users = store.users.filter((entry) => entry.userId !== normalized.userId); users.push(normalized); saveUsers({ version: USER_DB, updatedAt: nowIso(), users }); return userSnapshot(config, normalized); }
function guardLogin(identifier: string, requesterId?: string) { const key = `${identifier.toLowerCase()}::${requesterId ?? "anon"}`; const state = throttle.get(key); const now = Date.now(); if (!state) return; state.failures = state.failures.filter((stamp) => now - stamp <= WINDOW_MS); if (state.lockedUntil && state.lockedUntil > now) throw new CateoPublicAuthError("LOGIN_THROTTLED", "Too many login attempts. Try again later.", 429); if (state.lockedUntil && state.lockedUntil <= now) throttle.delete(key); }
function failedLogin(identifier: string, requesterId?: string) { const key = `${identifier.toLowerCase()}::${requesterId ?? "anon"}`; const state = throttle.get(key) ?? { failures: [] as number[] }; const now = Date.now(); state.failures = state.failures.filter((stamp) => now - stamp <= WINDOW_MS); state.failures.push(now); if (state.failures.length >= LIMIT) state.lockedUntil = now + LOCK_MS; throttle.set(key, state); }
const clearLogin = (identifier: string, requesterId?: string) => throttle.delete(`${identifier.toLowerCase()}::${requesterId ?? "anon"}`);
function findUser(store: UserFile, identifier: string) { const id = identifier.trim().toLowerCase(); return store.users.find((entry) => entry.email?.toLowerCase() === id || entry.username?.toLowerCase() === id) ?? null; }
function requireUser(store: UserFile, userId: string): UserRec { const user = store.users.find((entry) => entry.userId === userId && entry.status === "active"); if (!user) throw new CateoPublicAuthError("USER_NOT_FOUND", "User not found.", 404); return normalizeUserRecord(user); }
function defaultSecurity(): UserSecurityRec { return { twoFactor: { enabled: false, recoveryCodeHashes: [] } }; }
function defaultPreferences(record?: Partial<UserRec>): UserPreferencesRec { return { timezone: undefined, responseDetail: "balanced", emailUpdates: Boolean(record?.email) }; }
function normalizePreferences(record: UserRec): UserPreferencesRec { const fallback = defaultPreferences(record); const current = record.preferences ?? {}; return { timezone: trim(current.timezone), responseDetail: current.responseDetail === "concise" || current.responseDetail === "detailed" ? current.responseDetail : fallback.responseDetail, emailUpdates: typeof current.emailUpdates === "boolean" ? current.emailUpdates : fallback.emailUpdates }; }
function normalizeSecurity(security: UserRec["security"] | undefined): UserSecurityRec { const twoFactor = security?.twoFactor; return { passwordChangedAt: trim(security?.passwordChangedAt), twoFactor: { enabled: Boolean(twoFactor?.enabled), secret: trim(twoFactor?.secret), pendingSecret: trim(twoFactor?.pendingSecret), recoveryCodeHashes: Array.isArray(twoFactor?.recoveryCodeHashes) ? twoFactor.recoveryCodeHashes.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [], enabledAt: trim(twoFactor?.enabledAt), lastVerifiedAt: trim(twoFactor?.lastVerifiedAt) } }; }
function normalizeUserRecord(record: UserRec): UserRec { const roles: CateoPublicUserRole[] = Array.isArray(record.roles) && record.roles.length > 0 ? Array.from(new Set(record.roles.filter((role): role is CateoPublicUserRole => role === "user" || role === "admin" || role === "technical-reviewer" || role === "quality-reviewer"))) : ["user"]; const requesterIds = Array.isArray(record.requesterIds) ? [...new Set(record.requesterIds.map((value) => trim(value)).filter((value): value is string => Boolean(value)))] : []; return { ...record, status: record.status === "suspended" ? "suspended" : "active", authSource: record.authSource === "operator" ? "operator" : "local", displayName: trim(record.displayName) || trim(record.username) || trim(record.email) || "Cateo user", organization: trim(record.organization), roles, requesterIds, security: normalizeSecurity(record.security), preferences: normalizePreferences(record) }; }
function normalizeUserFile(file: UserFile): UserFile { return { version: file.version || USER_DB, updatedAt: file.updatedAt || new Date(0).toISOString(), users: (file.users ?? []).map((entry) => normalizeUserRecord(entry)) }; }
function createSession(config: CashClawConfig, record: UserRec, requesterId?: string, requestId?: string): CateoPublicSessionSnapshot { const store = loadSessions(); const expiresAt = new Date(Date.now() + Math.max(1, getPilotConfig(config).sessionTtlDays) * 24 * 60 * 60 * 1000).toISOString(); const sessionId = crypto.randomBytes(36).toString("base64url"); const session: SessionRec = { sessionId, userId: record.userId, requesterId, createdAt: nowIso(), updatedAt: nowIso(), expiresAt }; const sessions = store.sessions.filter((entry) => entry.expiresAt > nowIso() && entry.userId !== record.userId).slice(-40); sessions.push(session); saveSessions({ version: SESSION_DB, updatedAt: nowIso(), sessions }); appendAuditEvent({ actor: "server", category: "public_auth", action: "session_create", outcome: "success", message: `Created public session for ${record.userId}`, requestId, metadata: { userId: record.userId, requesterId } }); return { sessionId, expiresAt, user: userSnapshot(config, record) }; }
function passwordStrengthErrors(password: string, tokens: string[]): string[] { const errors: string[] = []; const normalized = password.trim(); if (normalized.length < 14) errors.push("Use at least 14 characters."); if (!/[a-z]/.test(normalized)) errors.push("Add a lowercase letter."); if (!/[A-Z]/.test(normalized)) errors.push("Add an uppercase letter."); if (!/\d/.test(normalized)) errors.push("Add a number."); if (!/[^A-Za-z0-9]/.test(normalized)) errors.push("Add a symbol."); if (/\s/.test(normalized)) errors.push("Avoid spaces."); if (/(.)\1\1/.test(normalized)) errors.push("Avoid repeated character runs."); for (const token of tokens.map((entry) => entry.toLowerCase()).filter((entry) => entry.length >= 4)) { if (normalized.toLowerCase().includes(token)) { errors.push("Do not include your email, username, or display name in the password."); break; } } return errors; }
function ensureStrongPassword(password: string, context: { email?: string; username?: string; displayName?: string }): void { const errors = passwordStrengthErrors(password, [context.email ?? "", context.username ?? "", ...(context.displayName?.split(/\s+/) ?? [])]); if (errors.length > 0) throw new CateoPublicAuthError("PASSWORD_WEAK", errors.join(" ")); }
function issuerName(): string { return "Cateo"; }
function verifySecondFactor(record: UserRec, otpCode: string | undefined): { ok: boolean; remainingRecoveryHashes?: string[] } { if (!record.security.twoFactor.enabled || !record.security.twoFactor.secret) return { ok: true }; const raw = trim(otpCode); if (!raw) return { ok: false }; if (verifyTotpCode(record.security.twoFactor.secret, raw)) { return { ok: true }; } const recovery = verifyRecoveryCode(raw, record.security.twoFactor.recoveryCodeHashes); if (recovery.valid) { return { ok: true, remainingRecoveryHashes: recovery.remainingHashes }; } return { ok: false }; }

export function registerPublicUser(config: CashClawConfig, input: { email: string; password: string; displayName?: string; organization?: string; username?: string; requesterId?: string }, requestId?: string): CateoPublicSessionSnapshot { const email = normalizeEmail(input.email); const username = normalizeUsername(input.username); const password = trim(input.password); if (!email) throw new CateoPublicAuthError("EMAIL_REQUIRED", "Email is required."); if (!password) throw new CateoPublicAuthError("PASSWORD_REQUIRED", "Password is required."); ensureStrongPassword(password, { email, username, displayName: input.displayName }); const store = loadUsers(); if (store.users.some((entry) => entry.email?.toLowerCase() === email)) throw new CateoPublicAuthError("ACCOUNT_EXISTS", "An account already exists for that email.", 409); if (username && store.users.some((entry) => entry.username?.toLowerCase() === username.toLowerCase())) throw new CateoPublicAuthError("ACCOUNT_EXISTS", "That username is already taken.", 409); const salt = crypto.randomBytes(18).toString("base64url"); const record: UserRec = { userId: crypto.randomUUID(), createdAt: nowIso(), updatedAt: nowIso(), lastLoginAt: nowIso(), status: "active", authSource: "local", email, emailHash: hashEmail(email), username, displayName: trim(input.displayName) || username || email.split("@")[0] || "Cateo user", organization: trim(input.organization), roles: ["user"], requesterIds: [], passwordSalt: salt, passwordHash: hashPassword(password, salt), security: { ...defaultSecurity(), passwordChangedAt: nowIso() }, preferences: defaultPreferences({ email }) }; touchRequester(record, input.requesterId); record.profileId = profileIdFor(config, record, input.requesterId, requestId); saveUser(config, store, record); appendAuditEvent({ actor: "server", category: "public_auth", action: "register", outcome: "success", message: `Registered public user ${record.userId}`, requestId, metadata: { userId: record.userId, requesterId: input.requesterId } }); return createSession(config, record, input.requesterId, requestId); }

export function loginPublicUser(config: CashClawConfig, input: { identifier: string; password: string; otpCode?: string; requesterId?: string }, requestId?: string): CateoPublicSessionSnapshot { const identifier = trim(input.identifier); const password = trim(input.password); if (!identifier || !password) throw new CateoPublicAuthError("LOGIN_REQUIRED", "Enter your email or username and password.", 400); guardLogin(identifier, input.requesterId); const store = loadUsers(); const local = findUser(store, identifier); const completeLogin = (record: UserRec): CateoPublicSessionSnapshot => { const secondFactor = verifySecondFactor(record, input.otpCode); if (!secondFactor.ok) { throw new CateoPublicAuthError("OTP_REQUIRED", "Enter your verification code or a recovery code to finish logging in.", 401); } if (secondFactor.remainingRecoveryHashes) { record.security.twoFactor.recoveryCodeHashes = secondFactor.remainingRecoveryHashes; } record.updatedAt = nowIso(); record.lastLoginAt = nowIso(); record.security.twoFactor.lastVerifiedAt = nowIso(); touchRequester(record, input.requesterId); record.profileId = profileIdFor(config, record, input.requesterId, requestId); saveUser(config, store, record); clearLogin(identifier, input.requesterId); appendAuditEvent({ actor: "server", category: "public_auth", action: "login", outcome: "success", message: `Public user ${record.userId} logged in`, requestId, metadata: { userId: record.userId, requesterId: input.requesterId, twoFactor: record.security.twoFactor.enabled } }); return createSession(config, record, input.requesterId, requestId); };
  if (local?.authSource === "local" && local.passwordSalt && local.passwordHash && verifyPassword(password, local.passwordSalt, local.passwordHash)) {
    return completeLogin(local);
  }
  const operator = authenticateOperator(identifier, password);
  if (operator && (operator.role === "admin" || operator.role === "reviewer")) {
    const roles: CateoPublicUserRole[] = operator.role === "admin"
      ? ["user", "admin", "quality-reviewer"]
      : ["user", "technical-reviewer"];
    const operatorUser = local ?? {
      userId: crypto.randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLoginAt: nowIso(),
      status: "active",
      authSource: "operator",
      username: normalizeUsername(identifier) || identifier,
      displayName: identifier,
      roles,
      requesterIds: [],
      security: defaultSecurity(),
      preferences: defaultPreferences(),
    } as UserRec;
    operatorUser.updatedAt = nowIso();
    operatorUser.lastLoginAt = nowIso();
    operatorUser.roles = roles;
    operatorUser.security = operatorUser.security ?? defaultSecurity();
    operatorUser.preferences = operatorUser.preferences ?? defaultPreferences();
    touchRequester(operatorUser, input.requesterId);
    operatorUser.profileId = profileIdFor(config, operatorUser, input.requesterId, requestId);
    return completeLogin(operatorUser);
  }
  failedLogin(identifier, input.requesterId); appendAuditEvent({ actor: "server", category: "public_auth", action: "login", outcome: "failed", severity: "warn", message: "Public login failed", requestId, metadata: { identifier, requesterId: input.requesterId } }); throw new CateoPublicAuthError("LOGIN_INVALID", "That login was not accepted.", 401); }

export function getPublicSession(config: CashClawConfig, sessionId?: string, requesterId?: string, requestId?: string): CateoPublicSessionSnapshot | null { const id = trim(sessionId); if (!id) return null; const sessions = loadSessions(); const active = sessions.sessions.find((entry) => entry.sessionId === id); if (!active || active.expiresAt <= nowIso()) return null; if (requesterId && active.requesterId && active.requesterId !== requesterId) { appendAuditEvent({ actor: "server", category: "public_auth", action: "session_mismatch", outcome: "denied", severity: "warn", message: "Rejected public session because the requester identity changed", requestId, metadata: { requesterId, storedRequesterId: active.requesterId } }); return null; } const store = loadUsers(); const user = store.users.find((entry) => entry.userId === active.userId && entry.status === "active"); if (!user) return null; touchRequester(user, requesterId); user.profileId = profileIdFor(config, user, requesterId, requestId); saveUser(config, store, user); active.updatedAt = nowIso(); if (requesterId) active.requesterId = requesterId; saveSessions({ version: SESSION_DB, updatedAt: nowIso(), sessions: [...sessions.sessions.filter((entry) => entry.sessionId !== id && entry.expiresAt > nowIso()), active] }); return { sessionId: active.sessionId, expiresAt: active.expiresAt, user: userSnapshot(config, user) }; }
export function logoutPublicSession(sessionId?: string, requestId?: string) { const id = trim(sessionId); if (!id) return; const store = loadSessions(); const sessions = store.sessions.filter((entry) => entry.sessionId !== id); if (sessions.length !== store.sessions.length) { saveSessions({ version: SESSION_DB, updatedAt: nowIso(), sessions }); appendAuditEvent({ actor: "server", category: "public_auth", action: "logout", outcome: "success", message: "Public session ended", requestId, metadata: { sessionId: id } }); } }
export function listPublicUsers(config: CashClawConfig) { return loadUsers().users.filter((entry) => entry.status === "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((entry) => userSnapshot(config, entry)); }
export function getPublicUserById(config: CashClawConfig, userId: string): CateoPublicUserSnapshot | null { const store = loadUsers(); const user = store.users.find((entry) => entry.userId === userId && entry.status === "active"); return user ? userSnapshot(config, user) : null; }

export function reauthorizePublicUser(config: CashClawConfig, userId: string, input: { password: string; otpCode?: string }, requestId?: string): CateoPublicUserSnapshot {
  const store = loadUsers();
  const user = requireUser(store, userId);
  const password = trim(input.password);
  if (!password) {
    throw new CateoPublicAuthError("PASSWORD_REQUIRED", "Enter your password to approve this release.", 400);
  }

  if (user.authSource === "local" && user.passwordSalt && user.passwordHash && verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    const secondFactor = verifySecondFactor(user, input.otpCode);
    if (!secondFactor.ok) {
      throw new CateoPublicAuthError("OTP_REQUIRED", "Enter your verification code or a recovery code to approve this release.", 401);
    }
    if (secondFactor.remainingRecoveryHashes) {
      user.security.twoFactor.recoveryCodeHashes = secondFactor.remainingRecoveryHashes;
    }
    user.updatedAt = nowIso();
    user.security.twoFactor.lastVerifiedAt = nowIso();
    const snapshot = saveUser(config, store, user);
    appendAuditEvent({ actor: "server", category: "public_auth", action: "reauthorize", outcome: "success", message: `Reauthorized public user ${user.userId} for release approval`, requestId, metadata: { userId: user.userId, authSource: user.authSource } });
    return snapshot;
  }

  if (user.roles.includes("admin")) {
    const identifiers = [user.username, user.email, user.displayName].filter((value): value is string => Boolean(value));
    const matched = identifiers.some((identifier) => {
      const operator = authenticateOperator(identifier, password);
      return Boolean(operator && operator.role === "admin");
    });
    if (matched) {
      user.updatedAt = nowIso();
      const snapshot = saveUser(config, store, user);
      appendAuditEvent({ actor: "server", category: "public_auth", action: "reauthorize", outcome: "success", message: `Reauthorized admin user ${user.userId} for release approval`, requestId, metadata: { userId: user.userId, authSource: user.authSource } });
      return snapshot;
    }
  }

  appendAuditEvent({ actor: "server", category: "public_auth", action: "reauthorize", outcome: "failed", severity: "warn", message: `Failed release reauthorization for ${user.userId}`, requestId, metadata: { userId: user.userId } });
  throw new CateoPublicAuthError("PASSWORD_INVALID", "That password was not accepted for release approval.", 401);
}

export function updatePublicUserProfile(config: CashClawConfig, userId: string, input: { displayName?: string; organization?: string; username?: string; email?: string; timezone?: string; responseDetail?: "balanced" | "concise" | "detailed"; emailUpdates?: boolean }, requestId?: string): CateoPublicUserSnapshot {
  const store = loadUsers();
  const user = requireUser(store, userId);
  const email = input.email !== undefined ? normalizeEmail(input.email) : user.email;
  const username = input.username !== undefined ? normalizeUsername(input.username) : user.username;
  if (email && store.users.some((entry) => entry.userId !== userId && entry.email?.toLowerCase() === email.toLowerCase())) throw new CateoPublicAuthError("ACCOUNT_EXISTS", "Another account already uses that email.", 409);
  if (username && store.users.some((entry) => entry.userId !== userId && entry.username?.toLowerCase() === username.toLowerCase())) throw new CateoPublicAuthError("ACCOUNT_EXISTS", "That username is already taken.", 409);
  user.email = email;
  user.emailHash = hashEmail(email);
  user.username = username;
  user.displayName = trim(input.displayName) || user.displayName;
  user.organization = trim(input.organization) || undefined;
  user.updatedAt = nowIso();
  user.profileId = profileIdFor(config, user, user.requesterIds[0], requestId);
  user.preferences = {
    ...(user.preferences ?? defaultPreferences(user)),
    timezone: trim(input.timezone),
    responseDetail: input.responseDetail ?? user.preferences?.responseDetail ?? "balanced",
    emailUpdates: input.emailUpdates ?? user.preferences?.emailUpdates ?? Boolean(user.email),
  };
  const snapshot = saveUser(config, store, user);
  appendAuditEvent({ actor: "server", category: "public_profile", action: "update_profile", outcome: "success", message: `Updated public profile ${userId}`, requestId, metadata: { userId, username, hasEmail: Boolean(email) } });
  return snapshot;
}

export function changePublicUserPassword(config: CashClawConfig, userId: string, input: { currentPassword: string; newPassword: string }, requestId?: string): CateoPublicUserSnapshot {
  const store = loadUsers();
  const user = requireUser(store, userId);
  if (user.authSource !== "local" || !user.passwordSalt || !user.passwordHash) throw new CateoPublicAuthError("PASSWORD_UNAVAILABLE", "This account does not manage a local password.", 400);
  if (!verifyPassword(input.currentPassword, user.passwordSalt, user.passwordHash)) throw new CateoPublicAuthError("PASSWORD_INVALID", "Current password is not correct.", 401);
  ensureStrongPassword(input.newPassword, { email: user.email, username: user.username, displayName: user.displayName });
  const salt = crypto.randomBytes(18).toString("base64url");
  user.passwordSalt = salt;
  user.passwordHash = hashPassword(input.newPassword, salt);
  user.security.passwordChangedAt = nowIso();
  user.updatedAt = nowIso();
  const snapshot = saveUser(config, store, user);
  appendAuditEvent({ actor: "server", category: "public_profile", action: "change_password", outcome: "success", message: `Changed password for public user ${userId}`, requestId, metadata: { userId } });
  return snapshot;
}

export function beginPublicUserTwoFactorSetup(_config: CashClawConfig, userId: string, requestId?: string): CateoTwoFactorSetupSnapshot {
  const store = loadUsers();
  const user = requireUser(store, userId);
  const secret = generateTotpSecret();
  user.security.twoFactor.pendingSecret = secret;
  user.updatedAt = nowIso();
  saveUsers({ version: USER_DB, updatedAt: nowIso(), users: [...store.users.filter((entry) => entry.userId !== user.userId), user] });
  const described = describeTotpSecret(secret);
  const accountName = user.email || user.username || user.displayName;
  appendAuditEvent({ actor: "server", category: "public_profile", action: "begin_2fa", outcome: "success", message: `Started two-factor setup for ${userId}`, requestId, metadata: { userId } });
  return {
    manualEntryKey: described.manualEntryKey,
    otpauthUrl: buildTotpProvisioningUri({ secret: described.secret, accountName, issuer: issuerName() }),
    issuer: issuerName(),
    accountName,
  };
}

export function confirmPublicUserTwoFactor(config: CashClawConfig, userId: string, code: string, requestId?: string): CateoTwoFactorConfirmSnapshot {
  const store = loadUsers();
  const user = requireUser(store, userId);
  const secret = user.security.twoFactor.pendingSecret;
  if (!secret) throw new CateoPublicAuthError("OTP_SETUP_REQUIRED", "Start two-factor setup before confirming it.", 400);
  if (!verifyTotpCode(secret, code)) throw new CateoPublicAuthError("OTP_INVALID", "The verification code was not accepted.", 401);
  const recoveryCodes = generateRecoveryCodes();
  user.security.twoFactor = {
    enabled: true,
    secret,
    recoveryCodeHashes: recoveryCodes.map((entry) => hashRecoveryCode(entry)),
    enabledAt: nowIso(),
    lastVerifiedAt: nowIso(),
  };
  user.updatedAt = nowIso();
  const snapshot = saveUser(config, store, user);
  appendAuditEvent({ actor: "server", category: "public_profile", action: "confirm_2fa", outcome: "success", message: `Enabled two-factor authentication for ${userId}`, requestId, metadata: { userId } });
  return { user: snapshot, recoveryCodes };
}

export function disablePublicUserTwoFactor(config: CashClawConfig, userId: string, code: string, requestId?: string): CateoPublicUserSnapshot {
  const store = loadUsers();
  const user = requireUser(store, userId);
  const verification = verifySecondFactor(user, code);
  if (!verification.ok) throw new CateoPublicAuthError("OTP_INVALID", "The verification code or recovery code was not accepted.", 401);
  user.security.twoFactor = { enabled: false, recoveryCodeHashes: [] };
  user.updatedAt = nowIso();
  const snapshot = saveUser(config, store, user);
  appendAuditEvent({ actor: "server", category: "public_profile", action: "disable_2fa", outcome: "success", message: `Disabled two-factor authentication for ${userId}`, requestId, metadata: { userId } });
  return snapshot;
}
