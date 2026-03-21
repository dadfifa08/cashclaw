import WebSocket from "ws";
import type { CashClawConfig } from "./config.js";
import type { CateoModelRuntime } from "./llm/runtime.js";
import type { LLMProvider } from "./llm/types.js";
import type { Task } from "./moltlaunch/types.js";
import * as cli from "./moltlaunch/cli.js";
import { runAgentLoop, type LoopResult } from "./loop/index.js";
import { runStudySession } from "./loop/study.js";
import { storeFeedback } from "./memory/feedback.js";
import { appendLog } from "./memory/log.js";
import { appendTaskInteraction } from "./memory/datasets.js";
import { appendAuditEvent } from "./security/audit.js";
import { upsertCashClawArtifactsForTask } from "./cateo/cashclaw_bridge.js";
import { requestApproval as createApproval } from "./security/approvals.js";
import type { ToolApprovalRequest, ToolAuditEvent } from "./tools/types.js";

export interface HeartbeatState {
  running: boolean;
  activeTasks: Map<string, Task>;
  lastPoll: number;
  totalPolls: number;
  startedAt: number;
  events: ActivityEvent[];
  wsConnected: boolean;
  lastStudyTime: number;
  totalStudySessions: number;
}

export interface ActivityEvent {
  timestamp: number;
  type: "poll" | "loop_start" | "loop_complete" | "tool_call" | "feedback" | "error" | "ws" | "study" | "approval";
  taskId?: string;
  message: string;
}

type EventListener = (event: ActivityEvent) => void;

const TERMINAL_STATUSES = new Set([
  "completed", "declined", "cancelled", "expired", "resolved", "disputed",
]);

const WS_URL = "wss://api.moltlaunch.com/ws";
const WS_INITIAL_RECONNECT_MS = 5_000;
const WS_MAX_RECONNECT_MS = 300_000;
const WS_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const TASK_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

type HeartbeatModelRuntime = LLMProvider | CateoModelRuntime;

function getTaskVersion(task: Task): string {
  return [
    task.id,
    task.status,
    task.revisionCount ?? 0,
    task.messages?.length ?? 0,
    task.files?.length ?? 0,
    task.quotedPriceWei ?? "",
    task.ratedScore ?? "",
    task.result?.length ?? 0,
  ].join(":");
}

