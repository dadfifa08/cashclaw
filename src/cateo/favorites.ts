import crypto from "node:crypto";
import path from "node:path";
import { getConfigDir } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";

const FAVORITES_DB_VERSION = "cateo-procedure-favorites-v1";

export interface CateoProcedureFavoriteRecord {
  favoriteId: string;
  caseId: string;
  userId: string;
  profileId?: string;
  createdAt: string;
  updatedAt: string;
}

interface FavoriteFile {
  version: string;
  updatedAt: string;
  rows: CateoProcedureFavoriteRecord[];
}

function favoritesPath(): string {
  return path.join(getConfigDir(), "cateo", "db", "procedure_favorites.json");
}

function loadStore(): FavoriteFile {
  return readProtectedJson<FavoriteFile>(favoritesPath(), {
    version: FAVORITES_DB_VERSION,
    updatedAt: new Date(0).toISOString(),
    rows: [],
  });
}

function saveStore(file: FavoriteFile): void {
  writeProtectedJson(favoritesPath(), file);
}

export function listProcedureFavoritesForUser(userId: string): CateoProcedureFavoriteRecord[] {
  return loadStore().rows
    .filter((row) => row.userId === userId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function listProcedureFavoriteCaseIds(userId: string): string[] {
  return [...new Set(listProcedureFavoritesForUser(userId).map((row) => row.caseId))];
}

export function countProcedureFavoritesByCaseId(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of loadStore().rows) {
    counts[row.caseId] = (counts[row.caseId] ?? 0) + 1;
  }
  return counts;
}

export function toggleProcedureFavorite(input: { caseId: string; userId: string; profileId?: string; favorited?: boolean }, requestId?: string): { favorited: boolean; item: CateoProcedureFavoriteRecord | null; count: number } {
  const store = loadStore();
  const now = new Date().toISOString();
  const existing = store.rows.find((row) => row.caseId === input.caseId && row.userId === input.userId) ?? null;
  const shouldFavorite = input.favorited ?? !existing;

  let item: CateoProcedureFavoriteRecord | null = existing;
  if (shouldFavorite && !existing) {
    item = {
      favoriteId: crypto.randomUUID(),
      caseId: input.caseId,
      userId: input.userId,
      profileId: input.profileId,
      createdAt: now,
      updatedAt: now,
    };
    store.rows.push(item);
  } else if (!shouldFavorite && existing) {
    store.rows = store.rows.filter((row) => row.favoriteId !== existing.favoriteId);
    item = null;
  } else if (existing) {
    existing.updatedAt = now;
    item = existing;
  }

  saveStore({ version: FAVORITES_DB_VERSION, updatedAt: now, rows: store.rows });
  const count = store.rows.filter((row) => row.caseId === input.caseId).length;
  appendAuditEvent({
    actor: "operator",
    category: "procedure_favorite",
    action: shouldFavorite ? "favorite" : "unfavorite",
    outcome: "success",
    message: `${shouldFavorite ? "Favorited" : "Removed favorite for"} case ${input.caseId}`,
    requestId,
    metadata: { caseId: input.caseId, userId: input.userId, profileId: input.profileId, count },
  });
  return { favorited: shouldFavorite, item, count };
}

