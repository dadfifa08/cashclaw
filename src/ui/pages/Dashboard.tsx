import { useEffect, useState } from "react";
import { api, type AgentCashBalance, type CommandCenterData } from "../lib/api.js";
import { useLiveRuntime } from "../lib/live.js";
import { ethToUsd } from "../lib/ethPrice.js";

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function alertTone(level: CommandCenterData["alerts"][number]["level"]): string {
  switch (level) {
    case "critical":
      return "border-red-500/30 bg-red-500/10 text-red-200";
    case "warn":
      return "border-amber-500/30 bg-amber-500/10 text-amber-100";
    default:
      return "border-cyan-500/30 bg-cyan-500/10 text-cyan-100";
  }
}

const EVENT_COLORS: Record<string, string> = {
  poll: "text-zinc-600",
  loop_start: "text-blue-400",
  loop_complete: "text-emerald-400",
  tool_call: "text-amber-400",
  feedback: "text-violet-400",
  error: "text-red-400",
  ws: "text-zinc-600",
  study: "text-amber-300",
  approval: "text-amber-300",
};

const EVENT_LABELS: Record<string, string> = {
  poll: "sync",
  loop_start: "exec",
  loop_complete: "done",
  tool_call: "tool",
  feedback: "rate",
  error: "error",
  ws: "link",
  study: "learn",
  approval: "gate",
};

const EVENT_BAR_COLORS: Record<string, string> = {
  poll: "bg-zinc-700",
  loop_start: "bg-blue-500",
  loop_complete: "bg-emerald-500",
  tool_call: "bg-amber-500",
  feedback: "bg-violet-500",
  error: "bg-red-500",
  ws: "bg-zinc-700",
  study: "bg-amber-400",
  approval: "bg-amber-300",
};

const FILTER_OPTIONS: { label: string; type: string | null }[] = [
  { label: "All", type: null },
  { label: "Exec", type: "loop_start" },
  { label: "Tools", type: "tool_call" },
  { label: "Approvals", type: "approval" },
  { label: "Errors", type: "error" },
  { label: "Learn", type: "study" },
];

const TOPIC_COLORS: Record<string, string> = {
  feedback_analysis: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  specialty_research: "bg-violet-500/15 text-violet-400 border-violet-500/20",
  task_simulation: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  diagnostic_pattern: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  procedure_guidance: "bg-cyan-500/15 text-cyan-400 border-cyan-500/20",
};

type IntelTab = "knowledge" | "feedback";

