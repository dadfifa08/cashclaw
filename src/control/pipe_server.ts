import fs from "node:fs";
import net from "node:net";

const MAX_FRAME_BYTES = 1_048_576;

export interface ControlPipeRequest {
  id?: string;
  action: string;
  payload?: unknown;
}

export interface ControlPipeResponse {
  id?: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ControlPipeAuditEvent {
  action: string;
  outcome: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ControlPipeServer {
  endpoint: string;
  close(): Promise<void>;
}

export interface StartControlPipeServerOptions {
  endpoint: string;
  onRequest(request: ControlPipeRequest): Promise<unknown>;
  onAudit?(event: ControlPipeAuditEvent): void;
}

function isLocalSocketPath(endpoint: string): boolean {
  return !/^https?:\/\//i.test(endpoint);
}

function toResponse(id: string | undefined, ok: boolean, data?: unknown, error?: string): string {
  const payload: ControlPipeResponse = { id, ok, data, error };
  return `${JSON.stringify(payload)}\n`;
}

export async function startControlPipeServer(options: StartControlPipeServerOptions): Promise<ControlPipeServer | null> {
  if (!isLocalSocketPath(options.endpoint)) {
    return null;
  }

  if (process.platform !== "win32" && fs.existsSync(options.endpoint)) {
    fs.unlinkSync(options.endpoint);
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    let bytes = 0;

    options.onAudit?.({
      action: "connect",
      outcome: "opened",
      message: "Local control pipe connection opened",
    });

    socket.setEncoding("utf8");

    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_FRAME_BYTES) {
        options.onAudit?.({
          action: "request",
          outcome: "rejected",
          message: "Local control pipe frame exceeded limit",
        });
        socket.end(toResponse(undefined, false, undefined, "Frame too large"));
        return;
      }

      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const raw = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!raw) {
        socket.end(toResponse(undefined, false, undefined, "Empty request"));
        return;
      }

      let request: ControlPipeRequest;
      try {
        request = JSON.parse(raw) as ControlPipeRequest;
      } catch {
        options.onAudit?.({
          action: "request",
          outcome: "invalid_json",
          message: "Local control pipe received malformed JSON",
        });
        socket.end(toResponse(undefined, false, undefined, "Invalid JSON"));
        return;
      }

      options.onAudit?.({
        action: request.action,
        outcome: "received",
        message: `Local control request: ${request.action}`,
      });

      void options.onRequest(request)
        .then((data) => {
          options.onAudit?.({
            action: request.action,
            outcome: "success",
            message: `Local control request completed: ${request.action}`,
          });
          socket.end(toResponse(request.id, true, data));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          options.onAudit?.({
            action: request.action,
            outcome: "error",
            message: `Local control request failed: ${request.action}`,
            metadata: { error: message },
          });
          socket.end(toResponse(request.id, false, undefined, message));
        });
    });

    socket.on("error", (error) => {
      options.onAudit?.({
        action: "socket",
        outcome: "error",
        message: "Local control pipe socket error",
        metadata: { error: error.message },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.endpoint, () => resolve());
  });

  if (process.platform !== "win32" && fs.existsSync(options.endpoint)) {
    fs.chmodSync(options.endpoint, 0o600);
  }

  options.onAudit?.({
    action: "listen",
    outcome: "ready",
    message: `Local control pipe listening on ${options.endpoint}`,
  });

  return {
    endpoint: options.endpoint,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (process.platform !== "win32" && fs.existsSync(options.endpoint)) {
          fs.unlinkSync(options.endpoint);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}
