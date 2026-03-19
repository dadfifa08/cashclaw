import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { api } from "../lib/api.js";
import { useLiveRuntime } from "../lib/live.js";
import { formatEthUsd } from "../lib/ethPrice.js";

const STATUS_COLORS: Record<string, string> = {
  requested: "bg-amber-400",
  quoted: "bg-blue-400",
  accepted: "bg-emerald-400",
  submitted: "bg-violet-400",
  revision: "bg-orange-400",
  completed: "bg-emerald-400",
  declined: "bg-zinc-600",
  cancelled: "bg-zinc-600",
};

const STATUSES = ["all", "requested", "quoted", "accepted", "submitted", "completed", "declined"] as const;

export function Tasks() {
  const { snapshot, error: liveError } = useLiveRuntime();
  const tasks = snapshot?.tasks ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [ethPrice, setEthPrice] = useState<number>(0);

  useEffect(() => {
    let active = true;
    api.getEthPrice()
      .then(({ price }) => { if (active) setEthPrice(price); })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    if (!tasks.some((task) => task.id === selectedId)) {
      setSelectedId(null);
    }
  }, [tasks, selectedId]);

  const filtered = statusFilter === "all"
    ? tasks
    : tasks.filter((task) => task.status === statusFilter);

  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const statusCounts = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-zinc-100 tracking-tight mb-1.5">Work Queue</h1>
          <p className="text-sm text-zinc-500 font-mono">{tasks.length} work item{tasks.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {liveError && tasks.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-sm text-red-400 mb-1">Live connection error</p>
          <p className="text-xs text-zinc-600 font-mono">{liveError}</p>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {STATUSES.map((status) => {
            const count = status === "all" ? tasks.length : (statusCounts[status] ?? 0);
            if (status !== "all" && count === 0) return null;
            return (
              <button
                key={status}
                onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                  statusFilter === status
                    ? "bg-zinc-700 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
                }`}
              >
                {status === "all" ? "All" : status.charAt(0).toUpperCase() + status.slice(1)}
                <span className="text-zinc-600 ml-1.5 font-mono text-[11px]">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card text-center py-24">
          <p className="text-zinc-400 text-base mb-1.5">
            {tasks.length === 0 ? "No active work items" : "No matching work items"}
          </p>
          <p className="text-zinc-600 text-sm">
            {tasks.length === 0 ? "Work items will appear here when dispatched from Moltlaunch" : "Try a different filter"}
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800/60">
                {["ID", "Work Item", "Status", "Value", "Score"].map((heading, idx) => (
                  <th
                    key={heading}
                    className={`px-4 py-3 text-[11px] text-zinc-500 font-semibold uppercase tracking-wider ${
                      idx >= 3 ? "text-right" : "text-left"
                    }`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/30">
              {filtered.map((task) => (
                <tr
                  key={task.id}
                  onClick={() => setSelectedId(selectedId === task.id ? null : task.id)}
                  className={`cursor-pointer transition-colors ${
                    selectedId === task.id ? "bg-zinc-800/35" : "hover:bg-zinc-800/20"
                  }`}
                >
                  <td className="px-4 py-3.5">
                    <code className="text-zinc-500 text-[13px] font-mono">{task.id.slice(0, 8)}</code>
                  </td>
                  <td className="px-4 py-3.5 max-w-lg">
                    <p className="text-[13px] text-zinc-300 truncate">{task.task}</p>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-zinc-400">
                      <span className={`w-1.5 h-1.5 rounded-sm shrink-0 ${STATUS_COLORS[task.status] ?? "bg-zinc-600"}`} />
                      {task.status}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-right text-[13px] font-mono text-zinc-500 readout">
                    {task.quotedPriceWei
                      ? ethPrice > 0
                        ? formatEthUsd(formatEther(BigInt(task.quotedPriceWei)), ethPrice)
                        : `${formatEther(BigInt(task.quotedPriceWei))} ETH`
                      : "--"}
                  </td>
                  <td className="px-4 py-3.5 text-right text-[13px] font-mono text-zinc-500">
                    {task.ratedScore !== undefined ? `${task.ratedScore}/5` : "--"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="card p-5 space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2.5">
              <span className={`w-2 h-2 rounded-sm ${STATUS_COLORS[selected.status] ?? "bg-zinc-600"}`} />
              <h3 className="text-sm font-semibold text-zinc-300">
                Task <span className="text-zinc-200 font-mono">{selected.id.slice(0, 12)}</span>
              </h3>
              <span className="text-[12px] text-zinc-500 font-mono uppercase">{selected.status}</span>
            </div>
            <button
              onClick={() => setSelectedId(null)}
              className="text-[12px] text-zinc-600 hover:text-zinc-300 transition-colors font-medium"
            >
              Close
            </button>
          </div>

          <p className="text-sm text-zinc-300 leading-relaxed">{selected.task}</p>

          <div className="flex gap-6 pt-1">
            {selected.quotedPriceWei && (
              <div>
                <p className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-0.5">Quoted Value</p>
                <p className="text-sm font-mono text-zinc-300">
                  {ethPrice > 0
                    ? formatEthUsd(formatEther(BigInt(selected.quotedPriceWei)), ethPrice)
                    : `${formatEther(BigInt(selected.quotedPriceWei))} ETH`}
                </p>
              </div>
            )}
            {selected.ratedScore !== undefined && (
              <div>
                <p className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-0.5">Client Score</p>
                <p className="text-sm font-mono text-zinc-300">{selected.ratedScore}/5</p>
              </div>
            )}
          </div>

          {selected.result && (
            <div className="pt-1">
              <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2">Deliverable</p>
              <pre className="text-[13px] text-zinc-400 bg-zinc-950 p-4 rounded-md overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap border border-zinc-800/60 font-mono leading-relaxed">
                {selected.result}
              </pre>
            </div>
          )}

          <a
            href={`https://moltlaunch.com/task/${selected.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-300 font-medium transition-colors"
          >
            View on Moltlaunch
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      )}
    </div>
  );
}
