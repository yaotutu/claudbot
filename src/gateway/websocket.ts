// WebSocket handler: client envelopes, server envelopes, run Claude turns.

import type { ServerWebSocket } from "bun";
import type { ServiceContainer } from "../runtime/services.ts";
import type { SessionSummaryWire, WsClientMessage, WsServerMessage } from "./protocol.ts";
import type { NormalizedEvent } from "../agent/events.ts";

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
      const activeId = await services.sessions.activate(msg.sessionId || null);
      ws.data.sessionId = activeId || "";
      send(ws, { type: "session.activated", sessionId: activeId });
      return;
    }
    case "chat.send": {
      const explicitId = msg.sessionId || ws.data.sessionId || null;
      await runUserTurn(ws, services, explicitId, msg.content, { draftId: msg.draftId });
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

  const sdkSessionId = await services.sessions.resolveResumeSessionId(sessionId);

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

  // Settle delay: sessionStoreFlush defaults to 'batched'. Give the mirror a
  // beat to flush before WebUI reads the JSONL-backed session model.
  await new Promise((r) => setTimeout(r, MIRROR_FLUSH_SETTLE_MS));

  // First message in a new session — set the title from the user's message
  // so the sidebar shows a meaningful name immediately and it persists across
  // page refreshes.
  if (!sdkSessionId && lastSessionId) {
    try {
      await services.sessions.rename(lastSessionId, content.slice(0, 60));
    } catch { /* non-critical */ }
  }

  if (!sdkSessionId && !sessionCreated && lastSessionId) {
    send({
      type: "session.created",
      draftId: options.draftId,
      session: draftSessionSummary(lastSessionId, content),
    });
  }

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
