import type { ServerFrame } from "../shared/webui-protocol.ts";
import type { ChannelId } from "../channels/types.ts";

export type ConversationSource = "webui" | "schedule" | ChannelId;

export type RunUserTurnInput = {
  source: ConversationSource;
  sessionId?: string | null;
  draftId?: string;
  content: string;
};

export type ConversationEvent = Extract<ServerFrame,
  | { type: "session.created" }
  | { type: "message.appended" }
  | { type: "run.started" }
  | { type: "run.delta" }
  | { type: "run.thinking" }
  | { type: "run.tool" }
  | { type: "run.status" }
  | { type: "run.completed" }
  | { type: "run.error" }
>;

export type ConversationSink = {
  send: (event: ConversationEvent) => void | Promise<void>;
};

export type RunUserTurnResult = {
  sessionId: string | null;
  runId: string;
  result: string;
  isError: boolean;
};
