// Normalized events emitted by ClaudeRunner for the gateway to broadcast.

export type NormalizedEvent =
  | { type: "text_delta"; text: string; sessionId?: string }
  | { type: "thinking_delta"; thinking: string; sessionId?: string }
  | { type: "tool_start"; id: string; name: string; input: unknown; sessionId?: string }
  | { type: "tool_result"; id: string; output: unknown; isError: boolean; sessionId?: string }
  | {
      type: "status";
      status: string;
      sessionId?: string;
      mcpServers?: McpServerStatus[];
      message?: string;
      retryAttempt?: number;
      maxRetries?: number;
      retryInMs?: number;
    }
  | { type: "turn_done"; sessionId: string; isError: boolean; result: string; totalCostUsd?: number }
  | { type: "error"; message: string; sessionId?: string };

export type McpServerStatus = { name: string; status: string; [key: string]: unknown };

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type UserContent =
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };

export type SdkMessage = {
  type: string;
  subtype?: string;
  message?: { id?: string; role?: string; model?: string; content?: (AssistantContent | UserContent)[] };
  content?: (AssistantContent | UserContent)[];
  tool_use_id?: string;
  tool_use_result?: unknown;
  is_error?: boolean;
  session_id?: string;
  mcp_servers?: McpServerStatus[];
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  error?: string | { formatted?: string; message?: string; status?: number; [key: string]: unknown };
  retryAttempt?: number;
  maxRetries?: number;
  retryInMs?: number;
};
