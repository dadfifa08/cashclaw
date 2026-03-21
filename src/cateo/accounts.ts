import crypto from "node:crypto";
import path from "node:path";
import type { CashClawConfig } from "../config.js";
import { getConfigDir, getPilotConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { authenticateOperator } from "../security/operators.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";
import { getPilotProfile, type CateoProfileSnapshot, upsertPilotProfile } from "./profiles.js";

const USER_DB = "cateo-public-users-v1";
const SESSION_DB = "cateo-public-sessions-v1";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const USERNAME = /^[a-z0-9._-]{3,64}$/i;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const LIMIT = 6;
const throttle = new Map<string, { failures: number[]; lockedUntil?: number }>();

export type CateoPublicUserRole = "user" | "admin";

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
}
export interface CateoPublicSessionSnapshot { sessionId: string; expiresAt: string; user: CateoPublicUserSnapshot; }
export class CateoPublicAuthError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); this.name = "CateoPublicAuthError"; } }

const userPath = () => path.join(getConfigDir(), "cateo", "security", "public_users.json");
const sessionPath = () => path.join(getConfigDir(), "cateo", "security", "public_sessions.json");
const loadUsers = () => readProtectedJson<UserFile>(userPath(), { version: USER_DB, updatedAt: new Date(0).toISOString(), users: [] });
const saveUsers = (file: UserFile) => writeProtectedJson(userPath(), file);
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
function profileIdFor(config: CashClawConfig, record: UserRec, requesterId?: string, requestId?: string) { return upsertPilotProfile(config, { profileId: record.profileId, requesterId, displayName: record.displayName, email: record.email, organization: record.organization }, requestId).profileId; }
function userSnapshot(config: CashClawConfig, record: UserRec): CateoPublicUserSnapshot { return { userId: record.userId, createdAt: record.createdAt, updatedAt: record.updatedAt, lastLoginAt: record.lastLoginAt, status: record.status, email: record.email, username: record.username, displayName: record.displayName, organization: record.organization, roles: [...record.roles], profileId: record.profileId, profile: record.profileId ? getPilotProfile(config, record.profileId, record.requesterIds[0]) ?? null : null }; }
function saveUser(config: CashClawConfig, store: UserFile, record: UserRec) { const users = store.users.filter((entry) => entry.userId !== record.userId); users.push(record); saveUsers({ version: USER_DB, updatedAt: nowIso(), users }); return userSnapshot(config, record); }
function guardLogin(identifier: string, requesterId?: string) { const key = `${identifier.toLowerCase()}::${requesterId ?? "anon"}`; const state = throttle.get(key); const now = Date.now(); if (!state) return; state.failures = state.failures.filter((stamp) => now - stamp <= WINDOW_MS); if (state.lockedUntil && state.lockedUntil > now) throw new CateoPublicAuthError("LOGIN_THROTTLED", "Too many login attempts. Try again later.", 429); if (state.lockedUntil && state.lockedUntil <= now) throttle.delete(key); }
function failedLogin(identifier: string, requesterId?: string) { const key = `${identifier.toLowerCase()}::${requesterId ?? "anon"}`; const state = throttle.get(key) ?? { failures: [] as number[] }; const now = Date.now(); state.failures = state.failures.filter((stamp) => now - stamp <= WINDOW_MS); state.failures.push(now); if (state.failures.length >= LIMIT) state.lockedUntil = now + LOCK_MS; throttle.set(key, state); }
const clearLogin = (identifier: string, requesterId?: string) => throttle.delete(`${identifier.toLowerCase()}::${requesterId ?? "anon"}`);
function findUser(store: UserFile, identifier: string) { const id = identifier.trim().toLowerCase(); return store.users.find((entry) => entry.email?.toLowerCase() === id || entry.username?.toLowerCase() === id) ?? null; }
function createSession(config: CashClawConfig, record: UserRec, requesterId?: string, requestId?: string): CateoPublicSessionSnapshot { const store = loadSessions(); const expiresAt = new Date(Date.now() + Math.max(1, getPilotConfig(config).sessionTtlDays) * 24 * 60 * 60 * 1000).toISOString(); const sessionId = crypto.randomBytes(36).toString("base64url"); const session: SessionRec = { sessionId, userId: record.userId, requesterId, createdAt: nowIso(), updatedAt: nowIso(), expiresAt }; const sessions = store.sessions.filter((entry) => entry.expiresAt > nowIso() && entry.userId !== record.userId).slice(-40); sessions.push(session); saveSessions({ version: SESSION_DB, updatedAt: nowIso(), sessions }); appendAuditEvent({ actor: "server", category: "public_auth", action: "session_create", outcome: "success", message: `Created public session for ${record.userId}`, requestId, metadata: { userId: record.userId, requesterId } }); return { sessionId, expiresAt, user: userSnapshot(config, record) }; }

