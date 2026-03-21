import { useState, type FormEvent } from "react";

interface LoginScreenProps {
  onLogin: (username: string, password: string) => Promise<void>;
  authEnabled: boolean;
  connectionError?: string | null;
}

function CateoLogo() {
  return (
    <svg width="42" height="42" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="30" height="30" rx="6" fill="#dc2626" />
      <path d="M8 19 C8 14.5, 10 9, 15 7 C12.5 11, 12.5 13.5, 13.5 16.5" stroke="white" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M15 7 C16.5 9.5, 17.5 12.5, 15.5 16.5" stroke="white" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M15 7 C19 9.5, 21 14.5, 21 19" stroke="white" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M10.5 18.5 C11.5 16.5, 13.5 16, 15 16.5 C16 16, 18 16.5, 19 17.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.5" />
    </svg>
  );
}

export function LoginScreen({ onLogin, authEnabled, connectionError }: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authEnabled) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onLogin(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#070709] text-zinc-100 flex items-center justify-center px-6 py-10">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-red-600/15 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-80 w-80 rounded-full bg-orange-500/10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-[440px] rounded-2xl border border-zinc-800/80 bg-[#111113]/95 shadow-[0_30px_120px_rgba(0,0,0,0.45)] backdrop-blur">
        <div className="border-b border-zinc-800/70 px-8 py-7">
          <div className="flex items-center gap-4">
            <CateoLogo />
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Cateo Command Center</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">Operator Login</h1>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-zinc-400">
            Authenticated access only. Every operator action is session-bound, role-scoped, and written to the audit chain.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="px-8 py-7 space-y-5">
          {!authEnabled && (
            <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3.5 py-3 text-sm text-amber-100">
              Operator authentication is not configured. Set <code className="font-mono">CATEO_OPERATOR_USERS</code> or <code className="font-mono">CATEO_OPERATOR_ADMIN_PASSWORD</code> and restart the server.
            </div>
          )}

          <label className="block space-y-2">
            <span className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              disabled={!authEnabled || pending}
              className="w-full border border-zinc-700 bg-zinc-950/90 px-3.5 py-3 text-sm text-zinc-100 outline-none transition focus:border-red-500/70 focus:ring-2 focus:ring-red-500/20 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
              placeholder="admin"
              required
            />
          </label>

          <label className="block space-y-2">
            <span className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={!authEnabled || pending}
              className="w-full border border-zinc-700 bg-zinc-950/90 px-3.5 py-3 text-sm text-zinc-100 outline-none transition focus:border-red-500/70 focus:ring-2 focus:ring-red-500/20 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
              placeholder="Enter operator password"
              required
            />
          </label>

          <button
            type="submit"
            disabled={!authEnabled || pending}
            className="w-full rounded-md bg-red-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-red-900/60"
          >
            {!authEnabled ? "Authentication Required" : pending ? "Authorizing..." : "Enter Command Center"}
          </button>

          {(error || connectionError) && (
            <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3.5 py-3 text-sm text-red-200">
              {error ?? connectionError}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
