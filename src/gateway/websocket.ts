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
      ws.data = { sessionId: "inbox", services, send: (m) => ws.send(JSON.stringify(m)) };
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
      let sessionId = state.lastActiveSessionId || "inbox";
      if (ws.data.sessionId && ws.data.sessionId !== "inbox") sessionId = ws.data.sessionId;
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
  sessionId: string,
  content: string,
): Promise<void> {
  const session = await services.sessions.getOrCreateInbox().then(async (inbox) => {
    if (sessionId === "inbox") return inbox;
    return (await services.sessions.get(sessionId)) || inbox;
  });
  sessionId = session.id;
  await services.runtimeState.setLastActiveSession(sessionId, "user_message");
  ws.data.sessionId = sessionId;
  const send = (m: WsServerMessage) => sendTo(ws, m);

  const userMsg = await services.sessions.appendMessage(sessionId, { role: "user", content, metadata: {} });
  send({ type: "message.appended", sessionId, message: userMsg.messages[userMsg.messages.length - 1] });
  send({ type: "session.updated", sessionId });

  const runner = services.makeRunner("user_turn", sessionId);
  const resumeId = session.claudeSessionId || undefined;
  const collected: string[] = [];
  let turnErrored = false;
  let finalResult = "";
  let lastSessionId: string | undefined;
  try {
    for await (const ev of runner.run({ prompt: content, resumeSessionId: resumeId })) {
      forward(send, ev);
      if (ev.type === "text_delta") collected.push(ev.text);
      if (ev.type === "turn_done") {
        finalResult = ev.result;
        lastSessionId = ev.sessionId || lastSessionId;
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
    session.claudeSessionId = lastSessionId;
    // Persist so the next turn can resume the SDK session and the model
    // can carry context (and avoid re-reading tool definitions etc).
    await services.sessions.save(session);
  }
  const finalText = collected.join("") || finalResult || (turnErrored ? "(no response)" : "(no response)");
  const assistantMsg = await services.sessions.appendMessage(sessionId, {
    role: "assistant",
    content: finalText,
    metadata: turnErrored ? { error: true } : {},
  });
  send({ type: "message.appended", sessionId, message: assistantMsg.messages[assistantMsg.messages.length - 1] });
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
