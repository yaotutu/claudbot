// WebSocket handler: client envelopes, server envelopes, run Claude turns.

import type { ServerWebSocket } from "bun";
import type { ServiceContainer } from "../runtime/services.ts";
import type { WsClientMessage, WsServerMessage } from "./protocol.ts";
import { runUserTurn } from "../conversation/run-user-turn.ts";

export { maybeRunExplicitMemoryDreamAfterTurn } from "../conversation/run-user-turn.ts";

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
      const result = await runUserTurn(
        services,
        { source: "webui", sessionId: explicitId, content: msg.content, draftId: msg.draftId },
        { send: (event) => send(ws, event) },
      );
      if (result.sessionId) ws.data.sessionId = result.sessionId;
      return;
    }
    case "chat.cancel": {
      await cancelUserTurn(services, msg.sessionId);
      return;
    }
  }
}

export async function cancelUserTurn(services: ServiceContainer, sessionId: string): Promise<void> {
  await services.agentRuntimeManager.cancel(sessionId);
}
