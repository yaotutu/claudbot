// WebSocket handler: client envelopes, server envelopes, run Claude turn on chat.user_message.

import type { ServerWebSocket } from "bun";
import type { ServiceContainer } from "../runtime/services.ts";
import type { SessionSummaryWire, WsClientMessage, WsServerMessage } from "./protocol.ts";
import type { NormalizedEvent } from "../agent/events.ts";
import { sessionExists } from "../sessions/adapter.ts";

// SDK sessionStoreFlush defaults to 'batched'. After turn_done we wait this
// long so the adapter mirror has a chance to flush before we ack the WebUI.
// If SDK adds a flush() signal in the future, replace this with that.
const MIRROR_FLUSH_SETTLE_MS = 50;

export type WsData = {
  sessionId: string;
  services: ServiceContainer;
  send: (msg: WsServerMessage) => void;
};

export function makeWsHandlers(services: ServiceContainer) {
  const connections = new Set<ServerWebSocket<WsData>>();

  return {
    open(ws: ServerWebSocket<WsData>) {
      ws.data = { sessionId: "", services, send: (m) => ws.send(JSON.stringify(m)) };
      connections.add(ws);
    },
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(text) as WsClientMessage;
      } catch {
        send(ws, { type: "run.error", message: "invalid JSON" });
        return;
      }
      handleClientMessage(ws, msg, services).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[ws] handleClientMessage failed:", detail);
        try { send(ws, { type: "run.error", message: `internal: ${detail}` }); } catch { /* ignore */ }
      });
    },
    close(ws: ServerWebSocket<WsData>) {
      connections.delete(ws);
    },
    connections,
    /** Broadcast a message to all connected WebSocket clients. */
    broadcast(msg: WsServerMessage) {
      const raw = JSON.stringify(msg);
      for (const c of connections) {
        try { c.send(raw); } catch { /* socket may be closed */ }
      }
    },
  };
}

function send(ws: ServerWebSocket<WsData>, msg: WsServerMessage) {
  try { ws.send(JSON.stringify(msg)); } catch { /* socket may be closed */ }
}

async function handleClientMessage(
  ws: ServerWebSocket<WsData>,
  msg: WsClientMessage,
  services: ServiceContainer,
): Promise<void> {
  switch (msg.type) {
    case "session.activate": {
      // If the client activates a session that doesn't exist on disk (e.g. a
      // freshly generated UUID from newChat), clear lastActiveSessionId so the
      // next user message creates a fresh SDK session instead of trying to resume.
      const exists = msg.sessionId
        ? await sessionExists(services.paths.sessionsDir, msg.sessionId)
        : false;
      const effectiveId = exists ? msg.sessionId : "";
      await services.runtimeState.setLastActiveSession(effectiveId, "user_switch");
      ws.data.sessionId = effectiveId;
      send(ws, { type: "session.activated", sessionId: effectiveId || null });
      return;
    }
    case "chat.send": {
      const explicitId = msg.sessionId || ws.data.sessionId || null;
      const state = explicitId ? null : await services.runtimeState.get();
      const sessionId = explicitId || state?.lastActiveSessionId || null;
      await runUserTurn(ws, services, sessionId, msg.content, { draftId: msg.draftId });
      return;
    }
    case "chat.user_message": {
      const state = await services.runtimeState.get();
      const sessionId = ws.data.sessionId && ws.data.sessionId !== "pending"
        ? ws.data.sessionId
        : (state.lastActiveSessionId || null);
      await runUserTurn(ws, services, sessionId, msg.content);
      return;
    }
    case "chat.cancel": {
      // MVP: cancellation handled at the runner level; not implemented in MVP.
      return;
    }
  }
}

