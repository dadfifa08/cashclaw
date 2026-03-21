import crypto from "node:crypto";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "./secure_store.js";

const OPERATOR_STORE_VERSION = "cateo-operator-store-v1";
const HASH_ITERATIONS = 210_000;
const HASH_DIGEST = "sha512";

export type OperatorRole = "admin" | "reviewer" | "analyst" | "viewer";

interface StoredOperatorUser {
  userId: string;
  username: string;
  role: OperatorRole;
  status: "active" | "disabled";
  salt: string;
  passwordHash: string;
  iterations: number;
  digest: string;
  createdAt: string;
  updatedAt: string;
}

interface OperatorStore {
  version: string;
  updatedAt: string;
  users: StoredOperatorUser[];
}

export interface AuthenticatedOperator {
  userId: string;
  username: string;
  role: OperatorRole;
}

function operatorStorePath(): string {
  return path.join(getConfigDir(), "security", "operators.json");
}

function loadOperatorStore(): OperatorStore {
  return readProtectedJson<OperatorStore>(operatorStorePath(), {
    version: OPERATOR_STORE_VERSION,
    updatedAt: new Date(0).toISOString(),
    users: [],
  });
}

function saveOperatorStore(store: OperatorStore): void {
  writeProtectedJson(operatorStorePath(), store);
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function isRole(value: string): value is OperatorRole {
  return value === "admin" || value === "reviewer" || value === "analyst" || value === "viewer";
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")): Pick<StoredOperatorUser, "salt" | "passwordHash" | "iterations" | "digest"> {
  return {
    salt,
    passwordHash: crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, 64, HASH_DIGEST).toString("hex"),
    iterations: HASH_ITERATIONS,
    digest: HASH_DIGEST,
  };
}

function verifyPassword(user: StoredOperatorUser, password: string): boolean {
  const derived = crypto.pbkdf2Sync(password, user.salt, user.iterations, 64, user.digest).toString("hex");
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(derived, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseBootstrapUsers(): Array<{ username: string; role: OperatorRole; password: string }> {
  const configured = process.env.CATEO_OPERATOR_USERS?.trim();
  if (configured) {
    return configured
      .split(/[;|]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [usernameRaw, roleRaw, ...passwordParts] = entry.split(":");
        const username = normalizeUsername(usernameRaw ?? "");
        const role = (roleRaw ?? "").trim().toLowerCase();
        const password = passwordParts.join(":").trim();
        return { username, role, password };
      })
      .filter((entry): entry is { username: string; role: OperatorRole; password: string } => Boolean(entry.username) && isRole(entry.role) && entry.password.length >= 8);
  }

  const adminPassword = process.env.CATEO_OPERATOR_ADMIN_PASSWORD?.trim();
  if (adminPassword && adminPassword.length >= 8) {
    return [{ username: "admin", role: "admin", password: adminPassword }];
  }

  return [];
}

export function ensureOperatorBootstrap(): { enabled: boolean; seeded: boolean; userCount: number } {
  const store = loadOperatorStore();
  if (store.users.length > 0) {
    return { enabled: true, seeded: false, userCount: store.users.length };
  }

  const bootstrapUsers = parseBootstrapUsers();
  if (bootstrapUsers.length === 0) {
    return { enabled: false, seeded: false, userCount: 0 };
  }

  const now = new Date().toISOString();
  const seededUsers: StoredOperatorUser[] = bootstrapUsers.map((entry) => ({
    userId: crypto.randomUUID(),
    username: entry.username,
    role: entry.role,
    status: "active",
    ...hashPassword(entry.password),
    createdAt: now,
    updatedAt: now,
  }));

  saveOperatorStore({
    version: OPERATOR_STORE_VERSION,
    updatedAt: now,
    users: seededUsers,
  });

  return { enabled: true, seeded: true, userCount: seededUsers.length };
}

export function isOperatorAuthEnabled(): boolean {
  return ensureOperatorBootstrap().enabled;
}

export function authenticateOperator(username: string, password: string): AuthenticatedOperator | null {
  if (!isOperatorAuthEnabled()) {
    return null;
  }

  const normalized = normalizeUsername(username);
  const store = loadOperatorStore();
  const user = store.users.find((entry) => entry.status === "active" && entry.username === normalized);
  if (!user || !verifyPassword(user, password)) {
    return null;
  }

  return {
    userId: user.userId,
    username: user.username,
    role: user.role,
  };
}

export function hasRequiredRole(role: OperatorRole, allowed: OperatorRole[]): boolean {
  return allowed.includes(role);
}
