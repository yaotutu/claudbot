// Wire protocol types for HTTP and WebSocket envelopes.

export { WEBUI_PROTOCOL_VERSION } from "../shared/webui-protocol.ts";
export type {
  ClientFrame as WsClientMessage,
  ServerFrame as WsServerMessage,
  SessionSummary as SessionSummaryWire,
} from "../shared/webui-protocol.ts";

export type AgentWireEvent =
  | { type: "text_delta"; text: string; sessionId?: string }
  | { type: "thinking_delta"; thinking: string; sessionId?: string }
  | { type: "tool_start"; id: string; name: string; input: unknown; sessionId?: string }
  | { type: "tool_result"; id: string; output: unknown; isError: boolean; sessionId?: string }
  | { type: "status"; status: string; sessionId?: string }
  | { type: "turn_done"; sessionId: string; isError: boolean; result: string; totalCostUsd?: number }
  | { type: "error"; message: string; sessionId?: string };