export function createHeartbeat(config: CashClawConfig, llm: HeartbeatModelRuntime) {
  const state: HeartbeatState = {
    running: false,
    activeTasks: new Map(),
    lastPoll: 0,
    totalPolls: 0,
    startedAt: 0,
    events: [],
    wsConnected: false,
    lastStudyTime: 0,
    totalStudySessions: 0,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let ws: WebSocket | null = null;
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsReconnectDelay = WS_INITIAL_RECONNECT_MS;
  let wsFailLogged = false;
  let wsDisabled = false;
  let studying = false;

  const processing = new Set<string>();
  const completedTasks = new Set<string>();
  const processedVersions = new Map<string, string>();
  const listeners: EventListener[] = [];

  function emit(event: Omit<ActivityEvent, "timestamp">) {
    const full: ActivityEvent = { ...event, timestamp: Date.now() };
    state.events.push(full);
    if (state.events.length > 200) {
      state.events = state.events.slice(-200);
    }
    for (const listener of listeners) listener(full);
  }

  function audit(actor: "runtime" | "model", event: ToolAuditEvent | {
    category: string;
    action: string;
    outcome: string;
    message: string;
    severity?: "info" | "warn" | "error";
    approvalId?: string;
    metadata?: Record<string, unknown>;
    taskId?: string;
  }) {
    appendAuditEvent({
      actor,
      category: event.category,
      action: event.action,
      outcome: event.outcome,
      message: event.message,
      severity: event.severity,
      approvalId: event.approvalId,
      taskId: "taskId" in event ? event.taskId : undefined,
      metadata: event.metadata,
    });
  }

  function onEvent(listener: EventListener) {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    };
  }

  function clearNextTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function shouldWaitForClient(task: Task): boolean {
    return task.status === "quoted" || task.status === "submitted";
  }

  function cleanupExpiredTasks() {
    const now = Date.now();
    for (const [id, task] of state.activeTasks) {
      const taskTime = task.quotedAt ?? task.acceptedAt ?? task.submittedAt ?? state.startedAt;
      if (!processing.has(id) && now - taskTime > TASK_EXPIRY_MS) {
        state.activeTasks.delete(id);
        processedVersions.delete(id);
      }
    }
  }

  function disableWs(reason: string) {
    wsDisabled = true;
    state.wsConnected = false;

    if (!wsFailLogged) {
      emit({ type: "ws", message: `Realtime disabled: ${reason}. Fallback sync remains active.` });
      appendLog(`Realtime disabled: ${reason}`);
      audit("runtime", {
        category: "transport",
        action: "disable_realtime",
        outcome: "fallback",
        message: `Realtime disabled: ${reason}`,
      });
      wsFailLogged = true;
    }

    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }

    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }

    scheduleNext();
  }

  function scheduleWsReconnect() {
    if (!state.running || wsDisabled) return;
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(() => connectWs(), wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_MS);
  }

  function connectWs() {
    if (!state.running || !config.agentId || wsDisabled) return;

    try {
      ws = new WebSocket(`${WS_URL}/${config.agentId}`);

      ws.on("open", () => {
        state.wsConnected = true;
        wsReconnectDelay = WS_INITIAL_RECONNECT_MS;
        wsFailLogged = false;
        emit({ type: "ws", message: "Realtime connected" });
        appendLog("Realtime connected");
        audit("runtime", {
          category: "transport",
          action: "realtime_open",
          outcome: "success",
          message: "Realtime websocket connected",
        });
        scheduleNext();
      });

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString()) as { event: string; task?: Task };
          if (msg.event === "connected") return;

          emit({ type: "ws", taskId: msg.task?.id, message: `Realtime event: ${msg.event}` });
          audit("runtime", {
            category: "transport",
            action: "realtime_event",
            outcome: "success",
            message: `Realtime event: ${msg.event}`,
            taskId: msg.task?.id,
          });

          if (msg.task) {
            handleTaskEvent(msg.task);
            drainActiveTasks();
          }
        } catch {
          // Ignore malformed realtime payloads.
        }
      });

      ws.on("close", () => {
        const wasConnected = state.wsConnected;
        state.wsConnected = false;
        if (wsDisabled || !state.running) return;

        if (!wsFailLogged || wasConnected) {
          emit({ type: "ws", message: "Realtime disconnected. Falling back to sync while reconnecting." });
          appendLog("Realtime disconnected. Falling back to sync while reconnecting.");
          audit("runtime", {
            category: "transport",
            action: "realtime_close",
            outcome: "fallback",
            message: "Realtime disconnected. Falling back to sync while reconnecting.",
          });
          wsFailLogged = true;
        }

        scheduleWsReconnect();
        scheduleNext();
      });

      ws.on("error", (err: Error) => {
        state.wsConnected = false;
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes("404")) {
          disableWs("websocket endpoint unavailable");
          return;
        }

        if (!wsFailLogged) {
          emit({ type: "ws", message: `Realtime unavailable: ${message}. Falling back to sync.` });
          appendLog(`Realtime unavailable: ${message}`);
          audit("runtime", {
            category: "transport",
            action: "realtime_error",
            outcome: "fallback",
            severity: "warn",
            message: `Realtime unavailable: ${message}`,
          });
          wsFailLogged = true;
        }

        ws?.close();
        scheduleWsReconnect();
        scheduleNext();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("404")) {
        disableWs("websocket endpoint unavailable");
        return;
      }

      if (!wsFailLogged) {
        emit({ type: "ws", message: `Realtime connect failed: ${message}. Falling back to sync.` });
        appendLog(`Realtime connect failed: ${message}`);
        audit("runtime", {
          category: "transport",
          action: "realtime_connect_error",
          outcome: "fallback",
          severity: "warn",
          message: `Realtime connect failed: ${message}`,
        });
        wsFailLogged = true;
      }

      scheduleWsReconnect();
      scheduleNext();
    }
  }

  function disconnectWs() {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }

    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }

    state.wsConnected = false;
  }

  function handleCompleted(task: Task) {
    if (task.ratedScore === undefined) return;
    if (completedTasks.has(task.id)) return;
    completedTasks.add(task.id);

    storeFeedback({
      taskId: task.id,
      taskDescription: task.task,
      score: task.ratedScore,
      comments: task.ratedComment ?? "",
      timestamp: Date.now(),
    });

    emit({
      type: "feedback",
      taskId: task.id,
      message: `Completed - rated ${task.ratedScore}/5`,
    });
    appendLog(`Task ${task.id} completed - score ${task.ratedScore}/5`);
    audit("runtime", {
      category: "feedback",
      action: "store_feedback",
      outcome: "success",
      message: `Stored feedback for task ${task.id}`,
      taskId: task.id,
      metadata: { score: task.ratedScore },
    });
  }

  function drainActiveTasks() {
    if (processing.size >= config.maxConcurrentTasks) return;

    for (const task of state.activeTasks.values()) {
      if (processing.size >= config.maxConcurrentTasks) break;

      if (TERMINAL_STATUSES.has(task.status)) {
        handleTaskEvent(task);
        continue;
      }

      if (processing.has(task.id) || shouldWaitForClient(task)) {
        continue;
      }

      const version = getTaskVersion(task);
      if (processedVersions.get(task.id) === version) {
        continue;
      }

      handleTaskEvent(task);
    }
  }

  function handleTaskEvent(task: Task) {
    if (TERMINAL_STATUSES.has(task.status)) {
      if (task.status === "completed" && task.ratedScore !== undefined) {
        handleCompleted(task);
      }
      state.activeTasks.delete(task.id);
      processedVersions.delete(task.id);
      return;
    }

    state.activeTasks.set(task.id, task);

    if (processing.has(task.id)) {
      return;
    }

    const version = getTaskVersion(task);
    if (processedVersions.get(task.id) === version) {
      return;
    }

    if (shouldWaitForClient(task)) {
      processedVersions.set(task.id, version);
      return;
    }

    if (processing.size >= config.maxConcurrentTasks) {
      return;
    }

    processedVersions.set(task.id, version);
    processing.add(task.id);

    emit({ type: "loop_start", taskId: task.id, message: `Cateo loop started (${task.status})` });
    appendLog(`Cateo loop started for ${task.id} (${task.status})`);
    audit("runtime", {
      category: "loop",
      action: "start",
      outcome: "started",
      message: `Cateo loop started (${task.status})`,
      taskId: task.id,
    });

    runAgentLoop(llm, task, config, {
      requestApproval: (request: ToolApprovalRequest) => {
        const approval = createApproval(request);
        if (approval.created) {
          emit({
            type: "approval",
            taskId: request.taskId,
            message: `Approval requested: ${request.summary}`,
          });
          appendLog(`Approval requested for ${request.toolName} on ${request.taskId ?? "n/a"}`);
        }
        return { id: approval.approval.id, created: approval.created };
      },
      recordAudit: (event: ToolAuditEvent) => {
        audit("model", {
          ...event,
          taskId: task.id,
        });
      },
    })
      .then((result: LoopResult) => {
        const toolNames = result.toolCalls.map((call) => call.name).join(", ");
        emit({
          type: "loop_complete",
          taskId: task.id,
          message: `Loop done in ${result.turns} turn(s): [${toolNames}]`,
        });
        appendLog(`Loop done for ${task.id}: ${result.turns} turns, tools=[${toolNames}]`);
        audit("runtime", {
          category: "loop",
          action: "complete",
          outcome: "success",
          message: `Loop completed in ${result.turns} turn(s)`,
          taskId: task.id,
          metadata: { toolNames },
        });

        for (const call of result.toolCalls) {
          emit({
            type: "tool_call",
            taskId: task.id,
            message: `${call.name}(${JSON.stringify(call.input).slice(0, 100)}) -> ${call.success ? "ok" : "err"}`,
          });
        }

        appendTaskInteraction({
          schemaVersion: "1.0",
          kind: "task_interaction",
          timestamp: Date.now(),
          taskId: task.id,
          agentId: config.agentId,
          status: task.status,
          task: task.task,
          category: task.category,
          clientAddress: task.clientAddress,
          quotedPriceWei: task.quotedPriceWei,
          revisionCount: task.revisionCount,
          messages: task.messages?.map((message) => ({
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
          })),
          files: task.files?.map((file) => ({
            key: file.key,
            name: file.name,
            size: file.size,
            uploadedAt: file.uploadedAt,
          })),
          resultRaw: result.reasoning,
          ratedScore: task.ratedScore,
          ratedComment: task.ratedComment,
          modelProvider: result.primaryModel.provider,
          modelName: result.primaryModel.model,
          toolCalls: result.toolCalls.map((call) => ({
            name: call.name,
            success: call.success,
          })),
          orchestrationRoute: result.orchestration
            ? {
                taskClass: result.orchestration.route.taskClass,
                artifactKind: result.orchestration.route.artifactKind,
                complexity: result.orchestration.route.complexity,
                usedChallenger: result.orchestration.stages.some((stage) => stage.role === "challenger" && stage.status === "used"),
                usedStructure: result.orchestration.stages.some((stage) => stage.role === "structure" && stage.status === "used"),
              }
            : undefined,
          orchestrationStages: result.orchestration?.stages.map((stage) => ({
            role: stage.role,
            status: stage.status,
            model: stage.model,
          })),
          toolScope: result.toolScope,
          activeSkillIds: result.activeSkillIds,
          capabilityTags: result.orchestration?.route.capabilityTags,
        });

        try {
          upsertCashClawArtifactsForTask({
            config,
            task,
            result,
          });
        } catch (bridgeError) {
          const bridgeMessage = bridgeError instanceof Error ? bridgeError.message : String(bridgeError);
          appendLog(`Cateo bridge error for ${task.id}: ${bridgeMessage}`);
          audit("runtime", {
            category: "cashclaw_cateo_bridge",
            action: "persist",
            outcome: "error",
            severity: "warn",
            message: `Cateo bridge error: ${bridgeMessage}`,
            taskId: task.id,
          });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "error", taskId: task.id, message: `Loop error: ${message}` });
        appendLog(`Loop error for ${task.id}: ${message}`);
        audit("runtime", {
          category: "loop",
          action: "error",
          outcome: "error",
          severity: "error",
          message: `Loop error: ${message}`,
          taskId: task.id,
        });
      })
      .finally(() => {
        processing.delete(task.id);
        drainActiveTasks();
        scheduleNext();
      });
  }

  async function syncInbox(reason: string) {
    try {
      const tasks = await cli.getInbox(config.agentId);
      state.lastPoll = Date.now();
      state.totalPolls += 1;

      emit({ type: "poll", message: `${reason}: ${tasks.length} task(s)` });
      appendLog(`${reason}: ${tasks.length} task(s)`);
      audit("runtime", {
        category: "sync",
        action: "inbox_sync",
        outcome: "success",
        message: `${reason}: ${tasks.length} task(s)`,
        metadata: { taskCount: tasks.length },
      });

      for (const task of tasks) {
        handleTaskEvent(task);
      }

      drainActiveTasks();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: `Sync error: ${message}` });
      appendLog(`Sync error: ${message}`);
      audit("runtime", {
        category: "sync",
        action: "inbox_sync",
        outcome: "error",
        severity: "error",
        message: `Sync error: ${message}`,
      });
    } finally {
      scheduleNext();
    }
  }

  function scheduleNext() {
    clearNextTimer();
    if (!state.running) return;

    cleanupExpiredTasks();
    void maybeStudy();

    const hasUrgent = [...state.activeTasks.values()].some(
      (task) => task.status === "requested" || task.status === "revision" || task.status === "accepted",
    );

    const interval = state.wsConnected && !wsDisabled
      ? WS_RECONCILE_INTERVAL_MS
      : hasUrgent
        ? config.polling.urgentIntervalMs
        : config.polling.intervalMs;

    const reason = state.wsConnected && !wsDisabled
      ? "Realtime reconciliation"
      : "Polling fallback";

    timer = setTimeout(() => void syncInbox(reason), interval);
  }

  async function maybeStudy() {
    if (!config.learningEnabled) return;
    if (studying) return;
    if (processing.size > 0) return;

    const hasUrgent = [...state.activeTasks.values()].some(
      (task) => task.status === "requested" || task.status === "revision" || task.status === "accepted",
    );
    if (hasUrgent) return;

    if (Date.now() - state.lastStudyTime < config.studyIntervalMs) return;

    studying = true;
    emit({ type: "study", message: "Starting study session..." });
    appendLog("Study session started");
    audit("runtime", {
      category: "study",
      action: "start",
      outcome: "started",
      message: "Study session started",
    });

    try {
      const result = await runStudySession(llm, config);
      state.lastStudyTime = Date.now();
      state.totalStudySessions += 1;

      emit({ type: "study", message: `Study complete: ${result.topic} (${result.tokensUsed} tokens)` });
      appendLog(`Study session complete: ${result.topic} - ${result.insight.slice(0, 100)}`);
      audit("runtime", {
        category: "study",
        action: "complete",
        outcome: "success",
        message: `Study complete: ${result.topic}`,
        metadata: {
          tokensUsed: result.tokensUsed,
          modelProvider: result.model.provider,
          modelName: result.model.model,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: `Study error: ${message}` });
      appendLog(`Study error: ${message}`);
      audit("runtime", {
        category: "study",
        action: "error",
        outcome: "error",
        severity: "error",
        message: `Study error: ${message}`,
      });
      state.lastStudyTime = Date.now();
    } finally {
      studying = false;
    }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.startedAt = Date.now();

    if (state.lastStudyTime === 0) {
      state.lastStudyTime = Date.now();
    }

    appendLog("Heartbeat started");
    emit({ type: "ws", message: "Realtime intake enabled with fallback sync" });
    audit("runtime", {
      category: "runtime",
      action: "start",
      outcome: "success",
      message: "Heartbeat started",
    });

    connectWs();
    void syncInbox("Initial sync");
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    clearNextTimer();
    disconnectWs();
    emit({ type: "ws", message: "Runtime stopped" });
    appendLog("Heartbeat stopped");
    audit("runtime", {
      category: "runtime",
      action: "stop",
      outcome: "success",
      message: "Heartbeat stopped",
    });
  }

  function syncNow(reason = "Operator-triggered sync") {
    if (!state.running) return;
    clearNextTimer();
    void syncInbox(reason);
  }

  return {
    state,
    start,
    stop,
    syncNow,
    onEvent,
  };
}

export type Heartbeat = ReturnType<typeof createHeartbeat>;





