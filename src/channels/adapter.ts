import type { ChannelId, ChannelInboundMessage, ChannelOutboundMessage } from "./types.ts";

export type ChannelStatus = {
  name: ChannelId;
  displayName: string;
  enabled: boolean;
  running: boolean;
};

export type ChannelAdapter = {
  name: ChannelId;
  displayName: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  send: (msg: ChannelOutboundMessage) => Promise<void>;
  handleHttp?: (req: Request, url: URL) => Promise<Response | null>;
  login?: (options?: { force?: boolean }) => Promise<boolean>;
  status?: () => Promise<ChannelStatus>;
  sendDelta?: (chatId: string, delta: string, metadata?: Record<string, unknown>) => Promise<void>;
  sendReasoningDelta?: (chatId: string, delta: string, metadata?: Record<string, unknown>) => Promise<void>;
  sendReasoningEnd?: (chatId: string, metadata?: Record<string, unknown>) => Promise<void>;
};

export type ChannelInboundHandler = (message: ChannelInboundMessage) => Promise<void>;
