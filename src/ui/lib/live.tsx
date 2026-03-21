import { createContext, startTransition, useContext, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  clearClientSessionCaches,
  getBootstrap,
  getLiveUrl,
  type AuthSessionData,
  type BootstrapData,
  type LiveRuntimeSnapshot,
  type LiveSnapshotEnvelope,
} from "./api.js";

type LiveConnectionState = "idle" | "connecting" | "connected" | "reconnecting";

interface LiveRuntimeContextValue {
  auth: AuthSessionData | null;
  bootstrap: BootstrapData | null;
  snapshot: LiveRuntimeSnapshot | null;
  connectionState: LiveConnectionState;
  error: string | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const LiveRuntimeContext = createContext<LiveRuntimeContextValue | null>(null);

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthSessionData | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [snapshot, setSnapshot] = useState<LiveRuntimeSnapshot | null>(null);
  const [connectionState, setConnectionState] = useState<LiveConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const connectRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined);
  const closeSocketRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let active = true;
    let retryMs = 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    function closeSocket() {
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      socket = null;
    }

    function applyUnauthenticatedState(session: AuthSessionData) {
      startTransition(() => {
        setAuth(session);
        setBootstrap(null);
        setSnapshot(null);
        setConnectionState("idle");
        setError(null);
      });
    }

    function scheduleReconnect() {
      if (!active) return;
      if (retryTimer) clearTimeout(retryTimer);
      setConnectionState("reconnecting");
      retryTimer = setTimeout(() => {
        void connect(true);
      }, retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    }

    async function connect(force = false) {
      try {
        const session = await api.getAuthSession(force);
        if (!active) return;

        if (!session.authenticated) {
          retryMs = 1_000;
          closeSocket();
          applyUnauthenticatedState(session);
          return;
        }

        const data = await getBootstrap(force);
        if (!active) return;

        closeSocket();
        startTransition(() => {
          setAuth(session);
          setBootstrap(data);
          setSnapshot(data.snapshot);
          setConnectionState(force ? "reconnecting" : "connecting");
          setError(null);
        });

        socket = new WebSocket(getLiveUrl());
        socket.onopen = () => {
          if (!active) return;
          retryMs = 1_000;
          setConnectionState("connected");
        };
        socket.onmessage = (event) => {
          if (!active) return;
          const message = JSON.parse(event.data) as LiveSnapshotEnvelope;
          if (message.type !== "snapshot") return;

          startTransition(() => {
            setBootstrap({
              type: "snapshot",
              configured: message.configured,
              mode: message.mode,
              step: message.step,
              snapshot: message.snapshot,
            });
            setSnapshot(message.snapshot);
            setError(null);
          });
        };
        socket.onerror = () => {
          socket?.close();
        };
        socket.onclose = () => {
          if (!active) return;
          scheduleReconnect();
        };
      } catch (err) {
        if (!active) return;

        if (err instanceof ApiError && err.status === 401) {
          try {
            const session = await api.getAuthSession(true);
            if (!active) return;
            if (!session.authenticated) {
              retryMs = 1_000;
              closeSocket();
              applyUnauthenticatedState(session);
              return;
            }
          } catch {
            // Fall through to reconnect path below.
          }
        }

        setError(err instanceof Error ? err.message : "Failed to connect");
        scheduleReconnect();
      }
    }

    connectRef.current = connect;
    closeSocketRef.current = closeSocket;
    void connect(false);

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      closeSocket();
      connectRef.current = async () => undefined;
      closeSocketRef.current = () => undefined;
    };
  }, []);

  async function refresh() {
    clearClientSessionCaches();
    await connectRef.current(true);
  }

  async function login(username: string, password: string) {
    await api.login(username, password);
    clearClientSessionCaches();
    await connectRef.current(true);
  }

  async function logout() {
    closeSocketRef.current();
    try {
      await api.logout();
    } catch {
      clearClientSessionCaches();
    }
    await connectRef.current(true);
  }

  return (
    <LiveRuntimeContext.Provider value={{ auth, bootstrap, snapshot, connectionState, error, refresh, login, logout }}>
      {children}
    </LiveRuntimeContext.Provider>
  );
}

export function useLiveRuntime() {
  const value = useContext(LiveRuntimeContext);
  if (!value) {
    throw new Error("useLiveRuntime must be used within LiveProvider");
  }
  return value;
}
