import type http from "node:http";

const requestBodyCache = new WeakMap<http.IncomingMessage, Promise<string>>();

export function readRequestBody(
  req: http.IncomingMessage,
  options?: { maxBytes?: number },
): Promise<string> {
  const existing = requestBodyCache.get(req);
  if (existing) {
    return existing;
  }

  const maxBytes = Math.max(1, options?.maxBytes ?? 1_048_576);
  const pending = new Promise<string>((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        requestBodyCache.delete(req);
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", (error) => {
      requestBodyCache.delete(req);
      reject(error);
    });
  });

  requestBodyCache.set(req, pending);
  return pending;
}