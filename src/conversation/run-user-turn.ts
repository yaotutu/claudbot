import type { ServiceContainer } from "../runtime/services.ts";
import type { NormalizedEvent } from "../agent/events.ts";
import type {
  RuntimeMcpServerStatus,
  SessionSummary as SessionSummaryWire,
  ThreadActivity,
  ThreadActivityStatus,
  ToolFrame,
} from "../shared/webui-protocol.ts";
import { appendSessionJsonlEntry } from "../sessions/jsonl-store.ts";
import type { ConversationEvent, ConversationSink, RunUserTurnInput, RunUserTurnResult } from "./types.ts";
import { runMemoryDream } from "../memory/dream.ts";
import { detectMemoryIntent } from "../memory/intent.ts";

// SDK sessionStoreFlush defaults to 'batched'. After turn_done we wait this
// long so the SDK JSONL mirror has a chance to flush before consumers read it.
const MIRROR_FLUSH_SETTLE_MS = 50;

export async function runUserTurn(
  services: ServiceContainer,
  input: RunUserTurnInput,
  sink: ConversationSink,
): Promise<RunUserTurnResult> {
  const runId = crypto.randomUUID();
  const initialRouteId = input.sessionId ?? input.draftId ?? "pending";
  await sink.send({ type: "run.started", sessionId: initialRouteId, runId });

  const sdkSessionId = await resolveResumeSessionId(services, input);
  const runtimeSessionId = sdkSessionId ?? input.sessionId ?? input.draftId ?? `pending-${runId}`;
  let lastSessionId: string | undefined = sdkSessionId;
  let collected = "";
  let turnErrored = false;
  let finalResult = "";
  let sessionCreated = false;
  let activities: ThreadActivity[] = [];

  const handleEvent = async (ev: NormalizedEvent) => {
    activities = collectRunActivity(activities, runId, ev);
    if (ev.type === "error" && ev.message.includes("mirror_error")) {
      await sink.send({ type: "run.error", sessionId: ev.sessionId, runId, message: ev.message });
      return;
    }
    if (ev.sessionId && ev.sessionId !== lastSessionId) {
      lastSessionId = ev.sessionId;
    }
    if (!sdkSessionId && !sessionCreated && lastSessionId && lastSessionId !== "pending") {
      sessionCreated = true;
      await sink.send({
        type: "session.created",
        draftId: input.draftId,
        session: draftSessionSummary(lastSessionId, input.content),
      });
      if (runtimeSessionId !== lastSessionId) services.agentRuntimeManager.remapSession(runtimeSessionId, lastSessionId);
    }
    await forwardNative((event) => sink.send(event), ev, runId, lastSessionId ?? initialRouteId);
    if (ev.type === "text_delta") collected += ev.text;
    if (ev.type === "turn_done") {
      finalResult = ev.result;
      if (ev.sessionId) lastSessionId = ev.sessionId;
    }
    if (ev.type === "error") {
      turnErrored = true;
      finalResult = `[error] ${ev.message}`;
    }
  };

  try {
    await services.agentRuntimeManager.runTurn({
      sessionId: runtimeSessionId,
      content: input.content,
      runId,
      resumeSessionId: sdkSessionId,
      onEvent: handleEvent,
    });
  } catch (err) {
    turnErrored = true;
    finalResult = `[error] ${err instanceof Error ? err.message : String(err)}`;
  }

  if (lastSessionId && input.source === "webui") {
    await services.runtimeState.setLastActiveSession(lastSessionId, "user_message");
  }

  await new Promise((resolve) => setTimeout(resolve, MIRROR_FLUSH_SETTLE_MS));

  if (!sdkSessionId && lastSessionId) {
    try {
      await services.sessions.rename(lastSessionId, input.content.slice(0, 60));
    } catch { /* non-critical */ }
  }

  if (!sdkSessionId && !sessionCreated && lastSessionId) {
    await sink.send({
      type: "session.created",
      draftId: input.draftId,
      session: draftSessionSummary(lastSessionId, input.content),
    });
  }

  const finalText = collected || finalResult || (turnErrored ? "(no response)" : "(no response)");
  const activeSdkId = lastSessionId ?? sdkSessionId ?? "pending";
  const finalActivities = finalizeActivities(activities, turnErrored);
  if (activeSdkId !== "pending" && finalActivities.length > 0) {
    await appendSessionJsonlEntry(services.paths.sessionsDir, activeSdkId, {
      type: "claudebot-run-activity",
      sessionId: activeSdkId,
      runId,
      activities: finalActivities,
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });
  }
  await maybeRunExplicitMemoryDreamAfterTurn(services, input.content, activeSdkId, turnErrored);
  await sink.send({ type: "run.completed", sessionId: activeSdkId, runId, isError: turnErrored, result: finalResult });
  await sink.send({
    type: "message.appended",
    sessionId: activeSdkId,
    message: {
      id: `local-${Date.now()}`,
      role: turnErrored ? "system" : "assistant",
      content: finalText,
      createdAt: new Date().toISOString(),
      metadata: {
        ...(turnErrored ? { error: true } : {}),
        runId,
        ...(finalActivities.length > 0 ? { activities: finalActivities } : {}),
      },
    },
  });

  return { sessionId: lastSessionId ?? sdkSessionId ?? null, runId, result: finalResult, isError: turnErrored };
}

