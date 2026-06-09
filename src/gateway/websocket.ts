// WebSocket handler: client envelopes, server envelopes, run Claude turn on chat.user_message.

import type { ServerWebSocket } from "bun";
import type { ServiceContainer } from "../runtime/services.ts";
import type { WsClientMessage, WsServerMessage } from "./protocol.ts";
import type { NormalizedEvent } from "../agent/events.ts";

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
        send(ws, { type: "agent.error", message: "invalid JSON" });
        return;
      }
      handleClientMessage(ws, msg, services).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[ws] handleClientMessage failed:", detail);
        try { send(ws, { type: "agent.error", message: `internal: ${detail}` }); } catch { /* ignore */ }
      });
    },
    close(ws: ServerWebSocket<WsData>) {
      connections.delete(ws);
    },
    connections,
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
      await services.runtimeState.setLastActiveSession(msg.sessionId, "user_switch");
      ws.data.sessionId = msg.sessionId;
      send(ws, { type: "session.updated", sessionId: msg.sessionId });
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
): Promise<void> {
  const send = (m: WsServerMessage) => sendTo(ws, m);

  // Resolve session: either caller-supplied, last active, or null (let SDK create)
  let sdkSessionId: string | undefined;
  if (sessionId) {
    sdkSessionId = sessionId;
  } else {
    const state = await services.runtimeState.get();
    sdkSessionId = state.lastActiveSessionId || undefined;
  }

  // We need a session id before we can persist anything. If we don't have one
  // yet, run the query and capture the new id from system/init or the result.
  const runner = services.makeRunner("user_turn", sdkSessionId ?? "pending");
  let lastSessionId: string | undefined = sdkSessionId;
  let collected = "";
  let turnErrored = false;
  let finalResult = "";

  try {
    for await (const ev of runner.run({ prompt: content, resumeSessionId: sdkSessionId })) {
      // Surface mirror_error so WebUI status reflects SDK health
      if (ev.type === "error" && ev.message.includes("mirror_error")) {
        send({ type: "agent.status", status: "mirror_error", sessionId: ev.sessionId });
        continue;
      }
      forward(send, ev);
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
  // beat to flush before we ack the WebUI (50ms is plenty for small batches).
  await new Promise((r) => setTimeout(r, 50));

  const finalText = collected || finalResult || (turnErrored ? "(no response)" : "(no response)");
  const activeSdkId = lastSessionId ?? sdkSessionId ?? "pending";
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

function sendTo(ws: ServerWebSocket<WsData>, msg: WsServerMessage) {
  try { ws.send(JSON.stringify(msg)); } catch { /* closed */ }
}

function forward(send: (m: WsServerMessage) => void, ev: NormalizedEvent): void {
  switch (ev.type) {
    case "text_delta": send({ type: "agent.text_delta", text: ev.text, sessionId: ev.sessionId }); break;
    case "thinking_delta": send({ type: "agent.thinking_delta", thinking: ev.thinking, sessionId: ev.sessionId }); break;
    case "tool_start": send({ type: "agent.tool_start", id: ev.id, name: ev.name, input: ev.input, sessionId: ev.sessionId }); break;
    case "tool_result": send({ type: "agent.tool_result", id: ev.id, output: ev.output, isError: ev.isError, sessionId: ev.sessionId }); break;
    case "status": send({ type: "agent.status", status: ev.status, sessionId: ev.sessionId }); break;
    case "turn_done": send({ type: "agent.turn_done", sessionId: ev.sessionId, isError: ev.isError, result: ev.result, totalCostUsd: ev.totalCostUsd }); break;
    case "error": send({ type: "agent.error", message: ev.message, sessionId: ev.sessionId }); break;
  }
}