export function Dashboard() {
  const { snapshot, connectionState, error: liveError } = useLiveRuntime();
  const status = snapshot?.status;
  const events = snapshot ? [...snapshot.events].reverse() : [];
  const stats = snapshot?.stats ?? null;
  const wallet = snapshot?.wallet;
  const knowledge = snapshot?.knowledge ?? [];
  const feedback = snapshot?.feedback ?? [];
  const approvals = snapshot?.approvals ?? [];
  const audit = snapshot?.audit ?? [];
  const config = snapshot?.config;
  const commandCenter = snapshot?.commandCenter ?? null;
  const pendingApprovals = approvals.filter((entry) => entry.status === "pending");
  const auditErrors = audit.filter((entry) => entry.severity === "error").length;
  const commandAlerts = commandCenter?.alerts ?? [];
  const commandTrend = commandCenter?.trend ?? [];
  const topFailureModes = commandCenter?.topFailureModes ?? [];
  const topAssets = commandCenter?.topAssets ?? [];

  const [agentCashBalance, setAgentCashBalance] = useState<AgentCashBalance | null>(null);
  const [ethPrice, setEthPrice] = useState<number>(0);
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [intelTab, setIntelTab] = useState<IntelTab>("knowledge");
  const [expandedKnowledge, setExpandedKnowledge] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.getEthPrice().then(({ price }) => { if (active) setEthPrice(price); }).catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!config?.agentCashEnabled) {
      setAgentCashBalance(null);
      return () => {
        active = false;
      };
    }
    api.getAgentCashBalance().then((balance) => { if (active) setAgentCashBalance(balance); }).catch(() => { if (active) setAgentCashBalance(null); });
    return () => {
      active = false;
    };
  }, [config?.agentCashEnabled, status?.running]);

  async function toggleAgent() {
    if (!status) return;
    setToggleError(null);
    try {
      if (status.running) {
        await api.stop();
      } else {
        await api.start();
      }
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : "Action failed");
    }
  }

  if (liveError && !status) {
    return (
      <div className="text-center py-32">
        <p className="text-xl text-zinc-300 mb-2">Live Connection Lost</p>
        <p className="text-sm text-zinc-600 mb-6">{liveError}</p>
        <p className="text-sm text-zinc-600">Cateo will keep trying to reconnect.</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="text-center py-32">
        <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-zinc-600">Connecting to live runtime...</p>
      </div>
    );
  }

  const isStudying = events.length > 0 && events[0]?.type === "study" && events[0]?.message.startsWith("Starting");
  const agentState = isStudying ? "studying" : status.running ? "active" : "idle";
  const filteredEvents = eventFilter ? events.filter((event) => event.type === eventFilter) : events;
  const balanceEth = wallet?.balance ? parseFloat(wallet.balance).toFixed(4) : null;
  const balanceDisplay = balanceEth ? ethPrice > 0 ? `${balanceEth} ETH (~$${ethToUsd(balanceEth, ethPrice)})` : `${balanceEth} ETH` : "--";
  const recentKnowledge = knowledge.slice(-10).reverse();
  const recentFeedback = feedback.slice(-10).reverse();
  const liveModeLabel = status.transportMode === "live" ? "REALTIME" : connectionState === "reconnecting" ? "RECONNECTING" : "FALLBACK";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1.5">
            <div className={`w-2 h-2 rounded-sm ${agentState === "studying" ? "bg-amber-400" : agentState === "active" ? "bg-emerald-400" : "bg-zinc-600"}`} />
            <h1 className="text-3xl font-bold text-zinc-100 tracking-tight">Cateo Command Center</h1>
            <span className="text-[10px] font-mono text-zinc-600 border border-zinc-800 rounded px-1.5 py-0.5">{liveModeLabel}</span>
          </div>
          <p className="text-sm text-zinc-500 font-mono">
            {agentState === "studying" ? "STUDYING" : agentState === "active" ? "OPERATIONAL" : "STOPPED"}
            {status.running && ` • ${formatUptime(status.uptime)}`}
            {status.running && status.totalPolls > 0 && ` • ${status.totalPolls} syncs`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {toggleError && <span className="text-xs text-red-400 font-mono">{toggleError}</span>}
          <button
            onClick={() => void toggleAgent()}
            className={`px-5 py-2 rounded-md text-sm font-medium transition-colors ${status.running ? "text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/50" : "text-white bg-red-600 hover:bg-red-500"}`}
          >
            {status.running ? "Stop Agent" : "Start Agent"}
          </button>
        </div>
      </div>

      {commandCenter && (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
            <StatCard label="Artifacts" value={formatCount(commandCenter.totals.artifacts)} highlight={commandCenter.totals.artifacts > 0} />
            <StatCard label="Revisions" value={formatCount(commandCenter.totals.revisions)} />
            <StatCard label="Reviewed" value={formatCount(commandCenter.totals.reviewed)} />
            <StatCard label="High Risk" value={formatCount(commandCenter.totals.highRiskCases)} highlight={commandCenter.totals.highRiskCases > 0} />
            <StatCard label="Low Confidence" value={formatCount(commandCenter.totals.lowConfidenceOutputs)} highlight={commandCenter.totals.lowConfidenceOutputs > 0} />
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
            <StatCard label="Validation" value={formatPercent(commandCenter.modelValidation.successRate)} />
            <StatCard label="Retries" value={formatCount(commandCenter.totals.retries)} highlight={commandCenter.totals.retries > 0} />
            <StatCard label="Escalations" value={formatCount(commandCenter.totals.escalations)} highlight={commandCenter.totals.escalations > 0} />
            <StatCard label="Profiles" value={formatCount(commandCenter.totals.profiles)} />
            <StatCard label="Vector Index" value={formatCount(commandCenter.totals.vectorEntries)} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
            <div className="xl:col-span-6 card px-5 py-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-bold text-zinc-100 tracking-tight">Artifact Growth</h2>
                  <p className="text-xs text-zinc-500 font-mono">{commandCenter.seeded ? "seeded demo data" : "live artifact telemetry"}</p>
                </div>
                <div className="text-right text-xs text-zinc-500 font-mono">
                  <div>coverage {formatPercent(commandCenter.health.documentCoveragePct)}</div>
                  <div>queue {formatCount(commandCenter.health.queueDepth)}</div>
                </div>
              </div>
              <TrendBars points={commandTrend} />
            </div>

            <div className="xl:col-span-3 card px-5 py-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-zinc-100 tracking-tight">Recurring Failure Modes</h2>
                <span className="text-xs text-zinc-600 font-mono readout">{topFailureModes.length}</span>
              </div>
              <SignalBars points={topFailureModes} emptyLabel="No failure modes yet" />
            </div>

            <div className="xl:col-span-3 card px-5 py-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-zinc-100 tracking-tight">Asset Concentration</h2>
                <span className="text-xs text-zinc-600 font-mono readout">{topAssets.length}</span>
              </div>
              <SignalBars points={topAssets} emptyLabel="No asset trends yet" />
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
            <div className="xl:col-span-5 card px-5 py-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-zinc-100 tracking-tight">Validation Health</h2>
                <span className="text-xs text-zinc-600 font-mono">{commandCenter.health.ingestionStatus}</span>
              </div>
              <div className="space-y-4">
                <HealthRow label="Validation Success" value={formatPercent(commandCenter.modelValidation.successRate)} tone="emerald" />
                <HealthRow label="Validation Failures" value={formatCount(commandCenter.totals.validationFailures)} tone={commandCenter.totals.validationFailures > 0 ? "amber" : "zinc"} />
                <HealthRow label="Rule Escalations" value={formatCount(commandCenter.modelValidation.escalationCount)} tone={commandCenter.modelValidation.escalationCount > 0 ? "amber" : "zinc"} />
                <HealthRow label="Unresolved Items" value={formatCount(commandCenter.totals.unresolvedItems)} tone={commandCenter.totals.unresolvedItems > 0 ? "red" : "zinc"} />
              </div>
            </div>

            <div className="xl:col-span-7 space-y-3">
              {commandAlerts.map((alert, index) => (
                <div key={`${alert.title}-${index}`} className={`card px-5 py-4 border ${alertTone(alert.level)}`}>
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <strong className="text-sm tracking-tight">{alert.title}</strong>
                    <span className="text-[10px] font-mono uppercase tracking-wider">{alert.level}</span>
                  </div>
                  <p className="text-sm leading-relaxed text-zinc-200/90">{alert.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <StatCard label="Active Tasks" value={String(status.activeTasks)} highlight={status.activeTasks > 0} />
        <StatCard label="Pending Approvals" value={String(pendingApprovals.length)} highlight={pendingApprovals.length > 0} />
        <StatCard label="Completed Work" value={stats ? String(stats.totalTasks) : "0"} />
        <StatCard label="Avg Score" value={stats && stats.avgScore > 0 ? `${stats.avgScore.toFixed(1)}/5` : "--"} />
        <StatCard label="Wallet Balance" value={balanceDisplay} />
      </div>


      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <StatCard label="Success Rate" value={stats && stats.totalTasks > 0 ? `${stats.completionRate}%` : "--"} />
        <StatCard label="Knowledge" value={stats ? String(stats.knowledgeEntries) : "0"} />
        <StatCard label="Study Sessions" value={stats ? String(stats.studySessions) : "0"} />
        <StatCard label="Audit Errors" value={String(auditErrors)} highlight={auditErrors > 0} />
        {config?.agentCashEnabled ? (
          <StatCard label="USDC Balance" value={agentCashBalance ? `$${parseFloat(agentCashBalance.balance).toFixed(2)}` : "--"} />
        ) : (
          <StatCard label="Transport" value={status.transportMode.toUpperCase()} />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-3 space-y-5">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <h2 className="text-lg font-bold text-zinc-200 tracking-tight">Runtime Activity</h2>
                <span className="text-xs text-zinc-600 font-mono readout">{filteredEvents.length}</span>
              </div>
              <div className="flex gap-0.5">
                {FILTER_OPTIONS.map((filter) => (
                  <button
                    key={filter.label}
                    onClick={() => setEventFilter(eventFilter === filter.type ? null : filter.type)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${eventFilter === filter.type ? "bg-zinc-700 text-zinc-200" : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800/60"}`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="card overflow-hidden">
              {filteredEvents.length === 0 ? (
                <p className="text-zinc-600 py-20 text-center text-sm">No runtime events yet</p>
              ) : (
                <div className="max-h-[560px] overflow-y-auto divide-y divide-zinc-800/40">
                  {filteredEvents.map((event, idx) => (
                    <div key={`${event.timestamp}-${event.type}-${event.taskId ?? ""}`} className={`flex items-center gap-3 hover:bg-zinc-800/25 transition-colors ${idx === 0 ? "bg-zinc-800/15" : ""}`}>
                      <div className={`w-[2px] self-stretch shrink-0 ${EVENT_BAR_COLORS[event.type] ?? "bg-zinc-700"}`} />
                      <span className="text-[11px] text-zinc-600 font-mono tabular-nums shrink-0 w-14 py-2.5">{formatTime(event.timestamp)}</span>
                      <span className={`text-[11px] font-semibold font-mono shrink-0 w-9 uppercase ${EVENT_COLORS[event.type] ?? "text-zinc-600"}`}>{EVENT_LABELS[event.type] ?? event.type.slice(0, 5)}</span>
                      {event.taskId && <code className="text-[10px] text-zinc-700 font-mono shrink-0">{event.taskId.slice(0, 8)}</code>}
                      <span className="text-[13px] text-zinc-400 truncate pr-3">{event.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-5">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-lg font-bold text-zinc-200 tracking-tight">Approval Queue</h2>
              <span className="text-xs text-zinc-600 font-mono readout">{pendingApprovals.length}</span>
            </div>
            <div className="card overflow-hidden">
              {pendingApprovals.length === 0 ? (
                <p className="text-zinc-600 py-12 text-center text-sm">No pending operator approvals.</p>
              ) : (
                <div className="divide-y divide-zinc-800/40">
                  {pendingApprovals.slice(0, 6).map((entry) => (
                    <div key={entry.id} className="px-4 py-3.5 hover:bg-zinc-800/25 transition-colors">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="px-2 py-0.5 rounded-sm text-[10px] font-semibold border bg-amber-500/10 text-amber-300 border-amber-500/20">PENDING</span>
                        <span className="text-[11px] text-zinc-600 font-mono">{entry.toolName}</span>
                        <span className="text-[10px] text-zinc-700 ml-auto font-mono">{formatRelative(entry.updatedAt)}</span>
                      </div>
                      <p className="text-[13px] text-zinc-300 leading-relaxed">{entry.summary}</p>
                      <p className="text-[11px] text-zinc-500 mt-1">{entry.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-lg font-bold text-zinc-200 tracking-tight">Cateo Memory</h2>
              <div className="flex gap-0.5 ml-auto">
                <button onClick={() => setIntelTab("knowledge")} className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${intelTab === "knowledge" ? "bg-zinc-700 text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}>
                  Knowledge ({knowledge.length})
                </button>
                <button onClick={() => setIntelTab("feedback")} className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${intelTab === "feedback" ? "bg-zinc-700 text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}>
                  Feedback ({feedback.length})
                </button>
              </div>
            </div>

            <div className="card overflow-hidden max-h-[560px] overflow-y-auto">
              {intelTab === "knowledge" ? (
                recentKnowledge.length === 0 ? (
                  <p className="text-zinc-600 py-20 text-center text-sm">No retained knowledge yet</p>
                ) : (
                  <div className="divide-y divide-zinc-800/40">
                    {recentKnowledge.map((entry) => {
                      const isExpanded = expandedKnowledge === entry.id;
                      return (
                        <div key={entry.id} className="px-4 py-3.5 hover:bg-zinc-800/25 transition-colors">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className={`px-2 py-0.5 rounded-sm text-[10px] font-semibold border ${TOPIC_COLORS[entry.topic] ?? "bg-zinc-800 text-zinc-400 border-zinc-700/50"}`}>{entry.topic.replace(/_/g, " ")}</span>
                            <span className="text-[11px] text-zinc-600 font-mono">{entry.specialty}</span>
                            <span className="text-[10px] text-zinc-700 ml-auto font-mono">{formatRelative(entry.timestamp)}</span>
                          </div>
                          <button onClick={() => setExpandedKnowledge(isExpanded ? null : entry.id)} className="text-left w-full">
                            <p className={`text-[13px] text-zinc-400 leading-relaxed ${isExpanded ? "" : "line-clamp-3"}`}>{entry.insight}</p>
                          </button>
                          <div className="flex items-center gap-2 mt-1">
                            {entry.source && <p className="text-[10px] text-zinc-700 truncate font-mono">src: {entry.source}</p>}
                            {isExpanded && (
                              <button
                                onClick={() => { void api.deleteKnowledge(entry.id).catch(() => {}); }}
                                className="text-[10px] text-zinc-700 hover:text-red-400 transition-colors font-mono ml-auto shrink-0"
                              >
                                delete
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                recentFeedback.length === 0 ? (
                  <p className="text-zinc-600 py-20 text-center text-sm">No feedback yet</p>
                ) : (
                  <div className="divide-y divide-zinc-800/40">
                    {recentFeedback.map((entry) => (
                      <div key={entry.taskId} className="px-4 py-3.5 hover:bg-zinc-800/25 transition-colors">
                        <div className="flex items-center gap-2.5 mb-1.5">
                          <span className={`text-sm font-bold font-mono ${entry.score >= 4 ? "text-emerald-400" : entry.score >= 3 ? "text-amber-400" : "text-red-400"}`}>{entry.score}/5</span>
                          <ScorePips score={entry.score} />
                          <span className="text-[10px] text-zinc-700 ml-auto font-mono">{formatRelative(entry.timestamp)}</span>
                        </div>
                        <p className="text-[13px] text-zinc-400 leading-relaxed">{entry.taskDescription}</p>
                        {entry.comments && <p className="text-[12px] text-zinc-600 mt-1 italic">&ldquo;{entry.comments}&rdquo;</p>}
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrendBars({ points }: { points: CommandCenterData["trend"] }) {
  if (points.length === 0) {
    return <p className="text-sm text-zinc-600">No artifact trend data yet.</p>;
  }

  const maxValue = Math.max(1, ...points.map((point) => Math.max(point.artifacts, point.revisions, point.interactions)));
  return (
    <div className="space-y-3">
      {points.map((point) => (
        <div key={point.label} className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-zinc-500 font-mono">
            <span>{point.label}</span>
            <span>a {point.artifacts} · r {point.revisions} · i {point.interactions}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="h-2 rounded-full bg-zinc-900 overflow-hidden">
              <div className="h-full bg-emerald-400/80 rounded-full" style={{ width: `${Math.max(8, (point.artifacts / maxValue) * 100)}%` }} />
            </div>
            <div className="h-2 rounded-full bg-zinc-900 overflow-hidden">
              <div className="h-full bg-cyan-400/80 rounded-full" style={{ width: `${Math.max(8, (point.revisions / maxValue) * 100)}%` }} />
            </div>
            <div className="h-2 rounded-full bg-zinc-900 overflow-hidden">
              <div className="h-full bg-amber-400/80 rounded-full" style={{ width: `${Math.max(8, (point.interactions / maxValue) * 100)}%` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SignalBars({ points, emptyLabel }: { points: Array<{ label: string; value: number }>; emptyLabel: string }) {
  if (points.length === 0) {
    return <p className="text-sm text-zinc-600">{emptyLabel}</p>;
  }

  const maxValue = Math.max(1, ...points.map((point) => point.value));
  return (
    <div className="space-y-3">
      {points.map((point) => (
        <div key={point.label} className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-sm text-zinc-300">
            <span className="truncate">{point.label}</span>
            <span className="text-xs text-zinc-500 font-mono readout">{point.value}</span>
          </div>
          <div className="h-2 rounded-full bg-zinc-900 overflow-hidden">
            <div className="h-full bg-zinc-300/80 rounded-full" style={{ width: `${Math.max(10, (point.value / maxValue) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function HealthRow({ label, value, tone }: { label: string; value: string; tone: "emerald" | "amber" | "red" | "zinc" }) {
  const toneClass = tone === "emerald"
    ? "bg-emerald-500"
    : tone === "amber"
      ? "bg-amber-500"
      : tone === "red"
        ? "bg-red-500"
        : "bg-zinc-500";
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${toneClass}`} />
        <span className="text-sm text-zinc-300">{label}</span>
      </div>
      <strong className="text-sm font-mono text-zinc-100 readout">{value}</strong>
    </div>
  );
}

function ScorePips({ score }: { score: number }) {
  return (
    <div className="flex gap-[2px]">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className={`w-2.5 h-[5px] rounded-[1px] ${i <= score ? score >= 4 ? "bg-emerald-500" : score >= 3 ? "bg-amber-500" : "bg-red-500" : "bg-zinc-800"}`} />
      ))}
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="card px-4 py-4">
      <p className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider mb-1.5">{label}</p>
      <p className={`text-2xl font-bold font-mono readout ${highlight ? "text-zinc-100" : "text-zinc-300"}`}>{value}</p>
    </div>
  );
}
