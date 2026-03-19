import { useState } from "react";
import { api, type ApprovalData } from "../lib/api.js";
import { useLiveRuntime } from "../lib/live.js";

const STATUS_STYLES: Record<string, string> = {
  pending: "text-amber-300 border-amber-500/20 bg-amber-500/10",
  executed: "text-emerald-300 border-emerald-500/20 bg-emerald-500/10",
  rejected: "text-zinc-300 border-zinc-500/20 bg-zinc-500/10",
  failed: "text-red-300 border-red-500/20 bg-red-500/10",
  expired: "text-zinc-400 border-zinc-700/50 bg-zinc-900/70",
};

export function Approvals() {
  const { snapshot } = useLiveRuntime();
  const approvals = snapshot?.approvals ?? [];
  const pending = approvals.filter((entry) => entry.status === "pending");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(entry: ApprovalData, approve: boolean) {
    setActiveId(entry.id);
    setError(null);
    setMessage(null);
    try {
      if (approve) {
        const result = await api.approveAction(entry.id, notes[entry.id]);
        setMessage(result.result ?? `Executed ${entry.toolName}`);
      } else {
        await api.rejectAction(entry.id, notes[entry.id]);
        setMessage(`Rejected ${entry.toolName}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setActiveId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-zinc-100 tracking-tight mb-1.5">Operator Approvals</h1>
          <p className="text-sm text-zinc-500">High-risk actions are queued here until an operator explicitly approves or rejects them.</p>
        </div>
        <div className="card px-4 py-3 min-w-[180px]">
          <p className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider mb-1.5">Pending</p>
          <p className="text-3xl font-bold font-mono text-zinc-100 readout">{pending.length}</p>
        </div>
      </div>

      {(message || error) && (
        <div className={`card px-4 py-3 text-sm font-mono ${error ? "text-red-300" : "text-emerald-300"}`}>
          {error ?? message}
        </div>
      )}

      {approvals.length === 0 ? (
        <div className="card px-6 py-20 text-center text-sm text-zinc-600">No approval requests yet.</div>
      ) : (
        <div className="space-y-4">
          {approvals.map((entry) => {
            const isPending = entry.status === "pending";
            return (
              <div key={entry.id} className="card p-5 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <span className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border ${STATUS_STYLES[entry.status] ?? STATUS_STYLES.expired}`}>
                        {entry.status.toUpperCase()}
                      </span>
                      <span className="text-[11px] text-zinc-600 font-mono">{entry.toolName}</span>
                      {entry.taskId && <span className="text-[11px] text-zinc-700 font-mono">task {entry.taskId}</span>}
                    </div>
                    <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">{entry.summary}</h2>
                    <p className="text-sm text-zinc-500 mt-1">{entry.reason}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[11px] text-zinc-600 font-mono">{new Date(entry.updatedAt).toLocaleString()}</p>
                    {entry.outcome && <p className="text-[11px] text-zinc-500 font-mono mt-1 max-w-[320px] truncate">{entry.outcome}</p>}
                  </div>
                </div>

                {entry.decisionNote && (
                  <div className="rounded-md border border-zinc-800/80 bg-zinc-950/70 px-3 py-2 text-[12px] text-zinc-400">
                    <span className="text-zinc-600 font-mono mr-2">note</span>
                    {entry.decisionNote}
                  </div>
                )}

                <details className="rounded-md border border-zinc-800/80 bg-zinc-950/50">
                  <summary className="px-3 py-2 text-[12px] text-zinc-500 cursor-pointer select-none">Review payload</summary>
                  <div className="border-t border-zinc-800/60 p-3 grid gap-3 lg:grid-cols-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Input</p>
                      <pre className="text-[11px] text-zinc-400 font-mono whitespace-pre-wrap break-words">{JSON.stringify(entry.input, null, 2)}</pre>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Metadata</p>
                      <pre className="text-[11px] text-zinc-400 font-mono whitespace-pre-wrap break-words">{JSON.stringify(entry.metadata ?? {}, null, 2)}</pre>
                    </div>
                  </div>
                </details>

                {isPending && (
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                    <input
                      type="text"
                      value={notes[entry.id] ?? ""}
                      onChange={(event) => setNotes((current) => ({ ...current, [entry.id]: event.target.value }))}
                      placeholder="Decision note for audit log"
                      className="flex-1 bg-zinc-900/80 border border-zinc-800/80 rounded-md px-3 py-2 text-[13px] text-zinc-300 focus:outline-none focus:border-zinc-600 transition-colors"
                    />
                    <div className="flex gap-3">
                      <button
                        onClick={() => void decide(entry, false)}
                        disabled={activeId === entry.id}
                        className="px-4 py-2 rounded-md text-[13px] font-semibold text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/50 disabled:opacity-40"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => void decide(entry, true)}
                        disabled={activeId === entry.id}
                        className="px-4 py-2 rounded-md text-[13px] font-semibold text-white bg-red-600 hover:bg-red-500 disabled:opacity-40"
                      >
                        {activeId === entry.id ? "Processing..." : "Approve"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