export async function maybeRunExplicitMemoryDreamAfterTurn(
  services: ServiceContainer,
  content: string,
  sessionId: string | undefined,
  turnErrored: boolean,
): Promise<void> {
  if (turnErrored || !sessionId || sessionId === "pending") return;
  const intent = detectMemoryIntent(content);
  if (intent.type !== "explicit") return;
  try {
    await runMemoryDream(services.memoryPaths, { dryRun: false, sessionId, includeEventCandidates: false });
  } catch (err) {
    console.error("[memory] explicit dream failed:", err instanceof Error ? err.message : err);
  }
}

function collectRunActivity(
  activities: ThreadActivity[],
  runId: string,
  event: NormalizedEvent,
): ThreadActivity[] {
  const timestamp = new Date().toISOString();
  if (event.type === "status") {
    return upsertStatusActivity(activities, runId, event.status, event.mcpServers, timestamp);
  }
  if (event.type === "thinking_delta") {
    return appendThinkingActivity(activities, runId, event.thinking, timestamp);
  }
  if (event.type === "tool_start") {
    return upsertToolActivity(activities, runId, {
      phase: "start",
      id: event.id,
      name: event.name,
      input: event.input,
    }, timestamp);
  }
  if (event.type === "tool_result") {
    return upsertToolActivity(activities, runId, {
      phase: event.isError ? "error" : "end",
      id: event.id,
      output: event.output,
      isError: event.isError,
    }, timestamp);
  }
  return activities;
}

function appendThinkingActivity(
  activities: ThreadActivity[],
  runId: string,
  text: string,
  timestamp: string,
): ThreadActivity[] {
  const id = `thinking-${runId}`;
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    return [...activities, {
      id,
      kind: "thinking",
      runId,
      text,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  return activities.map((activity) => activity.id === id && activity.kind === "thinking"
    ? { ...activity, text: `${activity.text}${text}`, updatedAt: timestamp }
    : activity);
}

function upsertToolActivity(
  activities: ThreadActivity[],
  runId: string,
  tool: ToolFrame,
  timestamp: string,
): ThreadActivity[] {
  const id = `tool-${tool.id}`;
  const status = tool.phase === "error" || tool.isError ? "error" : tool.phase === "end" ? "complete" : "running";
  const existing = activities.find((activity) => activity.id === id);
  if (!existing) {
    return [...activities, {
      id,
      kind: "tool",
      runId,
      toolId: tool.id,
      name: tool.name?.trim() || "Tool",
      phase: tool.phase,
      input: tool.input,
      output: tool.output,
      isError: tool.isError,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  return activities.map((activity) => activity.id === id && activity.kind === "tool"
    ? {
        ...activity,
        name: tool.name?.trim() || activity.name,
        phase: tool.phase,
        input: tool.input ?? activity.input,
        output: tool.output ?? activity.output,
        isError: tool.isError ?? activity.isError,
        status,
        updatedAt: timestamp,
      }
    : activity);
}

function upsertStatusActivity(
  activities: ThreadActivity[],
  runId: string,
  text: string,
  mcpServers: RuntimeMcpServerStatus[] | undefined,
  timestamp: string,
): ThreadActivity[] {
  const id = `status-${runId}-${text}`;
  const existing = activities.find((activity) => activity.id === id);
  if (!existing) {
    return [...activities, {
      id,
      kind: "status",
      runId,
      text,
      status: "running",
      mcpServers,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  return activities.map((activity) => activity.id === id && activity.kind === "status"
    ? { ...activity, mcpServers, updatedAt: timestamp }
    : activity);
}

function finalizeActivities(
  activities: ThreadActivity[],
  status: Extract<ThreadActivityStatus, "complete" | "error"> | boolean,
): ThreadActivity[] {
  const finalStatus = typeof status === "boolean" ? status ? "error" : "complete" : status;
  const timestamp = new Date().toISOString();
  return activities.map((activity) => activity.status === "running"
    ? { ...activity, status: finalStatus, updatedAt: timestamp }
    : activity);
}

async function resolveResumeSessionId(services: ServiceContainer, input: RunUserTurnInput): Promise<string | undefined> {
  if (input.source === "webui") return services.sessions.resolveResumeSessionId(input.sessionId ?? null);
  if (!input.sessionId) return undefined;
  return services.sessions.resolveResumeSessionId(input.sessionId);
}

function draftSessionSummary(sessionId: string, firstMessage: string): SessionSummaryWire {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    title: firstMessage.slice(0, 60) || "New chat",
    preview: firstMessage,
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    status: "persisted",
  };
}

async function forwardNative(
  send: (event: ConversationEvent) => void | Promise<void>,
  ev: NormalizedEvent,
  runId: string,
  fallbackSessionId: string,
): Promise<void> {
  const sessionId = ev.sessionId || fallbackSessionId;
  switch (ev.type) {
    case "text_delta":
      await send({ type: "run.delta", sessionId, runId, text: ev.text });
      break;
    case "thinking_delta":
      await send({ type: "run.thinking", sessionId, runId, text: ev.thinking });
      break;
    case "tool_start":
      await send({ type: "run.tool", sessionId, runId, tool: { phase: "start", id: ev.id, name: ev.name, input: ev.input } });
      break;
    case "tool_result":
      await send({ type: "run.tool", sessionId, runId, tool: { phase: ev.isError ? "error" : "end", id: ev.id, output: ev.output, isError: ev.isError } });
      break;
    case "error":
      await send({ type: "run.error", sessionId, runId, message: ev.message });
      break;
    case "status":
      await send({
        type: "run.status",
        sessionId,
        runId,
        status: ev.status,
        mcpServers: ev.mcpServers,
        message: ev.message,
        retryAttempt: ev.retryAttempt,
        maxRetries: ev.maxRetries,
        retryInMs: ev.retryInMs,
      });
      break;
    case "turn_done":
      break;
  }
}
