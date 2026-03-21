import path from "node:path";
import { getConfigDir, loadConfig } from "../config.js";
import { readProtectedJson, removeProtectedFile, writeProtectedJson } from "../security/secure_store.js";
import { redactText } from "../security/redact.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

const MAX_MESSAGES = 100;
const MAX_CHAT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getChatPath(): string {
  return path.join(getConfigDir(), "chat.json");
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistOperatorChat ?? false;
}

let cache: ChatMessage[] | null = null;

function sanitizeMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: redactText(message.content),
  };
}

function pruneMessages(messages: ChatMessage[], now = Date.now()): ChatMessage[] {
  const cutoff = now - MAX_CHAT_AGE_MS;
  return messages
    .filter((entry) => typeof entry.timestamp === "number" && entry.timestamp >= cutoff)
    .slice(-MAX_MESSAGES);
}

function readFromDisk(): ChatMessage[] {
  const parsed = readProtectedJson<ChatMessage[]>(getChatPath(), []);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return pruneMessages(
    parsed.filter(
      (entry): entry is ChatMessage =>
        typeof entry?.role === "string" &&
        typeof entry?.content === "string" &&
        typeof entry?.timestamp === "number",
    ),
  );
}

export function loadChat(): ChatMessage[] {
  if (cache) return cache;
  cache = readFromDisk();
  return cache;
}

export function appendChat(message: ChatMessage): void {
  const messages = loadChat();
  messages.push(sanitizeMessage(message));
  const trimmed = pruneMessages(messages);
  cache = trimmed;

  if (shouldPersist()) {
    writeProtectedJson(getChatPath(), trimmed);
  }
}

export function clearChat(): void {
  cache = [];
  if (shouldPersist()) {
    writeProtectedJson(getChatPath(), []);
  } else {
    removeProtectedFile(getChatPath());
  }
}