// Wire protocol types for HTTP and WebSocket envelopes.

export type AgentWireEvent =
  | { type: "text_delta"; text: string; sessionId?: string }
  | { type: "thinking_delta"; thinking: string; sessionId?: string }
  | { type: "tool_start"; id: string; name: string; input: unknown; sessionId?: string }
  | { type: "tool_result"; id: string; output: unknown; isError: boolean; sessionId?: string }
  | { type: "status"; status: string; sessionId?: string }
  | { type: "turn_done"; sessionId: string; isError: boolean; result: string; totalCostUsd?: number }
  | { type: "error"; message: string; sessionId?: string };

// WebSocket: client -> server
export type WsClientMessage =
  | { type: "session.activate"; sessionId: string }
  | { type: "chat.send"; sessionId?: string; draftId?: string; content: string }
  | { type: "chat.user_message"; content: string }
  | { type: "chat.cancel" };

export type SessionSummaryWire = {
  id: string;
  title: string;
  preview: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  status: "persisted";
};

// WebSocket: server -> client
export type WsServerMessage =
  | { type: "session.activated"; sessionId: string | null }
  | { type: "session.created"; draftId?: string; session: SessionSummaryWire }
  | { type: "run.started"; sessionId: string; runId: string }
  | { type: "run.delta"; sessionId: string; runId: string; text: string }
  | { type: "run.thinking"; sessionId: string; runId: string; text: string }
  | { type: "run.tool"; sessionId: string; runId: string; tool: { phase: "start" | "end" | "error"; id: string; name?: string; input?: unknown; output?: unknown; isError?: boolean } }
  | { type: "run.completed"; sessionId: string; runId: string; isError: boolean; result?: string; totalCostUsd?: number }
  | { type: "run.error"; sessionId?: string; runId?: string; message: string }
  | { type: "message.appended"; sessionId: string; message: { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; metadata: Record<string, unknown> } }
  | { type: "schedule.delivered"; scheduleId: string; status: "succeeded" | "failed"; sessionId: string }
  | { type: "schedule.failed"; scheduleId: string; message: string };
