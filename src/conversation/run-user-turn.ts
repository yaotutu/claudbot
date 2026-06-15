import type { ServiceContainer } from "../runtime/services.ts";
import type { NormalizedEvent } from "../agent/events.ts";
import type { SessionSummary as SessionSummaryWire } from "../shared/webui-protocol.ts";
import type { ConversationEvent, ConversationSink, RunUserTurnInput, RunUserTurnResult } from "./types.ts";

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
  const runner = services.makeRunner(input.source === "schedule" ? "schedule_turn" : "user_turn", sdkSessionId ?? "pending");
  let lastSessionId: string | undefined = sdkSessionId;
  let collected = "";
  let turnErrored = false;
  let finalResult = "";
  let sessionCreated = false;

  try {
    for await (const ev of runner.run({ prompt: input.content, resumeSessionId: sdkSessionId })) {
      if (ev.type === "error" && ev.message.includes("mirror_error")) {
        await sink.send({ type: "run.error", sessionId: ev.sessionId, runId, message: ev.message });
        continue;
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
    }
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
  await sink.send({ type: "run.completed", sessionId: activeSdkId, runId, isError: turnErrored, result: finalResult });
  await sink.send({
    type: "message.appended",
    sessionId: activeSdkId,
    message: {
      id: `local-${Date.now()}`,
      role: turnErrored ? "system" : "assistant",
      content: finalText,
      createdAt: new Date().toISOString(),
      metadata: turnErrored ? { error: true } : {},
    },
  });

  return { sessionId: lastSessionId ?? sdkSessionId ?? null, runId, result: finalResult, isError: turnErrored };
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
    case "turn_done":
      break;
  }
}
