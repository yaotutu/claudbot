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
  | { type: "chat.user_message"; content: string }
  | { type: "chat.cancel" };

// WebSocket: server -> client
export type WsServerMessage =
  | { type: "session.updated"; sessionId: string }
  | { type: "message.appended"; sessionId: string; message: { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; metadata: Record<string, unknown> } }
  | { type: "agent.text_delta"; text: string; sessionId?: string }
  | { type: "agent.thinking_delta"; thinking: string; sessionId?: string }
  | { type: "agent.tool_start"; id: string; name: string; input: unknown; sessionId?: string }
  | { type: "agent.tool_result"; id: string; output: unknown; isError: boolean; sessionId?: string }
  | { type: "agent.status"; status: string; sessionId?: string }
  | { type: "agent.turn_done"; sessionId: string; isError: boolean; result: string; totalCostUsd?: number }
  | { type: "agent.error"; message: string; sessionId?: string }
  | { type: "schedule.delivered"; scheduleId: string; status: "succeeded" | "failed" };
