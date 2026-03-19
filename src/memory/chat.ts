import path from "node:path";
import crypto from "node:crypto";
import { getConfigDir, loadConfig } from "../config.js";
import { readProtectedJson, removeProtectedFile, writeProtectedJson } from "../security/secure_store.js";
import { redactText } from "../security/redact.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

const MAX_MESSAGES = 100;

function getChatPath(): string {
  return path.join(getConfigDir(), "chat.json");
}

function shouldPersist(): boolean {
  return loadConfig()?.security.persistence.persistOperatorChat ?? true;
}

let cache: ChatMessage[] | null = null;

function sanitizeMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: redactText(message.content),
  };
}

export function loadChat(): ChatMessage[] {
  if (cache) return cache;
  const parsed = readProtectedJson<ChatMessage[]>(getChatPath(), []);
  cache = Array.isArray(parsed)
    ? parsed.filter((entry) => typeof entry?.role === "string" && typeof entry?.content === "string")
    : [];
  return cache;
}

export function appendChat(message: ChatMessage): void {
  const messages = loadChat();
  messages.push(sanitizeMessage(message));
  const trimmed = messages.slice(-MAX_MESSAGES);
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
