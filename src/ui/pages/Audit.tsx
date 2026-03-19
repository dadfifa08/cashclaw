import { useDeferredValue, useMemo, useState } from "react";
import { useLiveRuntime } from "../lib/live.js";

type SeverityFilter = "all" | "info" | "warn" | "error";

const SEVERITY_STYLES: Record<string, string> = {
  info: "text-blue-300 border-blue-500/20 bg-blue-500/10",
  warn: "text-amber-300 border-amber-500/20 bg-amber-500/10",
  error: "text-red-300 border-red-500/20 bg-red-500/10",
};

export function AuditLog() {
  const { snapshot } = useLiveRuntime();
  const audit = snapshot?.audit ?? [];
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const filtered = useMemo(() => audit.filter((entry) => {
    if (severity !== "all" && entry.severity !== severity) return false;
    if (!deferredQuery) return true;
    const haystack = [
      entry.actor,
      entry.category,
      entry.action,
      entry.outcome,
      entry.message,
      entry.taskId,
      entry.approvalId,
      JSON.stringify(entry.metadata ?? {}),
    ].join(" ").toLowerCase();
    return haystack.includes(deferredQuery);
  }), [audit, deferredQuery, severity]);

  const counts = useMemo(() => ({
    info: audit.filter((entry) => entry.severity === "info").length,
    warn: audit.filter((entry) => entry.severity === "warn").length,
    error: audit.filter((entry) => entry.severity === "error").length,
  }), [audit]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-zinc-100 tracking-tight mb-1.5">Audit Trail</h1>
          <p className="text-sm text-zinc-500">Tamper-evident runtime, operator, model, and server events. Newest events are shown first.</p>
        </div>
        <div className="grid grid-cols-3 gap-3 shrink-0">
          <Metric label="Info" value={counts.info} tone="info" />
          <Metric label="Warn" value={counts.warn} tone="warn" />
          <Metric label="Error" value={counts.error} tone="error" />
        </div>
      </div>

      <div className="card p-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search actor, category, message, task, approval, metadata"
          className="flex-1 bg-zinc-900/80 border border-zinc-800/80 rounded-md px-3 py-2 text-[13px] text-zinc-300 focus:outline-none focus:border-zinc-600 transition-colors"
        />
        <div className="flex gap-2">
          {(["all", "info", "warn", "error"] as SeverityFilter[]).map((value) => (
            <button
              key={value}
              onClick={() => setSeverity(value)}
              className={`px-3 py-2 rounded-md text-[12px] font-semibold transition-colors ${severity === value ? "bg-zinc-700 text-zinc-100" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
            >
              {value.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card px-6 py-20 text-center text-sm text-zinc-600">No audit events match the current filter.</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((entry) => (
            <div key={entry.id} className="card p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border ${SEVERITY_STYLES[entry.severity] ?? SEVERITY_STYLES.info}`}>
                      {entry.severity.toUpperCase()}
                    </span>
                    <span className="text-[11px] text-zinc-500 font-mono">{entry.actor}</span>
                    <span className="text-[11px] text-zinc-600 font-mono">{entry.category}.{entry.action}</span>
                    <span className="text-[11px] text-zinc-700 font-mono">{entry.outcome}</span>
                  </div>
                  <p className="text-sm text-zinc-300 leading-relaxed">{entry.message}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[11px] text-zinc-600 font-mono">{new Date(entry.timestamp).toLocaleString()}</p>
                  <p className="text-[11px] text-zinc-700 font-mono mt-1">{entry.id.slice(0, 12)}</p>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2 text-[11px] font-mono text-zinc-500">
                <div className="space-y-1">
                  {entry.taskId && <p>task: <span className="text-zinc-400">{entry.taskId}</span></p>}
                  {entry.approvalId && <p>approval: <span className="text-zinc-400">{entry.approvalId}</span></p>}
                  {entry.requestId && <p>request: <span className="text-zinc-400">{entry.requestId}</span></p>}
                </div>
                <div className="space-y-1 lg:text-right">
                  <p>prev: <span className="text-zinc-400">{entry.prevHash.slice(0, 20) || "root"}</span></p>
                  <p>hash: <span className="text-zinc-400">{entry.hash.slice(0, 20)}</span></p>
                </div>
              </div>

              {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                <details className="rounded-md border border-zinc-800/80 bg-zinc-950/60">
                  <summary className="px-3 py-2 text-[12px] text-zinc-500 cursor-pointer select-none">Metadata</summary>
                  <pre className="border-t border-zinc-800/60 p-3 text-[11px] text-zinc-400 font-mono whitespace-pre-wrap break-words">{JSON.stringify(entry.metadata, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "info" | "warn" | "error" }) {
  return (
    <div className="card px-4 py-3 min-w-[92px]">
      <p className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider mb-1.5">{label}</p>
      <p className={`text-2xl font-bold font-mono readout ${tone === "error" ? "text-red-300" : tone === "warn" ? "text-amber-300" : "text-blue-300"}`}>
        {value}
      </p>
    </div>
  );
}