export async function runUserTurn(
  ws: ServerWebSocket<WsData>,
  services: ServiceContainer,
  sessionId: string | null,
  content: string,
  options: { draftId?: string } = {},
): Promise<void> {
  const send = (m: WsServerMessage) => sendTo(ws, m);
  const runId = crypto.randomUUID();
  const initialRouteId = sessionId ?? options.draftId ?? "pending";
  send({ type: "run.started", sessionId: initialRouteId, runId });

  // Resolve session: either caller-supplied, last active, or null (let SDK create).
  // Validate that the session actually exists on disk — the adapter only has
  // entries for sessions the SDK created and the adapter mirrored. Stale IDs
  // from old-format sess_*.json files or phantom UUIDs must NOT be passed as
  // `resume` or the SDK will error ("No conversation found").
  let sdkSessionId: string | undefined;
  if (sessionId) {
    const exists = await sessionExists(services.paths.sessionsDir, sessionId);
    if (exists) {
      sdkSessionId = sessionId;
    } else {
      // Stale — clear the runtime state so future requests don't retry
      await services.runtimeState.setLastActiveSession("", "stale_reset");
      sdkSessionId = undefined;
    }
  } else {
    const state = await services.runtimeState.get();
    if (state.lastActiveSessionId) {
      const exists = await sessionExists(services.paths.sessionsDir, state.lastActiveSessionId);
      if (exists) {
        sdkSessionId = state.lastActiveSessionId;
      } else {
        await services.runtimeState.setLastActiveSession("", "stale_reset");
        sdkSessionId = undefined;
      }
    }
  }

  // We need a session id before we can persist anything. If we don't have one
  // yet, run the query and capture the new id from system/init or the result.
  const runner = services.makeRunner("user_turn", sdkSessionId ?? "pending");
  let lastSessionId: string | undefined = sdkSessionId;
  let collected = "";
  let turnErrored = false;
  let finalResult = "";
  let sessionCreated = false;

  try {
    for await (const ev of runner.run({ prompt: content, resumeSessionId: sdkSessionId })) {
      // Surface mirror_error so WebUI status reflects SDK health
      if (ev.type === "error" && ev.message.includes("mirror_error")) {
        send({ type: "run.error", sessionId: ev.sessionId, runId, message: ev.message });
        continue;
      }
      if (ev.sessionId && ev.sessionId !== lastSessionId) {
        lastSessionId = ev.sessionId;
      }
      if (!sdkSessionId && !sessionCreated && lastSessionId && lastSessionId !== "pending") {
        sessionCreated = true;
        send({
          type: "session.created",
          draftId: options.draftId,
          session: draftSessionSummary(lastSessionId, content),
        });
      }
      forwardNative(send, ev, runId, lastSessionId ?? initialRouteId);
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

  if (lastSessionId) {
    await services.runtimeState.setLastActiveSession(lastSessionId, "user_message");
    ws.data.sessionId = lastSessionId;
  }

  // First message in a new session — set the title from the user's message
  // so the sidebar shows a meaningful name immediately and it persists across
  // page refreshes.
  if (!sdkSessionId && lastSessionId) {
    try {
      await services.sdkSessions.rename(lastSessionId, content.slice(0, 60));
    } catch { /* non-critical */ }
  }

  if (!sdkSessionId && !sessionCreated && lastSessionId) {
    send({
      type: "session.created",
      draftId: options.draftId,
      session: draftSessionSummary(lastSessionId, content),
    });
  }

  // Settle delay: sessionStoreFlush defaults to 'batched'. Give the mirror a
  // beat to flush before we ack the WebUI.
  await new Promise((r) => setTimeout(r, MIRROR_FLUSH_SETTLE_MS));

  const finalText = collected || finalResult || (turnErrored ? "(no response)" : "(no response)");
  const activeSdkId = lastSessionId ?? sdkSessionId ?? "pending";
  send({ type: "run.completed", sessionId: activeSdkId, runId, isError: turnErrored, result: finalResult });
  send({
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

function sendTo(ws: ServerWebSocket<WsData>, msg: WsServerMessage) {
  try { ws.send(JSON.stringify(msg)); } catch { /* closed */ }
}

function forwardNative(send: (m: WsServerMessage) => void, ev: NormalizedEvent, runId: string, fallbackSessionId: string): void {
  const sessionId = ev.sessionId || fallbackSessionId;
  switch (ev.type) {
    case "text_delta":
      send({ type: "run.delta", sessionId, runId, text: ev.text });
      break;
    case "thinking_delta":
      send({ type: "run.thinking", sessionId, runId, text: ev.thinking });
      break;
    case "tool_start":
      send({ type: "run.tool", sessionId, runId, tool: { phase: "start", id: ev.id, name: ev.name, input: ev.input } });
      break;
    case "tool_result":
      send({ type: "run.tool", sessionId, runId, tool: { phase: ev.isError ? "error" : "end", id: ev.id, output: ev.output, isError: ev.isError } });
      break;
    case "error":
      send({ type: "run.error", sessionId, runId, message: ev.message });
      break;
    case "status":
    case "turn_done":
      break;
  }
}
