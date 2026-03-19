import { createContext, startTransition, useContext, useEffect, useState } from "react";
import { getBootstrap, getLiveUrl, type BootstrapData, type LiveRuntimeSnapshot, type LiveSnapshotEnvelope } from "./api.js";

type LiveConnectionState = "connecting" | "connected" | "reconnecting";

interface LiveRuntimeContextValue {
  bootstrap: BootstrapData | null;
  snapshot: LiveRuntimeSnapshot | null;
  connectionState: LiveConnectionState;
  error: string | null;
  refresh: () => Promise<void>;
}

const LiveRuntimeContext = createContext<LiveRuntimeContextValue | null>(null);

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [snapshot, setSnapshot] = useState<LiveRuntimeSnapshot | null>(null);
  const [connectionState, setConnectionState] = useState<LiveConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let retryMs = 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;
    let hasBootstrapped = false;

    function closeSocket() {
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      socket = null;
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

    async function connect(forceBootstrap = false) {
      try {
        const data = await getBootstrap(forceBootstrap);
        if (!active) return;

        hasBootstrapped = true;
        closeSocket();
        setConnectionState(forceBootstrap ? "reconnecting" : "connecting");
        setError(null);

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

        startTransition(() => {
          setBootstrap(data);
          setSnapshot(data.snapshot);
        });
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to connect");
        if (hasBootstrapped) {
          scheduleReconnect();
        } else {
          setConnectionState("reconnecting");
          scheduleReconnect();
        }
      }
    }

    void connect(false);

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      closeSocket();
    };
  }, []);

  async function refresh() {
    const data = await getBootstrap(true);
    startTransition(() => {
      setBootstrap(data);
      setSnapshot(data.snapshot);
      setError(null);
    });
  }

  return (
    <LiveRuntimeContext.Provider value={{ bootstrap, snapshot, connectionState, error, refresh }}>
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