export function registerPublicUser(config: CashClawConfig, input: { email: string; password: string; displayName?: string; organization?: string; username?: string; requesterId?: string }, requestId?: string): CateoPublicSessionSnapshot { const email = normalizeEmail(input.email); const username = normalizeUsername(input.username); const password = trim(input.password); if (!email) throw new CateoPublicAuthError("EMAIL_REQUIRED", "Email is required."); if (!password || password.length < 10) throw new CateoPublicAuthError("PASSWORD_WEAK", "Passwords must be at least 10 characters."); const store = loadUsers(); if (store.users.some((entry) => entry.email?.toLowerCase() === email)) throw new CateoPublicAuthError("ACCOUNT_EXISTS", "An account already exists for that email.", 409); if (username && store.users.some((entry) => entry.username?.toLowerCase() === username.toLowerCase())) throw new CateoPublicAuthError("ACCOUNT_EXISTS", "That username is already taken.", 409); const salt = crypto.randomBytes(18).toString("base64url"); const record: UserRec = { userId: crypto.randomUUID(), createdAt: nowIso(), updatedAt: nowIso(), lastLoginAt: nowIso(), status: "active", authSource: "local", email, emailHash: hashEmail(email), username, displayName: trim(input.displayName) || username || email.split("@")[0] || "Cateo user", organization: trim(input.organization), roles: ["user"], requesterIds: [], passwordSalt: salt, passwordHash: hashPassword(password, salt) }; touchRequester(record, input.requesterId); record.profileId = profileIdFor(config, record, input.requesterId, requestId); saveUser(config, store, record); appendAuditEvent({ actor: "server", category: "public_auth", action: "register", outcome: "success", message: `Registered public user ${record.userId}`, requestId, metadata: { userId: record.userId, requesterId: input.requesterId } }); return createSession(config, record, input.requesterId, requestId); }

export function loginPublicUser(config: CashClawConfig, input: { identifier: string; password: string; requesterId?: string }, requestId?: string): CateoPublicSessionSnapshot { const identifier = trim(input.identifier); const password = trim(input.password); if (!identifier || !password) throw new CateoPublicAuthError("LOGIN_REQUIRED", "Enter your email or username and password.", 400); guardLogin(identifier, input.requesterId); const store = loadUsers(); const local = findUser(store, identifier); if (local?.authSource === "local" && local.passwordSalt && local.passwordHash && verifyPassword(password, local.passwordSalt, local.passwordHash)) { local.updatedAt = nowIso(); local.lastLoginAt = nowIso(); touchRequester(local, input.requesterId); local.profileId = profileIdFor(config, local, input.requesterId, requestId); saveUser(config, store, local); clearLogin(identifier, input.requesterId); appendAuditEvent({ actor: "server", category: "public_auth", action: "login", outcome: "success", message: `Public user ${local.userId} logged in`, requestId, metadata: { userId: local.userId, requesterId: input.requesterId } }); return createSession(config, local, input.requesterId, requestId); } const operator = authenticateOperator(identifier, password); if (operator && operator.role === "admin") { const admin = local ?? { userId: crypto.randomUUID(), createdAt: nowIso(), updatedAt: nowIso(), lastLoginAt: nowIso(), status: "active", authSource: "operator", username: normalizeUsername(identifier) || identifier, displayName: identifier, roles: ["user", "admin"], requesterIds: [] } as UserRec; admin.updatedAt = nowIso(); admin.lastLoginAt = nowIso(); admin.roles = ["user", "admin"]; touchRequester(admin, input.requesterId); admin.profileId = profileIdFor(config, admin, input.requesterId, requestId); saveUser(config, store, admin); clearLogin(identifier, input.requesterId); appendAuditEvent({ actor: "server", category: "public_auth", action: "login_admin", outcome: "success", message: `Operator-backed admin ${admin.userId} logged in via public site`, requestId, metadata: { userId: admin.userId, requesterId: input.requesterId } }); return createSession(config, admin, input.requesterId, requestId); } failedLogin(identifier, input.requesterId); appendAuditEvent({ actor: "server", category: "public_auth", action: "login", outcome: "failed", severity: "warn", message: "Public login failed", requestId, metadata: { identifier, requesterId: input.requesterId } }); throw new CateoPublicAuthError("LOGIN_INVALID", "That login was not accepted.", 401); }

export function getPublicSession(config: CashClawConfig, sessionId?: string, requesterId?: string, requestId?: string): CateoPublicSessionSnapshot | null { const id = trim(sessionId); if (!id) return null; const sessions = loadSessions(); const active = sessions.sessions.find((entry) => entry.sessionId === id); if (!active || active.expiresAt <= nowIso()) return null; if (requesterId && active.requesterId && active.requesterId !== requesterId) { appendAuditEvent({ actor: "server", category: "public_auth", action: "session_mismatch", outcome: "denied", severity: "warn", message: "Rejected public session because the requester identity changed", requestId, metadata: { requesterId, storedRequesterId: active.requesterId } }); return null; } const store = loadUsers(); const user = store.users.find((entry) => entry.userId === active.userId && entry.status === "active"); if (!user) return null; touchRequester(user, requesterId); user.profileId = profileIdFor(config, user, requesterId, requestId); saveUser(config, store, user); active.updatedAt = nowIso(); if (requesterId) active.requesterId = requesterId; saveSessions({ version: SESSION_DB, updatedAt: nowIso(), sessions: [...sessions.sessions.filter((entry) => entry.sessionId !== id && entry.expiresAt > nowIso()), active] }); return { sessionId: active.sessionId, expiresAt: active.expiresAt, user: userSnapshot(config, user) }; }
export function logoutPublicSession(sessionId?: string, requestId?: string) { const id = trim(sessionId); if (!id) return; const store = loadSessions(); const sessions = store.sessions.filter((entry) => entry.sessionId !== id); if (sessions.length !== store.sessions.length) { saveSessions({ version: SESSION_DB, updatedAt: nowIso(), sessions }); appendAuditEvent({ actor: "server", category: "public_auth", action: "logout", outcome: "success", message: "Public session ended", requestId, metadata: { sessionId: id } }); } }
export function listPublicUsers(config: CashClawConfig) { return loadUsers().users.filter((entry) => entry.status === "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((entry) => userSnapshot(config, entry)); }

